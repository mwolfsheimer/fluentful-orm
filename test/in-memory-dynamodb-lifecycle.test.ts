import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {
    CreateTableCommand,
    PutItemCommand,
    QueryCommand,
    ResourceNotFoundException,
    UpdateTimeToLiveCommand
} from '@aws-sdk/client-dynamodb';
import {QuerySerializer} from '../src/query-serializer';
import {createInMemoryDynamoDB, QueryBuilder} from '../src/index';

function fixture(context: TestContext) {
    const backend = createInMemoryDynamoDB([{
        TableName: 'records',
        KeySchema: [{AttributeName: 'id', KeyType: 'HASH'}],
        AttributeDefinitions: [{AttributeName: 'id', AttributeType: 'S'}]
    }]);
    context.after(() => backend.close());
    return {backend, query: () => new QueryBuilder('records', backend.db)};
}

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
    const backend = createInMemoryDynamoDB();
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
