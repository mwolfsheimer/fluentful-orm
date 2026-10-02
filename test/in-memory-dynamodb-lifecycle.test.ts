import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {
    CreateTableCommand,
    BatchWriteItemCommand,
    BatchGetItemCommand,
    TransactWriteItemsCommand,
    PutItemCommand,
    QueryCommand,
    ResourceNotFoundException,
    ScanCommand,
    UpdateTimeToLiveCommand
} from '@aws-sdk/client-dynamodb';
import {UpdateItemCommand} from '@aws-sdk/client-dynamodb';
import {QuerySerializer} from '../src/query-serializer';
import {createEngine, QueryBuilder} from '../src/index';

function fixture(context: TestContext) {
    const backend = createEngine.memory([{
        TableName: 'records',
        KeySchema: [{AttributeName: 'id', KeyType: 'HASH'}],
        AttributeDefinitions: [{AttributeName: 'id', AttributeType: 'S'}]
    }]);
    context.after(() => backend.close());
    return {backend, query: () => new QueryBuilder('records', backend.db)};
}

test('rejects malformed SET branches and nested arithmetic atomically', async context => {
    const {backend, query} = fixture(context);
    await query().create({id: 'one', count: 1}).toPromise();
    for (const UpdateExpression of ['SET #count = :one + :one + :one',
        'SET #count = if_not_exists(#count, unsupported(:one))', 'SET #count = if_not_exists(#count, :missing)']) {
        await assert.rejects(backend.db.send(new UpdateItemCommand({TableName: 'records', Key: {id: {S: 'one'}},
            UpdateExpression, ExpressionAttributeNames: {'#count': 'count'}, ExpressionAttributeValues: {':one': {N: '1'}}})), {name: 'ValidationException'});
    }
    assert.deepEqual(await query().get({id: 'one'}).toPromise(), {id: 'one', count: 1});
});

test('rejects aborted queued writes without applying them', async context => {
    const {backend, query} = fixture(context);
    const controller = new AbortController();
    const reason = new Error('cancel queued write');
    const accepted = query().create({id: 'accepted'}).toPromise();
    const queued = backend.db.send(new PutItemCommand({TableName: 'records', Item: {id: {S: 'cancelled'}}}),
        {abortSignal: controller.signal});
    controller.abort(reason);
    await assert.rejects(queued, error => error === reason);
    await accepted;
    assert.equal(await query().get({id: 'cancelled'}).toPromise(), null);
    assert.deepEqual(await query().get({id: 'accepted'}).toPromise(), {id: 'accepted'});
});

test('keeps index lifecycle changes atomic and rejects service-only simulation', async context => {
    const {backend, query} = fixture(context);
    await query().create({id: 'one', category: 1}).toPromise();
    await assert.rejects(QueryBuilder.updateTable('records', backend.db, {createIndex: {name: 'category',
        definition: {kind: 'global', partition: 'category'}, attributes: {category: 'S'}}}), {name: 'ValidationException'});
    assert.deepEqual((await QueryBuilder.getTableDefinition('records', backend.db))?.indexes, {});
    assert.deepEqual(await query().get({id: 'one'}).toPromise(), {id: 'one', category: 1});
    await assert.rejects(QueryBuilder.configureTimeToLive('records', 'expiresAt', true, backend.db), /Unsupported/);
    await assert.rejects(QueryBuilder.createTable('capacity', 'id', backend.db,
        {billingMode: 'PROVISIONED', throughput: {read: 1, write: 1}}), /not simulated/);
    await assert.rejects(QueryBuilder.updateTable('records', backend.db,
        {billingMode: 'PROVISIONED', throughput: {read: 1, write: 1}}), /not simulated/);
    assert.deepEqual(await QueryBuilder.listTablePage(backend.db, {limit: 1}), {names: ['records'], cursor: null});
    await QueryBuilder.waitForTable('records', backend.db);
    await QueryBuilder.waitForTableDeleted('missing', backend.db);
});

test('expires transaction tokens exactly at ten minutes and does not cache failures', async context => {
    const {backend, query} = fixture(context);
    let now = 1000000;
    context.mock.method(Date, 'now', () => now);
    const transaction = (capacity: 'NONE' | 'TOTAL' = 'NONE') => QueryBuilder.transactWrite(backend.db)
        .clientRequestToken('expiry-token').returnCapacity(capacity)
        .add('records', builder => builder.update({id: 'one'}).add('count').eq(1));
    await transaction().toPromise();
    now += 599999;
    await transaction().toPromise();
    assert.deepEqual(await query().get({id: 'one'}).toPromise(), {id: 'one', count: 1});
    await assert.rejects(transaction('TOTAL').toPromise(), {name: 'IdempotentParameterMismatchException'});
    now++;
    await transaction().toPromise();
    assert.deepEqual(await query().get({id: 'one'}).toPromise(), {id: 'one', count: 2});
    const failed = () => QueryBuilder.transactWrite(backend.db).clientRequestToken('failed-token')
        .add('records', builder => builder.conditionCheck({id: 'later'}).where('id').exists());
    await assert.rejects(failed().toPromise(), {name: 'TransactionCanceledException'});
    await query().create({id: 'later'}).toPromise();
    await failed().toPromise();
});

test('returns SDK-shaped metadata and honors suppression for every operation family', async context => {
    const backend = createEngine.memory([{name: 'metadata-records', key: {partition: 'id', sort: 'sort'},
        attributes: {id: 'S', sort: 'N', alternate: 'N'}, indexes: {local: {kind: 'local', partition: 'id', sort: 'alternate'}}}]);
    context.after(() => backend.close());
    const item = QuerySerializer.serialiseMap({id: 'one', sort: 1, alternate: 2});
    for (const mode of ['NONE', 'TOTAL', 'INDEXES'] as const) {
        const single = await backend.db.send(new PutItemCommand({TableName: 'metadata-records', Item: item,
            ReturnConsumedCapacity: mode, ReturnItemCollectionMetrics: 'SIZE'}));
        assert.equal(single.ConsumedCapacity !== undefined, mode !== 'NONE');
        assert.equal(Array.isArray(single.ItemCollectionMetrics), false);
        assert.ok(single.ItemCollectionMetrics?.ItemCollectionKey);
        const batch = await backend.db.send(new BatchWriteItemCommand({RequestItems: {'metadata-records': [{PutRequest: {Item: item}}]},
            ReturnConsumedCapacity: mode, ReturnItemCollectionMetrics: 'SIZE'}));
        assert.equal(Array.isArray(batch.ConsumedCapacity), mode !== 'NONE');
        assert.equal(batch.ItemCollectionMetrics?.['metadata-records']?.length, 1);
        const read = await backend.db.send(new BatchGetItemCommand({RequestItems: {'metadata-records': {Keys: [QuerySerializer.serialiseMap({id: 'one', sort: 1})]}}, ReturnConsumedCapacity: mode}));
        assert.equal(Array.isArray(read.ConsumedCapacity), mode !== 'NONE');
        const transaction = await backend.db.send(new TransactWriteItemsCommand({TransactItems: [{Put: {TableName: 'metadata-records', Item: item}}],
            ReturnConsumedCapacity: mode, ReturnItemCollectionMetrics: 'SIZE'}));
        assert.equal(Array.isArray(transaction.ConsumedCapacity), mode !== 'NONE');
        assert.equal(transaction.ItemCollectionMetrics?.['metadata-records']?.length, 1);
    }
    const response = await new QueryBuilder('metadata-records', backend.db).create({id: 'one', sort: 1, alternate: 2})
        .returnItemCollectionMetrics().toResponse();
    assert.equal(response.itemCollectionMetrics.length, 1);
});

test('validates raw query predicates and operands even when no records match', async (context) => {
    const backend = createEngine.memory([{
        name: 'key-rules', key: {partition: 'id', sort: 'sort'}, attributes: {id: 'S', sort: 'N'}, indexes: {}
    }]);
    context.after(() => backend.close());
    const names = {'#id': 'id', '#same': 'id', '#sort': 'sort', '#other': 'other'};
    const valid = {':id': {S: 'p'}, ':a': {N: '1'}, ':b': {N: '2'}};
    for (const populated of [false, true]) {
        if (populated) await new QueryBuilder('key-rules', backend.db).create({id: 'p', sort: 1}).toPromise();
        for (const expression of [
            '#id > :id', '#sort = :a', '#id = :id AND #same = :id',
            '#id = :id AND #sort > :a AND #sort < :b', '#id = :id AND #other = :a',
            '#id = :id AND begins_with(#sort, :a)', '#id = :id AND #sort BETWEEN :b AND :a'
        ]) {
            await assert.rejects(backend.db.send(new QueryCommand({
                TableName: 'key-rules', KeyConditionExpression: expression,
                ExpressionAttributeNames: names, ExpressionAttributeValues: valid
            })), (error: any) => error.name === 'ValidationException');
        }
        for (const operand of [{S: ''}, {N: '1'}, {NULL: true}, {B: new Uint8Array()}, {S: 'x'.repeat(2049)}]) {
            await assert.rejects(backend.db.send(new QueryCommand({
                TableName: 'key-rules', KeyConditionExpression: '#id = :id',
                ExpressionAttributeNames: {'#id': 'id'}, ExpressionAttributeValues: {':id': operand}
            })), (error: any) => error.name === 'ValidationException');
        }
        await assert.rejects(backend.db.send(new QueryCommand({
            TableName: 'key-rules', KeyConditionExpression: '#id = :id AND #sort = :a',
            ExpressionAttributeNames: names, ExpressionAttributeValues: {...valid, ':a': {S: 'wrong'}}
        })), /Invalid key attribute/);
    }
});

test('validates raw IN cardinality, alias syntax and parallel scan boundaries', async (context) => {
    const {backend} = fixture(context);
    for (const count of [1, 100, 101]) {
        for (const negate of [false, true]) {
            const aliases = Array.from({length: count}, (_, index) => `:v${index}`);
            const expression = `#value IN (${aliases.join(', ')})`;
            const run = () => backend.db.send(new ScanCommand({
                TableName: 'records', FilterExpression: negate ? `NOT (${expression})` : expression,
                ExpressionAttributeNames: {'#value': 'value'},
                ExpressionAttributeValues: Object.fromEntries(aliases.map((alias) => [alias, {N: '1'}]))
            }));
            if (count > 100) await assert.rejects(run(), /at most 100/);
            else await run();
        }
    }
    await assert.rejects(backend.db.send(new ScanCommand({
        TableName: 'records', FilterExpression: '#value IN ()', ExpressionAttributeNames: {'#value': 'value'}
    })), /expression operand/);
    await assert.rejects(backend.db.send(new ScanCommand({
        TableName: 'records', FilterExpression: '#odd.name = :value',
        ExpressionAttributeNames: {'#odd.name': 'odd.name'}, ExpressionAttributeValues: {':value': {N: '1'}}
    })), /expression/);
    await assert.rejects(backend.db.send(new ScanCommand({TableName: 'records', Segment: 0, TotalSegments: 1000001})), /segment/);
    await backend.db.send(new ScanCommand({TableName: 'records', Segment: 999999, TotalSegments: 1000000}));
});

test('isolates instances, resets records and tokens, and closes idempotently', async (context) => {
    const first = fixture(context);
    const second = fixture(context);
    const write = () => QueryBuilder.transactWrite(first.backend.db).clientRequestToken('reset-token')
        .add('records', (query) => query.create({id: 'first'})).toPromise();
    await write();
    assert.equal(await second.query().get({id: 'first'}).toPromise(), null);
    first.backend.reset();
    assert.deepEqual(await QueryBuilder.listTables(first.backend.db), ['records']);
    assert.equal(await first.query().get({id: 'first'}).toPromise(), null);
    await write();
    assert.deepEqual(await first.query().get({id: 'first'}).toPromise(), {id: 'first'});
    await QueryBuilder.deleteTable('records', first.backend.db);
    await assert.rejects(first.query().get({id: 'first'}).toPromise(), ResourceNotFoundException);
    await first.backend.close();
    await first.backend.close();
    await assert.rejects(QueryBuilder.listTables(first.backend.db), /closed/);
    assert.equal(await second.query().get({id: 'first'}).toPromise(), null);
});

test('fails explicitly for unsupported commands and expression syntax even on empty tables', async (context) => {
    const {backend, query} = fixture(context);
    await assert.rejects(backend.db.send(new UpdateTimeToLiveCommand({
        TableName: 'records', TimeToLiveSpecification: {AttributeName: 'ttl', Enabled: true}
    })), /Unsupported in-memory DynamoDB command/);
    const unsupported = () => backend.db.send(new QueryCommand({TableName: 'records', KeyConditionExpression: 'unsupported()'}));
    await assert.rejects(unsupported(), /expression/);
    await query().create({id: 'record'}).toPromise();
    await assert.rejects(unsupported(), /expression/);
});

test('returns only attributes available from global secondary index projections', async (context) => {
    const backend = createEngine.memory();
    context.after(() => backend.close());
    await backend.db.send(new CreateTableCommand({
        TableName: 'projected-records',
        KeySchema: [{AttributeName: 'id', KeyType: 'HASH'}],
        AttributeDefinitions: [
            {AttributeName: 'id', AttributeType: 'S'},
            {AttributeName: 'status', AttributeType: 'S'}
        ],
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [
            {
                IndexName: 'keys',
                KeySchema: [{AttributeName: 'status', KeyType: 'HASH'}],
                Projection: {ProjectionType: 'KEYS_ONLY'}
            },
            {
                IndexName: 'summary',
                KeySchema: [{AttributeName: 'status', KeyType: 'HASH'}],
                Projection: {ProjectionType: 'INCLUDE', NonKeyAttributes: ['summary']}
            }
        ]
    }));
    await backend.db.send(new PutItemCommand({
        TableName: 'projected-records',
        Item: QuerySerializer.serialiseMap({id: 'one', status: 'open', summary: 'Visible', secret: 'Hidden'})
    }));

    const query = (indexName: string) => backend.db.send(new QueryCommand({
        TableName: 'projected-records',
        IndexName: indexName,
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: {'#status': 'status'},
        ExpressionAttributeValues: {':status': {S: 'open'}}
    }));
    const keys = await query('keys');
    const summary = await query('summary');

    assert.deepEqual((keys.Items || []).map((item) => QuerySerializer.parseItem(item)), [{id: 'one', status: 'open'}]);
    assert.deepEqual((summary.Items || []).map((item) => QuerySerializer.parseItem(item)), [{id: 'one', status: 'open', summary: 'Visible'}]);
    await assert.rejects(backend.db.send(new QueryCommand({
        TableName: 'projected-records',
        IndexName: 'summary',
        KeyConditionExpression: '#status = :status',
        ProjectionExpression: '#secret',
        ExpressionAttributeNames: {'#status': 'status', '#secret': 'secret'},
        ExpressionAttributeValues: {':status': {S: 'open'}}
    })), /non-projected attribute/);
});

test('supports fluent response metadata, point projections, and parallel scan segments', async (context) => {
    const backend = createEngine.memory([{
        TableName: 'segmented-records',
        KeySchema: [
            {AttributeName: 'id', KeyType: 'HASH'},
            {AttributeName: 'sort', KeyType: 'RANGE'}
        ],
        AttributeDefinitions: [
            {AttributeName: 'id', AttributeType: 'S'},
            {AttributeName: 'sort', AttributeType: 'N'},
            {AttributeName: 'alternate', AttributeType: 'N'}
        ],
        LocalSecondaryIndexes: [{
            IndexName: 'alternate-index',
            KeySchema: [
                {AttributeName: 'id', KeyType: 'HASH'},
                {AttributeName: 'alternate', KeyType: 'RANGE'}
            ],
            Projection: {ProjectionType: 'ALL'}
        }]
    }]);
    context.after(() => backend.close());
    const query = () => new QueryBuilder('segmented-records', backend.db);

    for (let index = 0; index < 6; index++) {
        await query().create({id: `record-${index}`, sort: index, alternate: index, value: index}).toPromise();
    }

    const projected = await query().get({id: 'record-0', sort: 0}).select('id', 'value').toPromise();
    assert.deepEqual(projected, {id: 'record-0', value: 0});

    const response = await query().update({id: 'record-0', sort: 0})
        .set('value').eq(10)
        .returnCapacity('TOTAL')
        .returnItemCollectionMetrics()
        .toResponse<{id: string; value: number}>();
    assert.equal(response.value?.value, 10);
    assert.deepEqual(response.consumedCapacity, [{TableName: 'segmented-records', CapacityUnits: 1}]);
    assert.equal(response.itemCollectionMetrics.length, 1);

    const first = await query().scan().parallel(0, 2).toPromise<any[]>();
    const second = await query().scan().parallel(1, 2).toPromise<any[]>();
    assert.deepEqual([...first, ...second].map((item) => item.id).sort(), Array.from({length: 6}, (_, index) => `record-${index}`));
    assert.throws(() => query().scan().parallel(2, 2), /segment/);
});
