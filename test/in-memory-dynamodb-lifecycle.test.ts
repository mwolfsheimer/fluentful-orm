import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {
    CreateTableCommand,
    PutItemCommand,
    QueryCommand,
    ResourceNotFoundException,
    ScanCommand,
    UpdateTimeToLiveCommand
} from '@aws-sdk/client-dynamodb';
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
