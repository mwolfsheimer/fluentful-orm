import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {BatchWriteItemCommand, UpdateItemCommand, ConditionalCheckFailedException, DynamoDBServiceException, ResourceNotFoundException, TransactionCanceledException, waitUntilTableExists, waitUntilTableNotExists} from '@aws-sdk/client-dynamodb';
import type {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {z} from 'zod';
import {QueryBuilder} from '../src/query-builder';
import {QuerySerializer} from '../src/query-serializer';
import type {DynamoDBTableDefinition} from '../src/query-table-admin';
import {defineTable, typedTransaction} from '../src/typed-table';
import {path, ref} from '../src/document-path';
import type {PredicateCallback, PredicateScope, ExpressionAttributeType} from '../src/predicate';

let suiteId = 0;

async function queryUntilCount<T>(run: () => Promise<T[]>, expected: number): Promise<T[]> {
    // Global secondary indexes are eventually consistent.
    for (let attempt = 0; attempt < 20; attempt++) {
        const results = await run();

        if (results.length === expected) {
            return results;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return run();
}

export const queryBuilderContract = (backendName: string, dynamoDBClient: DynamoDBClient, close: () => void | Promise<void>, serviceLimits = false) => describe(`query - QueryBuilder contract: ${backendName}`, {concurrency: false}, () => {
    const suffix = `${process.pid}-${Date.now()}-${suiteId++}`;
    const tableName = `query-builder-test-${suffix}`;
    const compositeTableName = `query-builder-test-composite-${suffix}`;
    let tableCreated = false;
    let compositeTableCreated = false;

    before(async () => {
        console.log(`Creating test tables ${tableName} and ${compositeTableName} on ${backendName}`);
        const creations = await Promise.allSettled([
            QueryBuilder.createTable(tableName, 'id', dynamoDBClient).then(() => {
                tableCreated = true;
            }),
            QueryBuilder.createTable({
                name: compositeTableName,
                key: {partition: 'id', sort: 'sort'},
                attributes: {id: 'S', sort: 'N', category: 'S'},
                indexes: {'category-index': {kind: 'global', partition: 'category', sort: 'sort'}}
            }, dynamoDBClient).then(() => {
                compositeTableCreated = true;
            })
        ]);
        for (const creation of creations) {
            if (creation.status === 'rejected') {
                throw creation.reason;
            }
        }
        await Promise.all([
            waitUntilTableExists(
                {client: dynamoDBClient, maxWaitTime: 60},
                {TableName: tableName}
            ),
            waitUntilTableExists(
                {client: dynamoDBClient, maxWaitTime: 60},
                {TableName: compositeTableName}
            )
        ]);
        console.log(`Created test tables on ${backendName}`);
    });

    after(async () => {
        const deletions: Promise<unknown>[] = [];

        if (tableCreated) {
            console.log(`Deleting test table ${tableName} from ${backendName}`);
            deletions.push(QueryBuilder.deleteTable(tableName, dynamoDBClient).then(() => waitUntilTableNotExists(
                {client: dynamoDBClient, maxWaitTime: 60},
                {TableName: tableName}
            )));
        }

        if (compositeTableCreated) {
            console.log(`Deleting test table ${compositeTableName} from ${backendName}`);
            deletions.push(QueryBuilder.deleteTable(compositeTableName, dynamoDBClient).then(() => waitUntilTableNotExists(
                {client: dynamoDBClient, maxWaitTime: 60},
                {TableName: compositeTableName}
            )));
        }

        try {
            const results = await Promise.allSettled(deletions);
            for (const result of results) {
                if (result.status === 'rejected') {
                    throw result.reason;
                }
            }
            console.log(`Deleted test tables from ${backendName}`);
        } finally {
            await close();
        }
    });

    test('keeps literal punctuation distinct from nested paths and preserves compact list projections', async (context) => {
        const query = () => new QueryBuilder(tableName, dynamoDBClient);
        const record = {id: 'nested-path-contract', 'profile.address.city': 'literal',
            profile: {address: {city: 'London', country: 'GB'}},
            labels: [{name: 'first', rank: 1}, {other: 'second'}, {name: 'third', rank: 3}]};
        context.after(() => query().delete({id: record.id}).toPromise());
        await query().create(record).toPromise();
        const city = path('profile', 'address', 'city');
        const read = () => query().scan().consistent().where('id').eq(record.id);
        assert.equal((await read().where(city).eq('London').toPromise<any[]>()).length, 1);
        assert.equal((await read().where('profile.address.city').eq('literal').toPromise<any[]>()).length, 1);
        const selections = [city, path('labels', 2, 'name'), path('labels', 0, 'name'), path('labels', 1, 'name')];
        const expected = {profile: {address: {city: 'London'}}, labels: [{name: 'first'}, {name: 'third'}]};
        assert.deepEqual(await query().get({id: record.id}).consistent().select(...selections).toPromise(), expected);
        assert.deepEqual(await query().getBatch([{id: record.id}], {consistentRead: true, select: selections}), [expected]);
        assert.deepEqual(await read().select(...selections).toPromise(), [expected]);
        assert.deepEqual(await query().get({id: record.id}).select(path('labels', 1, 'name')).toPromise(), {});
        assert.deepEqual(await query().get({id: record.id}).select(path('labels', 0), path('labels', 2, 'name')).toPromise(),
            {labels: [{name: 'first', rank: 1}, {name: 'third'}]});
        const projected: any = await query().get({id: record.id}).select(...selections).toPromise();
        projected.profile.address.city = 'mutated';
        assert.deepEqual(await query().get({id: record.id}).consistent().toPromise(), record);
        await query().update({id: record.id}).set(city).eq('Manchester').remove(path('labels', 0))
            .remove(path('labels', 1)).set(path('labels', 2)).eq({name: 'new'}).toPromise();
        const updated: any = await query().get({id: record.id}).consistent().toPromise();
        assert.deepEqual(updated.labels, [{name: 'new'}]);
        assert.equal(updated.profile.address.city, 'Manchester');
        assert.equal(updated['profile.address.city'], 'literal');
        await assert.rejects(query().update({id: record.id}).set(path('absent', 'child')).eq(1).toPromise(),
            (error: any) => error.name === 'ValidationException');
        assert.deepEqual(await query().get({id: record.id}).consistent().toPromise(), updated);
        await query().update({id: record.id}).set('labels').eq(['a', 'b', 'c']).toPromise();
        await query().update({id: record.id}).set(path('labels', 9)).eq('y').set('separate').eq(1)
            .set(path('labels', 8)).eq('x').remove(path('labels', 4)).toPromise();
        assert.deepEqual((await query().get({id: record.id}).consistent().toPromise<any>()).labels, ['a', 'b', 'c', 'x', 'y']);
        await assert.rejects(query().update({id: record.id}).remove(path('absent', 'child')).toPromise(),
            (error: any) => error.name === 'ValidationException');
        assert.throws(() => query().update({id: record.id}).set('profile').eq({}).remove(city), /Overlapping/);
        assert.throws(() => query().update({id: record.id}).set(path('id', 'child')).eq(1), /key attributes/);
        assert.throws(() => query().update({id: record.id}).add(path('profile', 'score') as any).eq(1), /top-level/);
        assert.throws(() => query().get({id: record.id}).select('profile', city), /Overlapping/);
    });

    test('service byte limits paginate before filtering and reject oversized writes', {skip: !serviceLimits}, async context => {
        const records = () => new QueryBuilder(compositeTableName, dynamoDBClient);
        const keys = Array.from({length: 11}, (_, sort) => ({id: 'service-size-boundary', sort}));
        context.after(() => records().deleteBatch(keys));
        const payload = 'x'.repeat(300 * 1024);
        const documents = keys.slice(0, 8).map(key => ({...key, payload}));
        await records().createBatch(documents);
        const first = await records().query({id: keys[0].id}).consistent().page<any>({limit: 100});
        assert.ok(first.items.length > 0 && first.items.length < documents.length,
            `Expected a partial service page, received ${first.items.length} of ${documents.length} items`);
        assert.ok(first.cursor, 'Expected a continuation cursor at the service byte limit');
        const remaining = [];
        for await (const page of records().query({id: keys[0].id}).consistent().pages({cursor: first.cursor})) {
            remaining.push(...page.items);
        }
        assert.deepEqual([...first.items, ...remaining], documents);
        const empty = await records().query({id: keys[0].id}).consistent().where('payload').eq('missing').page({limit: 100});
        assert.deepEqual(empty.items, []);
        assert.ok(empty.cursor);
        const all = await records().query({id: keys[0].id}).consistent().toPromise<any[]>();
        assert.deepEqual(all, documents);
        await assert.rejects(records().create({...keys[0], payload: 'x'.repeat(400 * 1024)}).toPromise());
        await assert.rejects(records().update(keys[0]).set('payload').eq('x'.repeat(400 * 1024)).toPromise());
        assert.equal((await records().get(keys[0]).consistent().toPromise<any>()).payload.length, payload.length);
        const transaction = QueryBuilder.transactWrite(dynamoDBClient);
        keys.forEach(key => transaction.add(compositeTableName, query => query.create({...key, payload: 'x'.repeat(390 * 1024)})));
        await assert.rejects(transaction.toPromise());
        assert.deepEqual(await records().query({id: keys[0].id}).consistent().toPromise(), documents);
    });

    test('service rejects oversized batch wire payloads and expression limits', {skip: !serviceLimits}, async context => {
        const key = {id: 'service-expression-boundary'};
        const records = () => new QueryBuilder(tableName, dynamoDBClient);
        context.after(() => records().delete(key).toPromise());
        await records().create({...key, value: 1}).toPromise();
        for (const UpdateExpression of ['SET #v = :v' + ' '.repeat(4096), 'SET #v = :v' + ' + :v'.repeat(301)]) {
            await assert.rejects(dynamoDBClient.send(new UpdateItemCommand({TableName: tableName,
                Key: QuerySerializer.serialiseMap(key), UpdateExpression,
                ExpressionAttributeNames: {'#v': 'value'}, ExpressionAttributeValues: {':v': {N: '1'}}})));
        }
        const writes = Array.from({length: 25}, (_, index) => ({PutRequest: {Item: {
            id: {S: `wire-limit-${index}`}, payload: {L: Array.from({length: 80000}, () => ({S: ''}))}
        }}}));
        context.after(() => records().deleteBatch(writes.map(write => ({id: write.PutRequest.Item.id.S}))));
        const input = {RequestItems: {[tableName]: writes}};
        assert.ok(new TextEncoder().encode(JSON.stringify(input)).length > 16 * 1024 * 1024);
        await assert.rejects(dynamoDBClient.send(new BatchWriteItemCommand(input)));
        assert.equal(await records().get({id: 'wire-limit-0'}).consistent().toPromise(), null);
    });

    test('rejects duplicate batch writes without applying any part of the request', async (context) => {
        const query = () => new QueryBuilder(tableName, dynamoDBClient);
        const key = {id: 'duplicate-batch-contract'};
        context.after(() => query().delete(key).toPromise());
        await query().create({...key, value: 1}).toPromise();
        await assert.rejects(query().createBatch([{...key, value: 2}, {...key, value: 3}]), {name: 'ValidationException'});
        await assert.rejects(query().deleteBatch([key, key]), {name: 'ValidationException'});
        await assert.rejects(dynamoDBClient.send(new BatchWriteItemCommand({RequestItems: {[tableName]: [
            {PutRequest: {Item: QuerySerializer.serialiseMap({...key, value: 2})}},
            {DeleteRequest: {Key: QuerySerializer.serialiseMap(key)}}
        ]}})), {name: 'ValidationException'});
        assert.deepEqual(await query().get(key).consistent().toPromise(), {...key, value: 1});
    });

    test('round trips transformed typed records and preserves omitted defaults', async (context) => {
        const table = defineTable({name: tableName, key: {partition: 'id'},
            schema: z.object({id: z.string(), value: z.string().transform(Number), count: z.number().default(0)}),
            outputSchema: z.object({id: z.string(), value: z.number(), count: z.number()})});
        const records = table.using(dynamoDBClient);
        const key = {id: 'transformed-contract'};
        context.after(() => new QueryBuilder(tableName, dynamoDBClient).delete(key).toPromise());
        assert.equal(await records.create({...key, value: '3', count: 9}).returningAllOld().toPromise(), null);
        assert.deepEqual(await records.get(key).consistent().toPromise(), {...key, value: 3, count: 9});
        await records.update(key).with({value: '4'}).toPromise();
        assert.deepEqual(await records.get(key).consistent().toPromise(), {...key, value: 4, count: 9});
        await typedTransaction(dynamoDBClient).add(table, query => query.create({...key, value: '5', count: 9})).toPromise();
        assert.deepEqual(await records.get(key).consistent().toPromise(), {...key, value: 5, count: 9});
    });

    test('evaluates complete functions and stored-field operands including missing values', async (context) => {
        const query = () => new QueryBuilder(tableName, dynamoDBClient);
        const record = {id: 'expression-functions', text: '\u00e9\ud83d\ude00', number: 3, binary: new Uint8Array([1, 2, 3]),
            boolean: true, nil: null, otherNil: null, sameNumber: 3, map: {value: 1}, list: ['a', 'b'], strings: new Set(['a']),
            numbers: new Set([1]), binaries: new Set([new Uint8Array([1])]), low: 1, high: 5};
        context.after(() => query().delete({id: record.id}).toPromise());
        await query().create(record).toPromise();
        const read = () => query().scan().consistent().where('id').eq(record.id);
        const types: [string, ExpressionAttributeType][] = [['text', 'S'], ['number', 'N'], ['binary', 'B'], ['boolean', 'BOOL'],
            ['nil', 'NULL'], ['map', 'M'], ['list', 'L'], ['strings', 'SS'], ['numbers', 'NS'], ['binaries', 'BS']];
        for (const [field, type] of types) {
            assert.equal((await read().where(field).exists().where(field).attributeType(type).toPromise<any[]>()).length, 1);
            assert.equal((await read().where(field).not().attributeType(type).toPromise<any[]>()).length, 0);
        }
        assert.equal((await read().where('missing').not().exists().where('nil').exists().toPromise<any[]>()).length, 1);
        assert.equal((await read().where('text').size().eq(3).where('binary').size().between(2.5, 3.5)
            .where('map').size().in([-0.5, 1]).where('list').size().gt(-0.5).toPromise<any[]>()).length, 1);
        assert.equal((await read().where('text').beginsWith('\u00e9').where('binary').beginsWith(new Uint8Array([1, 2])).toPromise<any[]>()).length, 1);
        for (const field of ['number', 'boolean', 'nil', 'missing']) {
            assert.equal((await read().where(field).size().eq(1).toPromise<any[]>()).length, 0);
            assert.equal((await read().where(field).beginsWith('x').toPromise<any[]>()).length, 0);
        }
        assert.equal((await read().where('number').gte(ref('low')).where('number').lte(ref('high'))
            .where('number').between(ref('low'), ref('high')).where('number').in([ref('sameNumber'), 9]).toPromise<any[]>()).length, 1);
        assert.throws(() => read().where('number').eq(ref('number')), /distinct/);
        assert.throws(() => read().where('number').between(ref('number'), ref('high')), /distinct/);
        assert.throws(() => read().where('number').in([ref('number')]), /distinct/);
        for (const [left, right] of [['number', 'missing'], ['missing', 'number'], ['missing', 'otherMissing']]) {
            assert.equal((await read().where(left).eq(ref(right)).toPromise<any[]>()).length, 0);
            assert.equal((await read().where(left).ne(ref(right)).toPromise<any[]>()).length, 1);
            assert.equal((await read().where(left).lt(ref(right)).toPromise<any[]>()).length, 0);
        }
        assert.equal((await read().where('nil').eq(ref('otherNil')).toPromise<any[]>()).length, 1);
        assert.equal((await read().where('number').between(ref('missing'), ref('high')).toPromise<any[]>()).length, 0);
        assert.equal((await read().where('missing').in([ref('otherMissing')]).toPromise<any[]>()).length, 0);
        assert.throws(() => query().update({id: record.id}).set('number').eq(ref('high')), /update assignments/);
        assert.throws(() => read().where('list').contains(ref('text')), /Function arguments/);
    });

    test('groups predicates atomically and keeps failed callbacks and transactions from applying changes', async (context) => {
        const query = () => new QueryBuilder(tableName, dynamoDBClient);
        const record = {id: 'predicate-groups', tenant: 'tenant-1', status: 'open', priority: 1, archived: false,
            blocked: false, used: 2, quota: 5, profile: {city: 'London'}};
        context.after(() => query().deleteBatch([{id: record.id}, {id: 'predicate-marker'}]));
        await query().create(record).toPromise();
        const chain = query().scan().consistent().where('id').eq(record.id).where('tenant').eq('tenant-1')
            .whereAny(group => group.where('status').eq('open').whereAll(group => group.where('priority').gte(3).where('archived').eq(false)))
            .whereNot(group => group.where('blocked').eq(true));
        const invalid: PredicateCallback[] = [() => undefined, group => { group.where('status'); },
            group => { group.where('status').eq('closed'); throw new Error('callback failure'); },
            (async (group: PredicateScope) => { group.where('status').eq('closed'); await Promise.resolve(); group.where('priority').gt(10); }) as unknown as PredicateCallback];
        for (const callback of invalid) assert.throws(() => chain.whereAll(callback));
        const promise = chain.toPromise();
        assert.equal(chain.toPromise(), promise);
        assert.deepEqual(await promise, [record]);
        await query().update({id: record.id}).set(path('profile', 'city')).eq('Manchester')
            .whereAll(group => group.where('used').lt(ref('quota')).where('profile').attributeType('M'))
            .whereNot(group => group.where('blocked').eq(true)).toPromise();
        await query().conditionCheck({id: record.id}).whereAny(group => group.where('used').eq(2).where('status').eq('closed')).toPromise();
        await assert.rejects(QueryBuilder.transactWrite(dynamoDBClient)
            .add(tableName, builder => builder.update({id: record.id}).set('used').eq(3)
                .whereAny(group => group.where('status').eq('closed').where('priority').gte(3)))
            .add(tableName, builder => builder.create({id: 'predicate-marker'}).whereAll(group => group.where('id').not().exists()))
            .toPromise(), TransactionCanceledException);
        assert.equal(await query().get({id: 'predicate-marker'}).consistent().toPromise(), null);
        assert.equal((await query().get({id: record.id}).consistent().toPromise<any>()).used, 2);
        await query().delete({id: record.id}).whereNot(group => group.where('status').eq('closed')).toPromise();
        await query().create(record).whereAll(group => group.where('id').not().exists()).toPromise();
    });

    test('typed nested projection parsing never invents absent fields or list positions', async (context) => {
        const schema = z.object({id: z.string(),
            profile: z.object({city: z.string(), country: z.string().default('GB')}).readonly().optional(),
            labels: z.array(z.object({name: z.string(), rank: z.number().default(0)})),
            dictionary: z.record(z.string(), z.object({active: z.boolean()})),
            choice: z.union([z.object({value: z.string()}), z.object({value: z.number()})])});
        const table = defineTable({name: tableName, key: {partition: 'id'}, schema});
        const records = table.using(dynamoDBClient), id = 'typed-nested-contract';
        context.after(() => records.delete({id}).toPromise());
        await records.create({id, profile: {city: 'London'}, labels: [{name: 'a'}, {name: 'b'}],
            dictionary: {entry: {active: true}}, choice: {value: 2}}).toPromise();
        const city = records.path('profile', 'city'), label = records.path('labels', 1, 'name');
        assert.throws(() => records.update({id}).set('profile').eq(records.ref('id') as any), /update assignments/);
        assert.throws(() => records.scan().where('profile').contains(records.ref('id') as any), /Function arguments/);
        const expected = {profile: {city: 'London'}, labels: [{name: 'b'}]};
        assert.deepEqual(await records.get({id}).consistent().select(city, label).toPromise(), expected);
        assert.deepEqual(await records.get({id}).consistent().select(records.path('labels', 0), label).toPromise(),
            {labels: [{name: 'a', rank: 0}, {name: 'b'}]});
        assert.deepEqual(await records.getBatch([{id}], {consistentRead: true, select: [city, label]}), [expected]);
        assert.deepEqual(await records.scan().consistent().where('id').eq(id)
            .whereAny(group => group.where(records.path('dictionary', 'entry', 'active')).eq(true)
                .where(records.path('choice', 'value')).eq(2)).select(city, label).toPromise(), [expected]);
        await typedTransaction(dynamoDBClient).add(table, builder => builder.update({id}).set(city).eq('Manchester')
            .whereAll(group => group.where(city).beginsWith('Lon').where('labels').size().gte(2))).toPromise();
        assert.deepEqual(await records.get({id}).select(city).toPromise(), {profile: {city: 'Manchester'}});
        await records.update({id}).remove('profile').toPromise();
        assert.deepEqual(await records.get({id}).select(city).toPromise(), {});
    });

    test('conditional single-item writes return old attributes only when requested', async (context) => {
        const record = {id: 'failure-return', count: 10};
        context.after(() => new QueryBuilder(tableName, dynamoDBClient).delete({id: record.id}).toPromise());
        await new QueryBuilder(tableName, dynamoDBClient).create(record).toPromise();
        for (const operation of ['create', 'update', 'delete'] as const) {
            for (const mode of ['ALL_OLD', 'NONE'] as const) {
                const query = new QueryBuilder(tableName, dynamoDBClient);
                const write = operation === 'create' ? query.create({...record, count: 0}).where('id').not().exists()
                    : operation === 'update' ? query.update({id: record.id}).add('count').eq(1).where('count').lt(10)
                        : query.delete({id: record.id}).where('count').lt(10);
                const returningWrite = mode === 'ALL_OLD'
                    ? write.onConditionFailure().returningAllOld()
                    : write.onConditionFailure().returningNone();
                await assert.rejects(returningWrite.toPromise(), (error: unknown) => {
                    assert.ok(error instanceof ConditionalCheckFailedException);
                    assert.deepEqual(error.Item === undefined ? undefined : QuerySerializer.parseItem(error.Item), mode === 'ALL_OLD' ? record : undefined);
                    return true;
                });
            }
        }
        await assert.rejects(new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'missing-failure-return'}).add('count').eq(1).where('id').exists()
            .onConditionFailure().returningAllOld()
            .toPromise(), (error: unknown) => {
                assert.ok(error instanceof ConditionalCheckFailedException);
                assert.equal(error.Item, undefined);
                return true;
            });
        assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).get({id: record.id}).consistent().toPromise(), record);
    });

    for (const operation of ['update', 'delete'] as const) {
        for (const scenario of [
            {name: 'defaults', success: 'default', failure: 'default', failureFirst: false},
            {name: 'success none only', success: 'none', failure: 'default', failureFirst: false},
            {name: 'success full only', success: 'full', failure: 'default', failureFirst: false},
            {name: 'failure old only', success: 'default', failure: 'old', failureFirst: false},
            {name: 'failure none only', success: 'default', failure: 'none', failureFirst: false},
            {name: 'success none and failure old', success: 'none', failure: 'old', failureFirst: false},
            {name: 'failure old then success none', success: 'none', failure: 'old', failureFirst: true},
            {name: 'success full and failure none', success: 'full', failure: 'none', failureFirst: false},
            {name: 'failure none then success full', success: 'full', failure: 'none', failureFirst: true},
            {name: 'both none', success: 'none', failure: 'none', failureFirst: false},
            {name: 'both full', success: 'full', failure: 'old', failureFirst: false}
        ] as const) {
            test(`${operation} return options: ${scenario.name}`, async (context) => {
                const record = {id: `return-options-${operation}-${scenario.name}`, count: 1};
                context.after(() => new QueryBuilder(tableName, dynamoDBClient).delete({id: record.id}).toPromise());
                await new QueryBuilder(tableName, dynamoDBClient).create(record).toPromise();

                const execute = (expectedCount: number) => {
                    const builder = new QueryBuilder(tableName, dynamoDBClient);
                    const write: any = operation === 'update'
                        ? builder.update({id: record.id}).set('count').eq(2).where('count').eq(expectedCount)
                        : builder.delete({id: record.id}).where('count').eq(expectedCount);
                    const configureFailure = () => {
                        if (scenario.failure === 'old') {
                            write.onConditionFailure().returningAllOld();
                        } else if (scenario.failure === 'none') {
                            write.onConditionFailure().returningNone();
                        }
                    };
                    if (scenario.failureFirst) {
                        configureFailure();
                    }
                    if (scenario.success === 'none') {
                        write.returningNone();
                    } else if (scenario.success === 'full') {
                        if (operation === 'update') {
                            write.returningAllNew();
                        } else {
                            write.returningAllOld();
                        }
                    }
                    if (!scenario.failureFirst) {
                        configureFailure();
                    }
                    return write.toPromise();
                };

                await assert.rejects(execute(0), (error: unknown) => {
                    assert.ok(error instanceof ConditionalCheckFailedException);
                    assert.deepEqual(error.Item === undefined ? undefined : QuerySerializer.parseItem(error.Item),
                        scenario.failure === 'old' ? record : undefined);
                    return true;
                });
                assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).get({id: record.id}).consistent().toPromise(), record);

                const updatedRecord = {...record, count: 2};
                assert.deepEqual(await execute(1), scenario.success === 'none'
                    ? undefined : operation === 'update' ? updatedRecord : record);
                assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).get({id: record.id}).consistent().toPromise(),
                    operation === 'update' ? updatedRecord : null);
            });
        }
    }

    for (const operation of ['create', 'update', 'delete'] as const) {
        for (const failureMode of ['default', 'old', 'none'] as const) {
            test(`${operation} toResult reports success and conditional failure (${failureMode})`, async (context) => {
                const record = {id: `result-${operation}-${failureMode}`, count: 1, legacy: {value: 'previous'}};
                const replacement = {id: record.id, count: 2};
                context.after(() => new QueryBuilder(tableName, dynamoDBClient).delete({id: record.id}).toPromise());
                await new QueryBuilder(tableName, dynamoDBClient).create(record).toPromise();

                const write = (expectedCount: number) => {
                    const builder = new QueryBuilder(tableName, dynamoDBClient);
                    const query = operation === 'create' ? builder.create(replacement).where('count').eq(expectedCount)
                        : operation === 'update' ? builder.update({id: record.id}).set('count').eq(2).where('count').eq(expectedCount)
                            : builder.delete({id: record.id}).where('count').eq(expectedCount);
                    if (failureMode === 'old') {
                        return query.onConditionFailure().returningAllOld();
                    }
                    if (failureMode === 'none') {
                        return query.onConditionFailure().returningNone();
                    }
                    return query;
                };

                assert.deepEqual(await write(0).toResult<typeof replacement, typeof record>(), {
                    applied: false, previous: failureMode === 'old' ? record : null
                });
                assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).get({id: record.id}).consistent().toPromise(), record);
                const expectedValue = operation === 'create' ? replacement : operation === 'update' ? {...record, count: 2} : record;
                assert.deepEqual(await write(1).toResult(), {applied: true, value: expectedValue});
                assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).get({id: record.id}).consistent().toPromise(),
                    operation === 'delete' ? null : expectedValue);
            });
        }
    }

    test('toResult handles missing items and payload-free success without conflating outcomes', async (context) => {
        const key = {id: 'result-missing'};
        context.after(() => new QueryBuilder(tableName, dynamoDBClient).delete(key).toPromise());
        assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).update(key)
            .set('count').eq(1).where('id').exists().onConditionFailure().returningAllOld().toResult(),
            {applied: false, previous: null});
        assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).delete(key).toResult<null>(),
            {applied: true, value: null});
        assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).create({...key, count: 1})
            .where('id').not().exists().toResult(), {applied: true, value: {...key, count: 1}});
        assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).update(key)
            .add('count').eq(1).where('count').eq(1).returningNone()
            .onConditionFailure().returningAllOld().toResult<void>(), {applied: true, value: undefined});
        assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).update(key)
            .add('count').eq(1).where('count').eq(1).returningNone()
            .onConditionFailure().returningAllOld().toResult<void, {id: string; count: number}>(),
            {applied: false, previous: {...key, count: 2}});
        assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).delete(key)
            .where('count').eq(2).onConditionFailure().returningAllOld().returningNone().toResult<void>(),
            {applied: true, value: undefined});
    });

    test('typed result chains infer and validate independent success and failure payloads', async (context) => {
        const schema = z.object({id: z.string(), count: z.number().int().nonnegative()}).strict();
        const records = defineTable({name: tableName, schema, key: {partition: 'id'}}).using(dynamoDBClient);
        const key = {id: 'typed-result-contract'};
        context.after(() => new QueryBuilder(tableName, dynamoDBClient).delete(key).toPromise());
        assert.deepEqual(await records.create({...key, count: 1}).where('id').not().exists()
            .onConditionFailure().returningAllOld().toResult(), {applied: true, value: {...key, count: 1}});
        assert.deepEqual(await records.create({...key, count: 2}).where('id').not().exists()
            .onConditionFailure().returningAllOld().toResult(), {applied: false, previous: {...key, count: 1}});
        assert.deepEqual(await records.update(key).add('count').eq(1).where('count').lt(2)
            .onConditionFailure().returningAllOld().toResult(), {applied: true, value: {...key, count: 2}});
        assert.deepEqual(await records.update(key).add('count').eq(1).where('count').lt(2)
            .returningNone().onConditionFailure().returningAllOld().toResult(), {applied: false, previous: {...key, count: 2}});
        assert.deepEqual(await records.update(key).add('count').eq(1).where('count').lt(3)
            .returningNone().onConditionFailure().returningAllOld().toResult(), {applied: true, value: undefined});
        assert.deepEqual(await records.delete(key).where('count').lt(3).onConditionFailure().returningAllOld()
            .returningNone().toResult(), {applied: false, previous: {...key, count: 3}});
        assert.deepEqual(await records.delete(key).where('count').lt(3).onConditionFailure().returningNone()
            .toResult(), {applied: false, previous: null});
        assert.deepEqual(await records.delete(key).where('count').eq(3).onConditionFailure().returningNone()
            .toResult(), {applied: true, value: {...key, count: 3}});
        assert.deepEqual(await records.update(key).set('count').eq(1).where('id').exists()
            .onConditionFailure().returningAllOld().toResult(), {applied: false, previous: null});
        assert.deepEqual(await records.delete(key).toResult(), {applied: true, value: null});

        await new QueryBuilder(tableName, dynamoDBClient).create({...key, count: 'invalid'}).toPromise();
        await assert.rejects(records.create({...key, count: 1}).where('id').not().exists()
            .onConditionFailure().returningAllOld().toResult(), z.ZodError);
        assert.deepEqual(await records.create({...key, count: 1}).where('id').not().exists()
            .onConditionFailure().returningNone().toResult(), {applied: false, previous: null});
    });

    test('creates, reads, updates, and deletes records', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'crud', value: 10})
            .toPromise();

        assert.deepEqual(
            await new QueryBuilder(tableName, dynamoDBClient).get({id: 'crud'}).toPromise(),
            {id: 'crud', value: 10}
        );

        const updated = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'crud'})
            .with({value: 20, label: 'updated'})
            .toPromise<any>();

        assert.equal(updated.value, 20);
        assert.equal(updated.label, 'updated');
        assert.deepEqual(
            await new QueryBuilder(tableName, dynamoDBClient).get({id: 'crud'}).toPromise(),
            {id: 'crud', value: 20, label: 'updated'}
        );

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'crud'}).toPromise();
        assert.equal(
            await new QueryBuilder(tableName, dynamoDBClient).get({id: 'crud'}).toPromise(),
            null
        );
    });

    test('returns the complete post-update item when the assigned value is unchanged', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'unchanged-update', value: 10, label: 'existing'})
            .toPromise();

        const updated = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'unchanged-update'})
            .set('value').eq(10)
            .returningAllNew()
            .toPromise<any>();

        assert.deepEqual(updated, {id: 'unchanged-update', value: 10, label: 'existing'});
        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'unchanged-update'}).toPromise();
    });

    test('applies update actions after with()', async () => {
        const id = `with-update-${Date.now()}`;

        try {
            await new QueryBuilder(tableName, dynamoDBClient)
                .create({id: id, value: 10})
                .toPromise();

            const updated = await new QueryBuilder(tableName, dynamoDBClient)
                .update({id: id})
                .with({label: 'updated'})
                .add('value').eq(5)
                .toPromise<any>();

            assert.equal(updated.value, 15);
            assert.equal(updated.label, 'updated');
            assert.deepEqual(
                await new QueryBuilder(tableName, dynamoDBClient).get({id: id}).toPromise(),
                {id: id, value: 15, label: 'updated'}
            );
        } finally {
            await new QueryBuilder(tableName, dynamoDBClient).delete({id: id}).toPromise();
        }
    });

    test('normalises a live DynamoDB table definition', async () => {
        assert.deepEqual(
            await QueryBuilder.getTableDefinition(compositeTableName, dynamoDBClient),
            {
                name: compositeTableName,
                key: {partition: 'id', sort: 'sort'},
                attributes: {id: 'S', sort: 'N', category: 'S'},
                indexes: {
                    'category-index': {kind: 'global', partition: 'category', sort: 'sort'}
                }
            }
        );
    });

    test('creates numeric and binary keys and local indexes from a portable definition', async () => {
        const definition: DynamoDBTableDefinition = {
            name: `query-builder-types-${suffix}`,
            key: {partition: 'group', sort: 'id'},
            attributes: {group: 'N', id: 'B', label: 'S'},
            indexes: {'label-index': {kind: 'local', partition: 'group', sort: 'label'}}
        };
        let created = false;
        try {
            await QueryBuilder.createTable(definition, dynamoDBClient);
            created = true;
            await waitUntilTableExists({client: dynamoDBClient, maxWaitTime: 60}, {TableName: definition.name});
            assert.deepEqual(await QueryBuilder.getTableDefinition(definition.name, dynamoDBClient), definition);
            const query = () => new QueryBuilder(definition.name, dynamoDBClient);
            await query().create({group: 1, id: Buffer.from('first'), label: 'alpha'}).toPromise();
            await query().create({group: 1, id: Buffer.from('second'), label: 'beta'}).toPromise();
            const record = await query().get({group: 1, id: Buffer.from('first')}).consistent().toPromise<{label: string}>();
            assert.equal(record.label, 'alpha');
            const matched = await query().query({group: 1}).consistent().sortKey('label').beginsWith('al')
                .usingIndex('label-index', 'local').toPromise<{label: string}[]>();
            assert.deepEqual(matched.map((item) => item.label), ['alpha']);
        } finally {
            if (created) {
                await QueryBuilder.deleteTable(definition.name, dynamoDBClient);
                await waitUntilTableNotExists({client: dynamoDBClient, maxWaitTime: 60}, {TableName: definition.name});
            }
        }
    });

    test('returns attributes according to secondary index projections', async () => {
        const definition: DynamoDBTableDefinition = {
            name: `query-builder-projections-${suffix}`,
            key: {partition: 'group', sort: 'id'},
            attributes: {group: 'N', id: 'S', account: 'S', label: 'S'},
            indexes: {
                account: {
                    kind: 'global',
                    partition: 'account',
                    sort: 'id',
                    projection: {type: 'KEYS_ONLY'}
                },
                stats: {
                    kind: 'global',
                    partition: 'group',
                    projection: {type: 'INCLUDE', nonKeyAttributes: ['createdBy']}
                },
                label: {
                    kind: 'local',
                    partition: 'group',
                    sort: 'label',
                    projection: {type: 'KEYS_ONLY'}
                }
            }
        };
        let created = false;
        try {
            await QueryBuilder.createTable(definition, dynamoDBClient);
            created = true;
            await waitUntilTableExists({client: dynamoDBClient, maxWaitTime: 60}, {TableName: definition.name});
            const query = () => new QueryBuilder(definition.name, dynamoDBClient);
            await query().create({
                group: 1,
                id: 'projected',
                account: 'account',
                label: 'alpha',
                createdBy: 'creator',
                payload: 'base-only'
            }).toPromise();

            const account = await queryUntilCount(
                () => query().query({account: 'account'}).usingIndex('account').toPromise<any[]>(),
                1
            );
            const stats = await queryUntilCount(
                () => query().query({group: 1}).usingIndex('stats').toPromise<any[]>(),
                1
            );
            const local = await query().query({group: 1}).consistent()
                .usingIndex('label', 'local')
                .select('payload')
                .toPromise<any[]>();

            assert.deepEqual(account, [{group: 1, id: 'projected', account: 'account'}]);
            assert.deepEqual(stats, [{group: 1, id: 'projected', createdBy: 'creator'}]);
            assert.deepEqual(local, [{payload: 'base-only'}]);
            const accountScan = await queryUntilCount(() => query().scan().usingIndex('account').where('account').eq('account').toPromise<any[]>(), 1);
            assert.deepEqual(accountScan, account);
            assert.deepEqual(await queryUntilCount(() => query().scan().usingIndex('stats').where('group').eq(1).toPromise<any[]>(), 1), stats);
            assert.deepEqual(await query().scan().usingIndex('label', 'local').consistent().select('payload').toPromise(), local);
            assert.deepEqual(await query().scan().usingIndex('label', 'local').where('payload').eq('base-only').toPromise(), []);
            assert.deepEqual(await query().scan().usingIndex('label', 'local').select('payload').where('payload').eq('base-only').toPromise(), local);
            assert.deepEqual(await query().scan().usingIndex('label', 'local').select('payload').where('createdBy').eq('creator').toPromise(), local);
            const typed = defineTable({name: definition.name,
                schema: z.object({group: z.number(), id: z.string(), account: z.string(), label: z.string(), createdBy: z.string(), payload: z.string()}),
                key: {partition: 'group', sort: 'id'}, indexes: {
                    account: {kind: 'global', partition: 'account', sort: 'id', projection: {type: 'KEYS_ONLY'}},
                    label: {kind: 'local', partition: 'group', sort: 'label', projection: {type: 'KEYS_ONLY'}}}}).using(dynamoDBClient);
            assert.deepEqual(await queryUntilCount(() => typed.index('account').scan().where('account').eq('account').toPromise(), 1), account);
            assert.deepEqual(await typed.index('label').scan().consistent().select('payload').toPromise(), local);
            await assert.rejects(query().scan().usingIndex('account').select('payload').toPromise(), DynamoDBServiceException);
            assert.deepEqual(await query().scan().usingIndex('account').where('payload').eq('base-only').toPromise(), []);
            assert.deepEqual(await query().scan().usingIndex('account').where('payload').not().exists().toPromise(), account);
            await assert.rejects(
                query().query({account: 'account'}).usingIndex('account').select('payload').toPromise(),
                DynamoDBServiceException
            );
            await assert.rejects(
                query().query({account: 'account'}).usingIndex('account').where('payload').eq('base-only').toPromise(),
                DynamoDBServiceException
            );
            await assert.rejects(
                query().query({group: 1}).consistent().usingIndex('label', 'local').where('payload').eq('base-only').toPromise(),
                DynamoDBServiceException
            );
        } finally {
            if (created) {
                await QueryBuilder.deleteTable(definition.name, dynamoDBClient);
                await waitUntilTableNotExists({client: dynamoDBClient, maxWaitTime: 60}, {TableName: definition.name});
            }
        }
    });

    test('validates typed table writes and records loaded from DynamoDB', async () => {
        const schema = z.object({
            id: z.string().min(1),
            value: z.number().int().nonnegative()
        }).strict();
        const table = defineTable({name: tableName, schema: schema, key: {partition: 'id'}});
        const records = table.using(dynamoDBClient);

        await records.create({id: 'typed-valid', value: 10}).toPromise();
        assert.deepEqual(await records.get({id: 'typed-valid'}).toPromise(), {id: 'typed-valid', value: 10});

        await records.update({id: 'typed-valid'}).set('value').eq(20).toPromise();
        assert.equal((await records.get({id: 'typed-valid'}).toPromise())?.value, 20);

        assert.throws(() => records.create({id: 'typed-invalid', value: -1}).toPromise(), z.ZodError);
        assert.equal(await new QueryBuilder(tableName, dynamoDBClient).get({id: 'typed-invalid'}).toPromise(), null);

        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'typed-malformed', value: 'wrong'})
            .toPromise();
        await assert.rejects(records.get({id: 'typed-malformed'}).toPromise(), z.ZodError);

        await new QueryBuilder(tableName, dynamoDBClient).deleteBatch([
            {id: 'typed-valid'},
            {id: 'typed-malformed'}
        ]);
    });

    test('queries a selected typed index with its declared key shape', async () => {
        const schema = z.object({
            id: z.string(),
            sort: z.number(),
            category: z.string(),
            value: z.number()
        }).strict();
        const table = defineTable({
            name: compositeTableName,
            schema: schema,
            key: {partition: 'id', sort: 'sort'},
            indexes: {'category-index': {kind: 'global', partition: 'category', sort: 'sort'}}
        });
        const records = table.using(dynamoDBClient);
        await records.createBatch([
            {id: 'typed-index', sort: 1, category: 'typed-index', value: 1},
            {id: 'typed-index', sort: 2, category: 'typed-index', value: 2}
        ]);

        const matched = await queryUntilCount(
            () => records.index('category-index').query({category: 'typed-index'}).sortKey().between(1, 2).limit(1, null).toPromise(),
            2
        );
        const primaryMatched = await records.query({id: 'typed-index'}).sortKey().gte(2).toPromise();

        assert.deepEqual(matched.map((record) => record.value).sort(), [1, 2]);
        assert.deepEqual(primaryMatched.map((record) => record.value), [2]);
        await records.deleteBatch([
            {id: 'typed-index', sort: 1},
            {id: 'typed-index', sort: 2}
        ]);
    });

    test('commits schema-aware typed table transactions atomically', async () => {
        const schema = z.object({id: z.string().min(1), value: z.number().int().nonnegative()}).strict();
        const table = defineTable({name: tableName, schema: schema, key: {partition: 'id'}});
        const records = table.using(dynamoDBClient);
        await records.createBatch([
            {id: 'typed-transaction-guard', value: 1},
            {id: 'typed-transaction-update', value: 2},
            {id: 'typed-transaction-delete', value: 3}
        ]);

        await typedTransaction(dynamoDBClient)
            .add(table, (query) => query
                .conditionCheck({id: 'typed-transaction-guard'})
                .where('value').eq(1))
            .add(table, (query) => query
                .create({id: 'typed-transaction-create', value: 4})
                .where('id').not().exists())
            .add(table, (query) => query
                .update({id: 'typed-transaction-update'})
                .set('value').eq(5)
                .where('id').exists())
            .add(table, (query) => query
                .delete({id: 'typed-transaction-delete'})
                .where('id').exists())
            .toPromise();

        assert.equal((await records.get({id: 'typed-transaction-create'}).toPromise())?.value, 4);
        assert.equal((await records.get({id: 'typed-transaction-update'}).toPromise())?.value, 5);
        assert.equal(await records.get({id: 'typed-transaction-delete'}).toPromise(), null);

        await records.deleteBatch([
            {id: 'typed-transaction-guard'},
            {id: 'typed-transaction-update'},
            {id: 'typed-transaction-create'}
        ]);
    });

    test('rolls back schema-aware typed table transactions on condition failure', async () => {
        const schema = z.object({id: z.string().min(1), value: z.number().int().nonnegative()}).strict();
        const table = defineTable({name: tableName, schema: schema, key: {partition: 'id'}});
        const records = table.using(dynamoDBClient);
        await records.createBatch([
            {id: 'typed-rollback-guard', value: 1},
            {id: 'typed-rollback-update', value: 2},
            {id: 'typed-rollback-delete', value: 3}
        ]);

        await assert.rejects(
            typedTransaction(dynamoDBClient)
                .add(table, (query) => query
                    .conditionCheck({id: 'typed-rollback-guard'})
                    .where('value').eq(999))
                .add(table, (query) => query
                    .create({id: 'typed-rollback-create', value: 4})
                    .where('id').not().exists())
                .add(table, (query) => query
                    .update({id: 'typed-rollback-update'})
                    .set('value').eq(5))
                .add(table, (query) => query
                    .delete({id: 'typed-rollback-delete'}))
                .toPromise(),
            TransactionCanceledException
        );

        assert.equal(await records.get({id: 'typed-rollback-create'}).toPromise(), null);
        assert.equal((await records.get({id: 'typed-rollback-update'}).toPromise())?.value, 2);
        assert.equal((await records.get({id: 'typed-rollback-delete'}).toPromise())?.value, 3);

        await records.deleteBatch([
            {id: 'typed-rollback-guard'},
            {id: 'typed-rollback-update'},
            {id: 'typed-rollback-delete'}
        ]);
    });

    test('propagates conditional PutItem failures', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'conditional-put'})
            .toPromise();

        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .create({id: 'conditional-put'})
                .where('id').not().exists()
                .toPromise(),
            (error) => error instanceof ConditionalCheckFailedException
        );

        await new QueryBuilder(tableName, dynamoDBClient)
            .delete({id: 'conditional-put'})
            .toPromise();
    });

    test('propagates conditional UpdateItem failures', async () => {
        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .update({id: 'conditional-update'})
                .set('value').eq(1)
                .where('id').exists()
                .toPromise(),
            (error) => error instanceof ConditionalCheckFailedException
        );
    });

    test('propagates conditional DeleteItem failures', async () => {
        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .delete({id: 'conditional-delete'})
                .where('id').exists()
                .toPromise(),
            (error) => error instanceof ConditionalCheckFailedException
        );
    });

    test('propagates invalid update failures', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'invalid-update', value: 'not-a-number'})
            .toPromise();

        try {
            await assert.rejects(
                new QueryBuilder(tableName, dynamoDBClient)
                    .update({id: 'invalid-update'})
                    .add('value').eq(1)
                    .toPromise(),
                (error) => error instanceof DynamoDBServiceException && error.name === 'ValidationException'
            );
        } finally {
            await new QueryBuilder(tableName, dynamoDBClient)
                .delete({id: 'invalid-update'})
                .toPromise();
        }
    });

    test('propagates missing table failures', async () => {
        const missingTableName = `query-builder-missing-${process.pid}-${Date.now()}`;

        await assert.rejects(
            new QueryBuilder(missingTableName, dynamoDBClient)
                .get({id: 'missing-table'})
                .toPromise(),
            (error) => error instanceof ResourceNotFoundException
        );
    });

    test('enforces accumulated and negated write conditions', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'conditions', value: 10, size: 1})
            .toPromise();

        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .create({id: 'conditions', value: 20, size: 2})
                .where('value').eq(999)
                .where('id').exists()
                .toPromise()
        );
        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .update({id: 'conditions'})
                .set('marker').eq('changed')
                .where('value').eq(999)
                .where('id').exists()
                .toPromise()
        );
        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .delete({id: 'conditions'})
                .where('value').eq(999)
                .where('id').exists()
                .toPromise()
        );
        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .create({id: 'conditions', value: 20, size: 2})
                .where('value').not().gt(5)
                .toPromise()
        );
        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .update({id: 'conditions'})
                .set('marker').eq('changed')
                .where('value').not().gt(5)
                .toPromise()
        );
        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .delete({id: 'conditions'})
                .where('value').not().gt(5)
                .toPromise()
        );

        const updated = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'conditions'})
            .set('marker').eq('unchanged')
            .where('size').exists()
            .toPromise<any>();

        assert.equal(updated.marker, 'unchanged');
        assert.equal(updated.value, 10);

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'conditions'}).toPromise();
    });

    test('enforces exists conditions for updates and deletes', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'exists-conditions'})
            .toPromise();

        const firstUpdate = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'exists-conditions'})
            .with({value: 123})
            .where('value').not().exists()
            .toPromise<any>();
        assert.equal(firstUpdate.value, 123);

        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .update({id: 'exists-conditions'})
                .with({value: 456})
                .where('value').not().exists()
                .toPromise()
        );
        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .update({id: 'exists-conditions'})
                .set('dependent').eq(456)
                .where('required').exists()
                .toPromise()
        );

        await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'exists-conditions'})
            .set('required').eq(123)
            .toPromise();
        await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'exists-conditions'})
            .set('dependent').eq(456)
            .where('required').exists()
            .toPromise();

        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .delete({id: 'exists-conditions'})
                .where('missing').exists()
                .toPromise()
        );
        assert.ok(await new QueryBuilder(tableName, dynamoDBClient).get({id: 'exists-conditions'}).toPromise());

        await new QueryBuilder(tableName, dynamoDBClient)
            .delete({id: 'exists-conditions'})
            .where('dependent').eq(456)
            .toPromise();
        assert.equal(
            await new QueryBuilder(tableName, dynamoDBClient).get({id: 'exists-conditions'}).toPromise(),
            null
        );
    });

    test('uses condition values distinct from updated attributes', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'same-attribute', value: 10, label: 'alpha'})
            .toPromise();

        const equal = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'same-attribute'})
            .with({value: 20})
            .where('value').eq(10)
            .toPromise<any>();
        assert.equal(equal.value, 20);

        const greaterThan = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'same-attribute'})
            .set('value').eq(25)
            .where('value').gt(5)
            .toPromise<any>();
        assert.equal(greaterThan.value, 25);

        const lessThan = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'same-attribute'})
            .set('value').eq(5)
            .where('value').lt(30)
            .toPromise<any>();
        assert.equal(lessThan.value, 5);

        const notEqual = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'same-attribute'})
            .set('value').eq(10)
            .where('value').ne(20)
            .toPromise<any>();
        assert.equal(notEqual.value, 10);

        const greaterThanOrEqual = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'same-attribute'})
            .set('value').eq(15)
            .where('value').gte(10)
            .toPromise<any>();
        assert.equal(greaterThanOrEqual.value, 15);

        const lessThanOrEqual = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'same-attribute'})
            .set('value').eq(5)
            .where('value').lte(15)
            .toPromise<any>();
        assert.equal(lessThanOrEqual.value, 5);

        const contained = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'same-attribute'})
            .set('label').eq('beta')
            .where('label').contains('ph')
            .toPromise<any>();
        assert.equal(contained.label, 'beta');

        const included = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'same-attribute'})
            .set('value').eq(15)
            .where('value').in([5, 6])
            .toPromise<any>();
        assert.equal(included.value, 15);

        const range = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'same-attribute'})
            .set('label').eq('gamma')
            .where('value').gte(5)
            .where('value').lte(15)
            .toPromise<any>();
        assert.equal(range.label, 'gamma');

        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'same-attribute', value: 20, label: 'replacement'})
            .where('value').gt(10)
            .where('value').lt(20)
            .toPromise();
        assert.equal(
            (await new QueryBuilder(tableName, dynamoDBClient).get({id: 'same-attribute'}).toPromise<any>()).label,
            'replacement'
        );

        await new QueryBuilder(tableName, dynamoDBClient)
            .delete({id: 'same-attribute'})
            .where('value').gt(15)
            .where('value').lt(25)
            .toPromise();
        assert.equal(
            await new QueryBuilder(tableName, dynamoDBClient).get({id: 'same-attribute'}).toPromise(),
            null
        );
    });

    test('filters scans and queries with comparison operators', async () => {
        await new QueryBuilder(tableName, dynamoDBClient).createBatch([
            {id: 'filter-a', value: 123, label: 'alpha'},
            {id: 'filter-b', value: 456, label: 'beta'}
        ]);

        const between = await new QueryBuilder(tableName, dynamoDBClient)
            .query({id: 'filter-a'})
            .where('value').gt(100)
            .where('value').lt(200)
            .toPromise<any[]>();
        assert.deepEqual(between.map((item) => item.id), ['filter-a']);

        const scanEqual = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('id').eq('filter-a')
            .toPromise<any[]>();
        assert.deepEqual(scanEqual.map((item) => item.id), ['filter-a']);

        const scanBetween = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('id').contains('filter-')
            .where('value').gt(100)
            .where('value').lt(200)
            .toPromise<any[]>();
        assert.deepEqual(scanBetween.map((item) => item.id), ['filter-a']);

        const inResult = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('id').contains('filter-')
            .where('value').in([123, 456])
            .toPromise<any[]>();
        assert.deepEqual(inResult.map((item) => item.id).sort(), ['filter-a', 'filter-b']);

        const notGreaterThan = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('id').contains('filter-')
            .where('value').not().gt(200)
            .toPromise<any[]>();
        assert.deepEqual(notGreaterThan.map((item) => item.id), ['filter-a']);

        const notGreaterThanOrEqual = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('id').contains('filter-')
            .where('value').not().gte(200)
            .toPromise<any[]>();
        assert.deepEqual(notGreaterThanOrEqual.map((item) => item.id), ['filter-a']);

        const notLessThan = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('id').contains('filter-')
            .where('value').not().lt(456)
            .toPromise<any[]>();
        assert.deepEqual(notLessThan.map((item) => item.id), ['filter-b']);

        const notLessThanOrEqual = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('id').contains('filter-')
            .where('value').not().lte(200)
            .toPromise<any[]>();
        assert.deepEqual(notLessThanOrEqual.map((item) => item.id), ['filter-b']);

        const notNotEqual = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('id').contains('filter-')
            .where('value').not().ne(123)
            .toPromise<any[]>();
        assert.deepEqual(notNotEqual.map((item) => item.id), ['filter-a']);

        const notContains = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('id').contains('filter-')
            .where('label').not().contains('ph')
            .toPromise<any[]>();
        assert.deepEqual(notContains.map((item) => item.id), ['filter-b']);

        const notIn = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('id').contains('filter-')
            .where('value').not().in([123])
            .toPromise<any[]>();
        assert.deepEqual(notIn.map((item) => item.id), ['filter-b']);

        await new QueryBuilder(tableName, dynamoDBClient).deleteBatch([{id: 'filter-a'}, {id: 'filter-b'}]);
    });

    test('applies remove, numeric add, set add, and set delete updates', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'updates', value: 123, total: 123, values: new Set([1, 2, 3])})
            .toPromise();

        await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'updates'})
            .remove('value')
            .toPromise();
        await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'updates'})
            .add('total').eq(456)
            .add('values').eq(new Set([4]))
            .toPromise();
        const updated = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'updates'})
            .delete('values').eq(new Set([1]))
            .toPromise<any>();

        assert.equal(updated.value, undefined);
        assert.equal(updated.total, 579);
        assert.deepEqual(updated.values, new Set([2, 3, 4]));

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'updates'}).toPromise();
    });

    test('adjusts integer and fractional credit values without creating missing records', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'organisation-credits', credits: 10, subscriptionCredits: 2})
            .toPromise();

        const incremented = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'organisation-credits'})
            .add('credits').eq(7)
            .where('id').exists()
            .toPromise<any>();
        assert.equal(incremented.credits, 17);

        const decremented = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'organisation-credits'})
            .add('credits').eq(-5)
            .where('id').exists()
            .toPromise<any>();
        assert.equal(decremented.credits, 12);

        const fractional = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'organisation-credits'})
            .add('subscriptionCredits').eq(-0.5)
            .where('id').exists()
            .toPromise<any>();
        assert.equal(fractional.subscriptionCredits, 1.5);

        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .update({id: 'missing-organisation-credits'})
                .add('credits').eq(10)
                .where('id').exists()
                .toPromise()
        );
        assert.equal(
            await new QueryBuilder(tableName, dynamoDBClient).get({id: 'missing-organisation-credits'}).toPromise(),
            null
        );

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'organisation-credits'}).toPromise();
    });

    test('round trips nested values, buffers, sets, and timestamps', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .timestamps()
            .create({
                id: 'serialization',
                active: true,
                nullable: null,
                values: [1, 'two'],
                nested: {value: 3},
                numbers: new Set([1.5, 2.25]),
                strings: new Set(['one', 'two']),
                buffer: Buffer.from('value'),
                buffers: new Set([Buffer.from('one'), Buffer.from('two')])
            })
            .toPromise();

        const created = await new QueryBuilder(tableName, dynamoDBClient)
            .get({id: 'serialization'})
            .toPromise<any>();
        assert.equal(created.active, true);
        assert.equal(created.nullable, null);
        assert.deepEqual(created.values, [1, 'two']);
        assert.deepEqual(created.nested, {value: 3});
        assert.deepEqual(created.numbers, new Set([1.5, 2.25]));
        assert.deepEqual(created.strings, new Set(['one', 'two']));
        assert.deepEqual(Buffer.from(created.buffer), Buffer.from('value'));
        assert.deepEqual(
            Array.from(created.buffers as Set<Uint8Array>).map((value) => Buffer.from(value).toString()).sort(),
            ['one', 'two']
        );
        assert.equal(typeof created.createdAt, 'number');

        const updated = await new QueryBuilder(tableName, dynamoDBClient)
            .timestamps()
            .update({id: 'serialization'})
            .set('active').eq(false)
            .toPromise<any>();
        assert.equal(updated.active, false);
        assert.equal(typeof updated.modifiedAt, 'number');

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'serialization'}).toPromise();
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({
                id: 'serialization',
                numbers: new Set([1.5, 2.25]),
                strings: new Set(['one', 'two'])
            })
            .toPromise();
        const recreated = await new QueryBuilder(tableName, dynamoDBClient)
            .get({id: 'serialization'})
            .toPromise<any>();
        assert.deepEqual(recreated.numbers, new Set([1.5, 2.25]));
        assert.deepEqual(recreated.strings, new Set(['one', 'two']));
        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'serialization'}).toPromise();
    });

    test('handles batch operations and hard scan limits', async () => {
        const documents = Array.from({length: 10}).map((_, index) => ({id: `batch-${index + 1}`}));

        const created = await new QueryBuilder(tableName, dynamoDBClient).createBatch(documents);
        assert.equal(created.length, 10);

        const scanned = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .toPromise<any[]>();
        assert.equal(scanned.length, 10);

        const filtered = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('id').eq('batch-1')
            .toPromise<any[]>();
        assert.deepEqual(filtered.map((item) => item.id), ['batch-1']);

        const fetched = await new QueryBuilder(tableName, dynamoDBClient).getBatch<any>(
            [{id: 'batch-1'}, {id: 'batch-3'}],
            {consistentRead: true}
        );
        assert.deepEqual(fetched.map((item) => item.id).sort(), ['batch-1', 'batch-3']);

        const limited = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .limit(3, 8)
            .toPromise<any[]>();
        assert.equal(limited.length, 8);

        await new QueryBuilder(tableName, dynamoDBClient).deleteBatch(documents);
        const remaining = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .toPromise<any[]>();
        assert.deepEqual(remaining, []);
    });

    test('applies the last update action per attribute', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'last-action', kept: 'original', dropped: 'original', counter: 0})
            .toPromise();

        const updated = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'last-action'})
            .remove('kept')
            .set('kept').eq('restored')
            .set('dropped').eq('ignored')
            .remove('dropped')
            .set('counter').eq(1)
            .set('counter').eq(2)
            .toPromise<any>();

        assert.equal(updated.kept, 'restored');
        assert.equal(updated.dropped, undefined);
        assert.equal(updated.counter, 2);

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'last-action'}).toPromise();
    });

    test('prefers explicit modifiedAt values over automatic timestamps', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'explicit-timestamp', sequence: 'before', modifiedBy: 'original'})
            .toPromise();

        const updated = await new QueryBuilder(tableName, dynamoDBClient)
            .timestamps()
            .update({id: 'explicit-timestamp'})
            .with({sequence: 'after', modifiedBy: 'editor', modifiedAt: 123, item: {message: 'Updated'}})
            .where('id').exists()
            .toPromise<any>();

        assert.equal(updated.sequence, 'after');
        assert.equal(updated.modifiedBy, 'editor');
        assert.equal(updated.modifiedAt, 123);
        assert.deepEqual(updated.item, {message: 'Updated'});

        const automaticallyTimestamped = await new QueryBuilder(tableName, dynamoDBClient)
            .timestamps()
            .update({id: 'explicit-timestamp'})
            .with({sequence: 'ordered', modifiedBy: 'editor', order: null})
            .where('id').exists()
            .toPromise<any>();

        assert.equal(automaticallyTimestamped.sequence, 'ordered');
        assert.equal(automaticallyTimestamped.order, null);
        assert.equal(typeof automaticallyTimestamped.modifiedAt, 'number');
        assert.notEqual(automaticallyTimestamped.modifiedAt, 123);

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'explicit-timestamp'}).toPromise();
    });

    test('applies invitation state transitions and removes the expiry in one update', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'invitation-transition', state: 'pending', token: 'invite-token', ttl: 123, joinedAt: null})
            .toPromise();

        const accepted = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'invitation-transition'})
            .set('state').eq('active')
            .set('token').eq(null)
            .set('joinedAt').eq(456)
            .remove('ttl')
            .where('id').exists()
            .toPromise<any>();

        assert.equal(accepted.state, 'active');
        assert.equal(accepted.token, null);
        assert.equal(accepted.joinedAt, 456);
        assert.equal(accepted.ttl, undefined);

        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .update({id: 'missing-invitation-transition'})
                .set('state').eq('active')
                .remove('ttl')
                .where('id').exists()
                .toPromise()
        );
        assert.equal(
            await new QueryBuilder(tableName, dynamoDBClient).get({id: 'missing-invitation-transition'}).toPromise(),
            null
        );

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'invitation-transition'}).toPromise();
    });

    test('moves tax exemption subjects and removes optional expiry attributes', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({
                id: 'tax-exemption-transition',
                subjectType: 'account',
                account: 'account-1',
                ttl: 123,
                expiryDate: '2026-08-31'
            })
            .toPromise();

        const organizationSubject = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'tax-exemption-transition'})
            .remove('account')
            .remove('domain')
            .set('organization').eq('organization-1')
            .set('subjectType').eq('organization')
            .toPromise<any>();

        assert.equal(organizationSubject.account, undefined);
        assert.equal(organizationSubject.domain, undefined);
        assert.equal(organizationSubject.organization, 'organization-1');
        assert.equal(organizationSubject.subjectType, 'organization');

        const withoutExpiry = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'tax-exemption-transition'})
            .remove('ttl')
            .remove('expiryDate')
            .toPromise<any>();

        assert.equal(withoutExpiry.ttl, undefined);
        assert.equal(withoutExpiry.expiryDate, undefined);
        assert.equal(withoutExpiry.organization, 'organization-1');

        const domainSubject = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'tax-exemption-transition'})
            .remove('account')
            .remove('organization')
            .set('domain').eq('example.com')
            .set('subjectType').eq('domain')
            .toPromise<any>();

        assert.equal(domainSubject.account, undefined);
        assert.equal(domainSubject.organization, undefined);
        assert.equal(domainSubject.domain, 'example.com');
        assert.equal(domainSubject.subjectType, 'domain');

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'tax-exemption-transition'}).toPromise();
    });

    test('skips undefined properties when writing', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'undefined-props', kept: 1, missing: undefined})
            .toPromise();

        const stored = await new QueryBuilder(tableName, dynamoDBClient)
            .get({id: 'undefined-props'})
            .toPromise<any>();
        assert.deepEqual(stored, {id: 'undefined-props', kept: 1});

        const updated = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'undefined-props'})
            .with({kept: 2, alsoMissing: undefined})
            .toPromise<any>();
        assert.deepEqual(updated, {id: 'undefined-props', kept: 2});

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'undefined-props'}).toPromise();
    });

    test('deduplicates batch get keys', async () => {
        await new QueryBuilder(tableName, dynamoDBClient).createBatch([{id: 'dedupe-a'}, {id: 'dedupe-b'}]);

        const result = await new QueryBuilder(tableName, dynamoDBClient)
            .getBatch<any>([{id: 'dedupe-a'}, {id: 'dedupe-a'}, {id: 'dedupe-b'}]);
        assert.deepEqual(result.map((item) => item.id).sort(), ['dedupe-a', 'dedupe-b']);

        await new QueryBuilder(tableName, dynamoDBClient).deleteBatch([{id: 'dedupe-a'}, {id: 'dedupe-b'}]);
    });

    test('paginates queries with chunk and hard limits in sort order', async () => {
        const documents = Array.from({length: 6}).map((_, index) => ({id: 'paged-query', sort: index + 1, value: (index + 1) * 10}));
        await new QueryBuilder(compositeTableName, dynamoDBClient).createBatch(documents);

        const all = await new QueryBuilder(compositeTableName, dynamoDBClient)
            .query({id: 'paged-query'}).consistent()
            .limit(2, null)
            .toPromise<any[]>();
        assert.deepEqual(all.map((item) => item.sort), [1, 2, 3, 4, 5, 6]);

        const limited = await new QueryBuilder(compositeTableName, dynamoDBClient)
            .query({id: 'paged-query'}).consistent()
            .limit(2, 5)
            .toPromise<any[]>();
        assert.deepEqual(limited.map((item) => item.sort), [1, 2, 3, 4, 5]);

        const filtered = await new QueryBuilder(compositeTableName, dynamoDBClient)
            .query({id: 'paged-query'}).consistent()
            .limit(2, null)
            .where('value').gt(30)
            .toPromise<any[]>();
        assert.deepEqual(filtered.map((item) => item.sort), [4, 5, 6]);

        await new QueryBuilder(compositeTableName, dynamoDBClient)
            .deleteBatch(documents.map((document) => ({id: document.id, sort: document.sort})));
    });

    test('returns resumable pages and lazily streams typed query items', async () => {
        const schema = z.object({id: z.string(), sort: z.number(), value: z.number()}).strict();
        const table = defineTable({
            name: compositeTableName,
            schema: schema,
            key: {partition: 'id', sort: 'sort'}
        });
        const documents = Array.from({length: 5}).map((_, index) => ({
            id: 'cursor-query',
            sort: index + 1,
            value: (index + 1) * 10
        }));
        await table.using(dynamoDBClient).createBatch(documents, {concurrency: 2});

        const first = await table.using(dynamoDBClient).query({id: 'cursor-query'}).consistent().page({limit: 2});
        const second = await table.using(dynamoDBClient).query({id: 'cursor-query'}).consistent().page({limit: 2, cursor: first.cursor});
        assert.deepEqual(first.items.map((item) => item.sort), [1, 2]);
        assert.deepEqual(first.cursor, {id: 'cursor-query', sort: 2});
        assert.deepEqual(second.items.map((item) => item.sort), [3, 4]);

        const streamed: number[] = [];
        for await (const item of table.using(dynamoDBClient).query({id: 'cursor-query'}).consistent().items({limit: 2})) {
            streamed.push(item.sort);
        }
        assert.deepEqual(streamed, [1, 2, 3, 4, 5]);

        await assert.rejects(
            table.using(dynamoDBClient).query({id: 'cursor-query'}).consistent().page({cursor: {id: 'cursor-query'}}),
            (error) => error instanceof DynamoDBServiceException && error.name === 'ValidationException'
        );

        await table.using(dynamoDBClient).deleteBatch(
            documents.map((document) => ({id: document.id, sort: document.sort})),
            {concurrency: 2}
        );
    });

    test('projects typed records and counts filtered matches across DynamoDB pages', async () => {
        const schema = z.object({
            id: z.string(),
            group: z.string(),
            value: z.number(),
            payload: z.string()
        }).strict();
        const table = defineTable({name: tableName, schema: schema, key: {partition: 'id'}});
        const documents = Array.from({length: 5}).map((_, index) => ({
            id: `projection-${index}`,
            group: index < 3 ? 'selected' : 'other',
            value: index,
            payload: 'x'.repeat(1024)
        }));
        await table.using(dynamoDBClient).createBatch(documents, {concurrency: 2});

        const projected = await table.using(dynamoDBClient)
            .scan().consistent()
            .limit(2, null)
            .where('group').eq('selected')
            .select('id', 'value')
            .toPromise();
        const count = await table.using(dynamoDBClient)
            .scan().consistent()
            .limit(2, null)
            .where('group').eq('selected')
            .count()
            .toPromise();

        assert.equal(projected.length, 3);
        assert.equal(projected.every((item) => Object.keys(item).sort().join(',') === 'id,value'), true);
        assert.equal(count, 3);

        await assert.rejects(
            new QueryBuilder(`${tableName}-missing`, dynamoDBClient).scan().count().toPromise(),
            (error) => error instanceof ResourceNotFoundException
        );

        await table.using(dynamoDBClient).deleteBatch(documents.map((document) => ({id: document.id})), {concurrency: 2});
    });

    test('executes bounded batches and payload-free conditional writes', async () => {
        const documents = Array.from({length: 60}).map((_, index) => ({id: `bounded-live-${index}`, group: 'bounded-live'}));
        await new QueryBuilder(tableName, dynamoDBClient).createBatch(documents, {concurrency: 2});

        const updated = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'bounded-live-0'})
            .set('value').eq(42)
            .returningNone()
            .where('id').exists()
            .toPromise();
        assert.equal(updated, undefined);
        assert.equal((await new QueryBuilder(tableName, dynamoDBClient).get({id: 'bounded-live-0'}).consistent().toPromise<any>()).value, 42);

        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .update({id: 'bounded-live-missing'})
                .set('value').eq(1)
                .returningNone()
                .where('id').exists()
                .toPromise(),
            (error) => error instanceof ConditionalCheckFailedException
        );
        assert.equal(
            await new QueryBuilder(tableName, dynamoDBClient)
                .update({id: 'bounded-live-missing'})
                .set('value').eq(1)
                .where('id').exists()
                .toPromiseOrNull(),
            null
        );
        await assert.rejects(
            new QueryBuilder(`${tableName}-missing`, dynamoDBClient)
                .update({id: 'missing'})
                .set('value').eq(1)
                .toPromiseOrNull(),
            (error) => error instanceof ResourceNotFoundException
        );
        await assert.rejects(
            new QueryBuilder(`${tableName}-missing`, dynamoDBClient).createBatch([{id: 'missing'}], {concurrency: 2}),
            (error) => error instanceof ResourceNotFoundException
        );

        const deleted = await new QueryBuilder(tableName, dynamoDBClient)
            .delete({id: 'bounded-live-0'})
            .returningNone()
            .toPromise();
        assert.equal(deleted, undefined);
        assert.equal(await new QueryBuilder(tableName, dynamoDBClient).get({id: 'bounded-live-0'}).consistent().toPromise(), null);

        await new QueryBuilder(tableName, dynamoDBClient).deleteBatch(
            documents.slice(1).map((document) => ({id: document.id})),
            {concurrency: 2}
        );
    });

    test('queries global secondary indexes with filters', async () => {
        const documents = [
            {id: 'gsi-a', sort: 1, category: 'greeting', value: 1},
            {id: 'gsi-a', sort: 2, category: 'greeting', value: 2},
            {id: 'gsi-b', sort: 1, category: 'farewell', value: 3}
        ];
        await new QueryBuilder(compositeTableName, dynamoDBClient).createBatch(documents);

        const matched = await queryUntilCount(() => new QueryBuilder(compositeTableName, dynamoDBClient)
            .query({category: 'greeting'})
            .usingIndex('category-index')
            .toPromise<any[]>(), 2);
        assert.deepEqual(matched.map((item) => item.value).sort(), [1, 2]);

        const filtered = await new QueryBuilder(compositeTableName, dynamoDBClient)
            .query({category: 'greeting'})
            .usingIndex('category-index')
            .where('value').gt(1)
            .toPromise<any[]>();
        assert.deepEqual(filtered.map((item) => item.value), [2]);

        await new QueryBuilder(compositeTableName, dynamoDBClient)
            .deleteBatch(documents.map((document) => ({id: document.id, sort: document.sort})));
    });

    test('rejects consistent global secondary index queries before sending', () => {
        assert.throws(
            () => new QueryBuilder(compositeTableName, dynamoDBClient)
                .query({category: 'greeting'}).consistent()
                .usingIndex('category-index'),
            /Global secondary index category-index does not support consistent reads/
        );
    });

    test('paginates filtered scans across pages without matches', async () => {
        const documents = Array.from({length: 12}).map((_, index) => ({
            id: `sparse-${String(index + 1).padStart(2, '0')}`,
            marker: index === 11 ? 'target' : 'filler'
        }));
        await new QueryBuilder(tableName, dynamoDBClient).createBatch(documents);

        // Small chunks force DynamoDB to return pages where every item is filtered out.
        const matched = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .limit(2, null)
            .where('marker').eq('target')
            .toPromise<any[]>();

        assert.equal(matched.length, 1);
        assert.equal(matched[0].marker, 'target');

        await new QueryBuilder(tableName, dynamoDBClient).deleteBatch(documents.map((document) => ({id: document.id})));
    });

    test('returns previous attributes from deletes and upserts missing updates', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'delete-returns', value: 42})
            .toPromise();

        const deleted = await new QueryBuilder(tableName, dynamoDBClient)
            .delete({id: 'delete-returns'})
            .returningAllOld()
            .toPromise<any>();
        assert.deepEqual(deleted, {id: 'delete-returns', value: 42});

        const upserted = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'upsert-missing'})
            .set('value').eq(1)
            .toPromise<any>();
        assert.deepEqual(upserted, {id: 'upsert-missing', value: 1});

        const added = await new QueryBuilder(tableName, dynamoDBClient)
            .update({id: 'upsert-missing'})
            .add('counter').eq(5)
            .toPromise<any>();
        assert.equal(added.counter, 5);

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'upsert-missing'}).toPromise();
    });

    test('executes standalone condition checks', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'condition-check', state: 'active'})
            .toPromise();

        await new QueryBuilder(tableName, dynamoDBClient)
            .conditionCheck({id: 'condition-check'})
            .where('state').eq('active')
            .toPromise();

        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .conditionCheck({id: 'condition-check'})
                .where('state').eq('inactive')
                .toPromise(),
            TransactionCanceledException
        );
        await assert.rejects(
            new QueryBuilder(tableName, dynamoDBClient)
                .conditionCheck({id: 'condition-check-missing'})
                .where('id').exists()
                .toPromise(),
            TransactionCanceledException
        );

        await new QueryBuilder(tableName, dynamoDBClient).delete({id: 'condition-check'}).toPromise();
    });

    test('commits and rolls back transactional writes atomically', async () => {
        await new QueryBuilder(tableName, dynamoDBClient).createBatch([
            {id: 'transaction-guard', state: 'active'},
            {id: 'transaction-balance', credits: 2},
            {id: 'transaction-delete', state: 'draft'}
        ]);

        await QueryBuilder.transactWrite(dynamoDBClient)
            .add(tableName, (query) => query
                .conditionCheck({id: 'transaction-guard'})
                .where('state').eq('active'))
            .add(tableName, (query) => query
                .update({id: 'transaction-balance'})
                .add('credits').eq(-1)
                .where('credits').gte(1))
            .add(tableName, (query) => query
                .delete({id: 'transaction-delete'})
                .where('state').eq('draft'))
            .add(compositeTableName, (query) => query
                .create({id: 'transaction-created', sort: 1, state: 'complete'})
                .where('id').not().exists())
            .toPromise();

        assert.equal(
            (await new QueryBuilder(tableName, dynamoDBClient).get({id: 'transaction-balance'}).toPromise<any>()).credits,
            1
        );
        assert.equal(
            await new QueryBuilder(tableName, dynamoDBClient).get({id: 'transaction-delete'}).toPromise(),
            null
        );
        assert.ok(await new QueryBuilder(compositeTableName, dynamoDBClient)
            .get({id: 'transaction-created', sort: 1})
            .toPromise());

        await assert.rejects(
            QueryBuilder.transactWrite(dynamoDBClient)
                .add(tableName, (query) => query
                    .conditionCheck({id: 'transaction-guard'})
                    .where('state').eq('inactive'), {returnValuesOnConditionCheckFailure: 'ALL_OLD'})
                .add(tableName, (query) => query.create({id: 'transaction-rolled-back'}))
                .toPromise(),
            TransactionCanceledException
        );
        assert.equal(
            await new QueryBuilder(tableName, dynamoDBClient).get({id: 'transaction-rolled-back'}).toPromise(),
            null
        );

        await new QueryBuilder(tableName, dynamoDBClient).deleteBatch([
            {id: 'transaction-guard'},
            {id: 'transaction-balance'}
        ]);
        await new QueryBuilder(compositeTableName, dynamoDBClient)
            .delete({id: 'transaction-created', sort: 1})
            .toPromise();
    });

    test('rejects transactions targeting the same item twice without applying changes', async () => {
        await new QueryBuilder(tableName, dynamoDBClient)
            .create({id: 'transaction-duplicate', value: 1})
            .toPromise();

        await assert.rejects(
            QueryBuilder.transactWrite(dynamoDBClient)
                .add(tableName, (query) => query
                    .update({id: 'transaction-duplicate'})
                    .set('value').eq(2))
                .add(tableName, (query) => query
                    .delete({id: 'transaction-duplicate'}))
                .toPromise(),
            (error: unknown) => error instanceof DynamoDBServiceException && error.name === 'ValidationException'
        );

        assert.deepEqual(
            await new QueryBuilder(tableName, dynamoDBClient)
                .get({id: 'transaction-duplicate'})
                .toPromise(),
            {id: 'transaction-duplicate', value: 1}
        );
        await new QueryBuilder(tableName, dynamoDBClient)
            .delete({id: 'transaction-duplicate'})
            .toPromise();
    });

    test('compares complex values by DynamoDB type, list position and map/set membership', async (context) => {
        const binary = (bytes: number[]) => new Uint8Array(bytes);
        const rows: Array<{label: string; value: unknown; equal: unknown; different: unknown}> = [
            {label: 'singleton', value: ['val'], equal: ['val'], different: 'val'},
            {label: 'ordered', value: ['a', 'b'], equal: ['a', 'b'], different: ['b', 'a']},
            {label: 'length', value: ['a'], equal: ['a'], different: ['a', 'a']},
            {label: 'duplicates', value: ['a', 'a', 'b'], equal: ['a', 'a', 'b'], different: ['a', 'b', 'b']},
            {label: 'empty-list', value: [], equal: [], different: {}},
            {label: 'nested-list', value: [{a: [1, 2]}, null, true], equal: [{a: [1, 2]}, null, true], different: [{a: [2, 1]}, null, true]},
            {label: 'mixed-list', value: [1, '1', false], equal: [1, '1', false], different: ['1', 1, false]},
            {label: 'map-order', value: {a: 1, b: [2]}, equal: {b: [2], a: 1}, different: {a: 1}},
            {label: 'map-extra', value: {a: 1}, equal: {a: 1}, different: {a: 1, b: 2}},
            {label: 'empty-map', value: {}, equal: {}, different: []},
            {label: 'string-set', value: new Set(['a', 'b']), equal: new Set(['b', 'a']), different: ['a', 'b']},
            {label: 'number-set', value: new Set([1, 2]), equal: new Set([2, 1]), different: new Set([1, 3])},
            {label: 'binary-set', value: new Set([Buffer.from([1, 2]), Buffer.from([3])]),
                equal: new Set([binary([3]), binary([1, 2])]), different: new Set([binary([1])])},
            {label: 'boolean', value: true, equal: true, different: 1},
            {label: 'null', value: null, equal: null, different: false},
            {label: 'number', value: 1, equal: 1, different: '1'},
            {label: 'empty-string', value: '', equal: '', different: null},
            {label: 'binary', value: Buffer.from([1, 2]), equal: binary([1, 2]), different: binary([2, 1])},
            {label: 'empty-binary', value: Buffer.alloc(0), equal: binary([]), different: ''}
        ];
        const documents = rows.map((row) => ({id: `matrix-${row.label}`, value: row.value}));
        context.after(() => new QueryBuilder(tableName, dynamoDBClient).deleteBatch(documents.map(({id}) => ({id}))));
        await new QueryBuilder(tableName, dynamoDBClient).createBatch(documents);
        for (const row of rows) {
            const id = `matrix-${row.label}`;
            const comparison = () => new QueryBuilder(tableName, dynamoDBClient).scan().consistent().where('id').eq(id).where('value');
            assert.equal((await comparison().eq(row.equal).toPromise<any[]>()).length, 1, row.label);
            assert.equal((await comparison().eq(row.different).toPromise<any[]>()).length, 0, row.label);
            assert.equal((await comparison().ne(row.equal).toPromise<any[]>()).length, 0, row.label);
            assert.equal((await comparison().ne(row.different).toPromise<any[]>()).length, 1, row.label);
            assert.equal((await comparison().in([row.different, row.equal]).toPromise<any[]>()).length, 1, row.label);
            assert.equal((await comparison().not().in([row.equal]).toPromise<any[]>()).length, 0, row.label);
        }
    });

    test('executes complex membership, literal-name conditions and atomic condition checks', async (context) => {
        const id = 'complex-membership';
        const document = {
            id, list: ['a', {x: [1, 2]}, [3, 4], null, true, Buffer.from([5]), new Set(['x', 'y'])],
            tags: new Set(['a', 'b']), numbers: new Set([1, 2]), bytes: new Set([Buffer.from([5])]),
            'odd.name': {b: 2, a: [1, 2]}, 'odd-name': 'substring', text: 'full-value'
        };
        const query = () => new QueryBuilder(tableName, dynamoDBClient);
        context.after(() => query().deleteBatch([{id}, {id: 'complex-marker'}, {id: 'missing-value'}]));
        await query().create(document).toPromise();
        for (const value of ['a', {x: [1, 2]}, [3, 4], null, true, new Uint8Array([5]), new Set(['y', 'x'])]) {
            const matched = await query().scan().consistent().where('id').eq(id).where('list').contains(value).toPromise<any[]>();
            assert.equal(matched.length, 1);
        }
        for (const value of [{x: [2, 1]}, [4, 3], new Uint8Array([6])]) {
            assert.equal((await query().scan().consistent().where('id').eq(id).where('list').contains(value).toPromise<any[]>()).length, 0);
        }
        for (const [field, value] of [['tags', 'a'], ['numbers', 2], ['bytes', new Uint8Array([5])], ['text', 'val']] as const) {
            assert.equal((await query().scan().consistent().where('id').eq(id).where(field).contains(value).toPromise<any[]>()).length, 1);
        }
        await query().update({id}).set('odd-name').eq('updated')
            .where('odd.name').eq({a: [1, 2], b: 2}).where('bytes').contains(new Uint8Array([5])).toPromise();
        await assert.rejects(query().delete({id}).where('odd.name').eq({a: [2, 1], b: 2}).toPromise(), ConditionalCheckFailedException);
        await QueryBuilder.transactWrite(dynamoDBClient)
            .add(tableName, (builder) => builder.conditionCheck({id}).where('odd.name').eq({a: [1, 2], b: 2}))
            .add(tableName, (builder) => builder.create({id: 'complex-marker'})).toPromise();
        assert.deepEqual(await query().get({id}).consistent().select('odd.name', 'odd-name').toPromise(), {
            'odd.name': {a: [1, 2], b: 2}, 'odd-name': 'updated'
        });
        await query().update({id}).add('bytes').eq(new Set([new Uint8Array([5]), new Uint8Array([6])])).toPromise();
        const added = await query().get({id}).consistent().toPromise<{bytes: Set<Uint8Array>}>();
        assert.equal(added.bytes.size, 2);
        await query().update({id}).delete('bytes').eq(new Set([new Uint8Array([5])])).toPromise();
        assert.equal((await query().scan().consistent().where('id').eq(id).where('bytes').contains(new Uint8Array([5])).toPromise<any[]>()).length, 0);
        await query().create({id: 'missing-value'}).toPromise();
        const missing = () => query().scan().consistent().where('id').eq('missing-value').where('absent');
        assert.equal((await missing().eq(null).toPromise<any[]>()).length, 0);
        assert.equal((await missing().ne(null).toPromise<any[]>()).length, 1);
        assert.equal((await missing().not().eq(null).toPromise<any[]>()).length, 1);
        await QueryBuilder.transactWrite(dynamoDBClient)
            .add(tableName, (builder) => builder.conditionCheck({id: 'missing-value'}).where('absent').not().exists()).toPromise();
    });

    test('distinguishes missing attributes from null in equality, inequality and negated comparisons', async (context) => {
        const query = () => new QueryBuilder(tableName, dynamoDBClient);
        const missingId = 'missing-inequality';
        const nullId = 'null-inequality';
        context.after(() => query().deleteBatch([{id: missingId}, {id: nullId}]));
        await query().createBatch([{id: missingId, count: 0}, {id: nullId, value: null}]);
        const operands = [null, 'value', 1, false, new Uint8Array([1]), [], {nested: [1]}, new Set(['value'])];
        const comparison = (id: string) => query().scan().consistent().where('id').eq(id).where('value');
        for (const value of operands) {
            const label = JSON.stringify(QuerySerializer.serialiseItem(value));
            assert.equal((await comparison(missingId).eq(value).toPromise<any[]>()).length, 0, `missing = ${label}`);
            assert.equal((await comparison(missingId).ne(value).toPromise<any[]>()).length, 1, `missing <> ${label}`);
            assert.equal((await comparison(missingId).not().eq(value).toPromise<any[]>()).length, 1, `NOT missing = ${label}`);
            assert.equal((await comparison(missingId).not().ne(value).toPromise<any[]>()).length, 0, `NOT missing <> ${label}`);
            assert.equal((await comparison(missingId).in([value]).toPromise<any[]>()).length, 0, `missing IN ${label}`);
            assert.equal((await comparison(missingId).not().in([value]).toPromise<any[]>()).length, 1, `NOT missing IN ${label}`);
            assert.equal((await comparison(nullId).eq(value).toPromise<any[]>()).length, value === null ? 1 : 0, `null = ${label}`);
            assert.equal((await comparison(nullId).ne(value).toPromise<any[]>()).length, value === null ? 0 : 1, `null <> ${label}`);
            await query().update({id: missingId}).add('count').eq(1).where('value').ne(value).toPromise();
            await assert.rejects(query().update({id: missingId}).add('count').eq(1).where('value').not().ne(value).toPromise(),
                ConditionalCheckFailedException);
        }
        assert.deepEqual(await query().get({id: missingId}).consistent().toPromise(), {id: missingId, count: operands.length});
        await query().conditionCheck({id: missingId}).where('value').ne(null).toPromise();
        await assert.rejects(query().conditionCheck({id: nullId}).where('value').ne(null).toPromise(), TransactionCanceledException);
        await QueryBuilder.transactWrite(dynamoDBClient)
            .add(tableName, (builder) => builder.conditionCheck({id: missingId}).where('value').ne(null))
            .add(tableName, (builder) => builder.update({id: nullId}).set('checked').eq(true).where('value').eq(null)).toPromise();
        await assert.rejects(query().delete({id: nullId}).where('value').ne(null).toPromise(), ConditionalCheckFailedException);
        await query().delete({id: missingId}).where('value').ne(null).toPromise();
        assert.equal(await query().get({id: missingId}).consistent().toPromise(), null);
        await query().create({id: missingId}).where('value').ne(null).toPromise();
        assert.deepEqual(await query().get({id: missingId}).consistent().toPromise(), {id: missingId});
    });

    test('validates present secondary-index key data before writes without mutating records', async (context) => {
        const query = () => new QueryBuilder(compositeTableName, dynamoDBClient);
        const key = {id: 'index-key-validation', sort: 1};
        context.after(() => query().deleteBatch([key, {id: 'invalid-index', sort: 1}, {id: 'batch-marker', sort: 1}, {id: 'transaction-marker', sort: 1}]));
        await query().create({...key, category: 'valid', value: 1}).toPromise();
        const invalid = (error: unknown) => error instanceof DynamoDBServiceException
            && (error.name === 'ValidationException' || error.name === 'TransactionCanceledException');
        for (const category of [null, '', 1, [], new Uint8Array()]) {
            await assert.rejects(query().create({...key, category}).toPromise(), invalid);
            await assert.rejects(query().update(key).set('category').eq(category).toPromise(), invalid);
            assert.deepEqual(await query().get(key).consistent().toPromise(), {...key, category: 'valid', value: 1});
        }
        await assert.rejects(query().createBatch([{id: 'batch-marker', sort: 1}, {id: 'invalid-index', sort: 1, category: 1}]), invalid);
        assert.equal(await query().get({id: 'batch-marker', sort: 1}).consistent().toPromise(), null);
        await assert.rejects(QueryBuilder.transactWrite(dynamoDBClient)
            .add(compositeTableName, (builder) => builder.create({id: 'transaction-marker', sort: 1}))
            .add(compositeTableName, (builder) => builder.update(key).set('category').eq(null)).toPromise(), invalid);
        assert.equal(await query().get({id: 'transaction-marker', sort: 1}).consistent().toPromise(), null);
        assert.deepEqual(await query().get(key).consistent().toPromise(), {...key, category: 'valid', value: 1});
    });

    test('orders scalar sort keys and filter ranges by numeric, UTF-8 and unsigned binary values', async (context) => {
        const cases: Array<{kind: 'S' | 'N' | 'B'; values: Array<string | number | Uint8Array>}> = [
            {kind: 'N', values: [-10, -2, 1, 10]},
            {kind: 'S', values: ['A', '\uE000', '\u{10000}', '\u{10000}x']},
            {kind: 'B', values: [Buffer.from([0]), Buffer.from([0, 255]), Buffer.from([1]), Buffer.from([255])]}
        ];
        const normalise = (value: unknown) => value instanceof Uint8Array ? Array.from(value) : value;
        for (const {kind, values} of cases) {
            const name = `query-builder-order-${kind.toLowerCase()}-${suffix}`;
            await QueryBuilder.createTable({name, key: {partition: 'id', sort: 'sort'}, attributes: {id: 'S', sort: kind}, indexes: {}}, dynamoDBClient);
            context.after(async () => {
                await QueryBuilder.deleteTable(name, dynamoDBClient);
                await waitUntilTableNotExists({client: dynamoDBClient, maxWaitTime: 60}, {TableName: name});
            });
            await waitUntilTableExists({client: dynamoDBClient, maxWaitTime: 60}, {TableName: name});
            const query = () => new QueryBuilder(name, dynamoDBClient);
            await query().createBatch([...values].reverse().map((sort) => ({id: 'p', sort, value: sort})));
            const read = () => query().query({id: 'p'}).consistent();
            const sorts = (items: Array<{sort: unknown}>) => items.map((item) => normalise(item.sort));
            const expected = values.map(normalise);
            assert.deepEqual(sorts(await read().limit(1, null).toPromise<any[]>()), expected);
            assert.deepEqual(sorts(await read().descending().limit(1, null).toPromise<any[]>()), [...expected].reverse());
            for (const [operator, indices] of [['eq', [1]], ['gt', [2, 3]], ['gte', [1, 2, 3]], ['lt', [0]], ['lte', [0, 1]]] as const) {
                const keyComparison = read().sortKey('sort');
                assert.deepEqual(sorts(await keyComparison[operator](values[1]).toPromise<any[]>()), indices.map((index) => expected[index]));
                const filterComparison = read().where('value');
                assert.deepEqual(sorts(await filterComparison[operator](values[1]).toPromise<any[]>()), indices.map((index) => expected[index]));
            }
            assert.deepEqual(sorts(await read().sortKey('sort').between(values[1], values[2]).toPromise<any[]>()), expected.slice(1, 3));
            if (kind !== 'N') {
                const prefix = kind === 'S' ? '\u{10000}' : new Uint8Array([0]);
                const matches = kind === 'S' ? expected.slice(2) : expected.slice(0, 2);
                assert.deepEqual(sorts(await read().sortKey('sort').beginsWith(prefix).toPromise<any[]>()), matches);
            }
            const pages = read().descending().pages<any>({limit: 1});
            const streamed: unknown[] = [];
            for await (const page of pages) streamed.push(...sorts(page.items));
            assert.deepEqual(streamed, [...expected].reverse());
        }
    });

    test('maintains sparse index entry/exit and complete cursors with duplicate index values', async (context) => {
        const name = `query-builder-index-cursors-${suffix}`;
        await QueryBuilder.createTable({
            name, key: {partition: 'id'}, attributes: {id: 'S', category: 'S', rank: 'N'},
            indexes: {category: {kind: 'global', partition: 'category', sort: 'rank',
                projection: {type: 'INCLUDE', nonKeyAttributes: ['value']}}}
        }, dynamoDBClient);
        context.after(async () => {
            await QueryBuilder.deleteTable(name, dynamoDBClient);
            await waitUntilTableNotExists({client: dynamoDBClient, maxWaitTime: 60}, {TableName: name});
        });
        await waitUntilTableExists({client: dynamoDBClient, maxWaitTime: 60}, {TableName: name});
        const query = () => new QueryBuilder(name, dynamoDBClient);
        const documents = [
            {id: 'a', category: 'c', rank: 1, value: 10, secret: true},
            {id: 'b', category: 'c', rank: 1, value: 20, secret: true},
            {id: 'c', category: 'c', rank: 2, value: 30},
            {id: 'd', category: 'c', rank: 3, value: 40},
            {id: 'missing-sort', category: 'c', value: 50},
            {id: 'missing-partition', rank: 4, value: 60}
        ];
        await query().createBatch(documents);
        const read = () => query().query({category: 'c'}).usingIndex('category');
        await queryUntilCount(() => read().toPromise<any[]>(), 4);
        const scan = () => query().scan().usingIndex('category');
        assert.deepEqual((await queryUntilCount(() => scan().toPromise<any[]>(), 4)).map(item => item.id).sort(), ['a', 'b', 'c', 'd']);
        const scanIds: string[] = [];
        for await (const page of scan().where('category').eq('c').select('id').pages<any>({limit: 1})) {
            scanIds.push(...page.items.map(item => item.id));
            if (page.cursor !== null) assert.deepEqual(Object.keys(page.cursor).sort(), ['category', 'id', 'rank']);
        }
        assert.deepEqual(scanIds.sort(), ['a', 'b', 'c', 'd']);
        assert.equal(await scan().where('rank').gte(2).count().toPromise(), 2);
        assert.equal((await scan().limit(1, 2).toResponse<any[]>()).value.length, 2);
        const filtered: string[] = [];
        for await (const page of scan().where('value').gte(30).pages<any>({limit: 1})) filtered.push(...page.items.map(item => item.id));
        assert.deepEqual(filtered.sort(), ['c', 'd']);
        const empty = await scan().where('value').gt(100).page<any>({limit: 1});
        assert.deepEqual(empty.items, []);
        assert.ok(empty.cursor);
        const segments: string[] = [];
        for (let segment = 0; segment < 3; segment++) {
            for await (const page of scan().parallel(segment, 3).pages<any>({limit: 1})) segments.push(...page.items.map(item => item.id));
        }
        assert.deepEqual(segments.sort(), ['a', 'b', 'c', 'd']);
        assert.equal(new Set(segments).size, 4);
        const streamed: string[] = [];
        for await (const item of scan().items<any>({limit: 1})) streamed.push(item.id);
        assert.deepEqual(streamed.sort(), ['a', 'b', 'c', 'd']);
        assert.throws(() => query().scan().consistent().usingIndex('category'), /consistent reads/);
        assert.throws(() => scan().consistent(), /consistent reads/);
        for (const descending of [false, true]) {
            const seen: string[] = [];
            const ranks: number[] = [];
            let cursor = null;
            do {
                const chain = descending ? read().descending() : read();
                const page: {items: Array<{id: string; rank: number; secret?: boolean}>; cursor: Record<string, any> | null}
                    = await chain.page({limit: 1, cursor});
                for (const item of page.items) {
                    assert.equal(item.secret, undefined);
                    seen.push(item.id);
                    ranks.push(item.rank);
                }
                cursor = page.cursor;
                if (cursor !== null) assert.deepEqual(Object.keys(cursor).sort(), ['category', 'id', 'rank']);
            } while (cursor !== null);
            assert.deepEqual([...seen].sort(), ['a', 'b', 'c', 'd']);
            assert.equal(new Set(seen).size, 4);
            assert.deepEqual(ranks, descending ? [3, 2, 1, 1] : [1, 1, 2, 3]);
        }
        const first = await read().page<any>({limit: 1});
        await assert.rejects(read().page({limit: 1, cursor: {id: first.items[0].id}}),
            (error: unknown) => error instanceof DynamoDBServiceException && error.name === 'ValidationException');
        assert.deepEqual((await read().select('id').where('value').gte(30).toPromise<any[]>()).map((item) => item.id), ['c', 'd']);
        await query().update({id: 'missing-sort'}).set('rank').eq(4).toPromise();
        assert.equal((await queryUntilCount(() => read().toPromise<any[]>(), 5)).length, 5);
        await query().update({id: 'missing-partition'}).set('category').eq('c').toPromise();
        assert.equal((await queryUntilCount(() => read().toPromise<any[]>(), 6)).length, 6);
        await query().update({id: 'a'}).remove('category').toPromise();
        assert.equal((await queryUntilCount(() => read().toPromise<any[]>(), 5)).length, 5);
        await query().update({id: 'b'}).remove('rank').toPromise();
        assert.equal((await queryUntilCount(() => read().toPromise<any[]>(), 4)).length, 4);
    });

    test('continues through multiple empty filtered query pages and a terminal empty page', async (context) => {
        const documents = Array.from({length: 6}, (_, sort) => ({id: 'empty-page-matrix', sort, value: sort}));
        const query = () => new QueryBuilder(compositeTableName, dynamoDBClient);
        context.after(() => query().deleteBatch(documents.map(({id, sort}) => ({id, sort}))));
        await query().createBatch(documents);
        const read = () => query().query({id: 'empty-page-matrix'}).consistent().select('sort').where('value').eq(3);
        const pages = [];
        for await (const page of read().pages<{sort: number}>({limit: 1})) pages.push(page);
        assert.deepEqual(pages.flatMap((page) => page.items), [{sort: 3}]);
        assert.equal(pages.length >= 6, true);
        assert.equal(pages.slice(0, 3).every((page) => page.items.length === 0 && page.cursor !== null), true);
        assert.deepEqual(pages.at(-1), {items: [], cursor: null});
        assert.deepEqual(await read().toPromise(), [{sort: 3}]);
        const items = [];
        for await (const item of read().items()) items.push(item);
        assert.deepEqual(items, [{sort: 3}]);
    });

    test('covers every matching record once across parallel scan segments and continuations', async (context) => {
        const query = () => new QueryBuilder(tableName, dynamoDBClient);
        const documents = Array.from({length: 9}, (_, index) => ({id: `parallel-contract-${index}`, scope: 'parallel-contract'}));
        context.after(() => query().deleteBatch(documents.map(({id}) => ({id}))));
        await query().createBatch(documents);
        const results = await Promise.all(Array.from({length: 3}, async (_, segment) => {
            const ids: string[] = [];
            for await (const page of query().scan().consistent().parallel(segment, 3).select('id')
                .where('scope').eq('parallel-contract').pages<{id: string}>({limit: 1})) {
                ids.push(...page.items.map((item) => item.id));
            }
            return ids;
        }));
        assert.deepEqual(results.flat().sort(), documents.map((document) => document.id).sort());
        assert.equal(new Set(results.flat()).size, documents.length);
    });

    test('filters scans by set membership', async () => {
        await new QueryBuilder(tableName, dynamoDBClient).createBatch([
            {id: 'tags-a', tags: new Set(['red', 'blue'])},
            {id: 'tags-b', tags: new Set(['green'])}
        ]);

        const matched = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('tags').contains('red')
            .toPromise<any[]>();
        assert.deepEqual(matched.map((item) => item.id), ['tags-a']);

        const excluded = await new QueryBuilder(tableName, dynamoDBClient)
            .scan()
            .where('tags').not().contains('red')
            .toPromise<any[]>();
        assert.deepEqual(excluded.map((item) => item.id), ['tags-b']);

        await new QueryBuilder(tableName, dynamoDBClient).deleteBatch([{id: 'tags-a'}, {id: 'tags-b'}]);
    });

    test('handles large queued batch writes, reads, and deletes', async () => {
        const documents = Array.from({length: 101}).map((_, index) => ({id: `large-${index}`, value: index}));

        const created = await new QueryBuilder(tableName, dynamoDBClient).createBatch<any>(documents, true);
        assert.equal(created.length, 101);

        const fetched = await new QueryBuilder(tableName, dynamoDBClient)
            .getBatch<any>(documents.map((document) => ({id: document.id})), true);
        assert.equal(fetched.length, 101);
        assert.deepEqual(
            fetched.map((item) => item.id).sort(),
            documents.map((item) => item.id).sort()
        );

        await new QueryBuilder(tableName, dynamoDBClient)
            .deleteBatch(documents.map((document) => ({id: document.id})), true);
        const remaining = await new QueryBuilder(tableName, dynamoDBClient).scan().toPromise<any[]>();
        assert.deepEqual(remaining, []);
    });

    test('does not share mutable returned values with stored records', async () => {
        const query = () => new QueryBuilder(tableName, dynamoDBClient);
        await query().create({id: 'isolated-values', stale: true}).toPromise();
        await query().create({id: 'isolated-values', value: 1}).toPromise();
        const updated = await query().update({id: 'isolated-values'})
            .with({nested: {value: 3}}).toPromise<{nested: {value: number}}>();
        updated.nested.value = 99;
        assert.deepEqual(await query().get({id: 'isolated-values'}).consistent().toPromise(), {
            id: 'isolated-values', value: 1, nested: {value: 3}
        });
        await query().delete({id: 'isolated-values'}).toPromise();
    });

    test('rolls back earlier transaction writes and returns conditional diagnostics', async () => {
        const query = () => new QueryBuilder(tableName, dynamoDBClient);
        await query().create({id: 'diagnostic-balance', value: 1}).toPromise();
        await assert.rejects(QueryBuilder.transactWrite(dynamoDBClient)
            .add(compositeTableName, (builder) => builder.create({id: 'diagnostic-order', sort: 1}))
            .add(tableName, (builder) => builder.update({id: 'diagnostic-balance'})
                .add('value').eq(-2).where('value').gte(2), {returnValuesOnConditionCheckFailure: 'ALL_OLD'})
            .toPromise(), (error: unknown) => {
                assert.ok(error instanceof TransactionCanceledException);
                assert.deepEqual(error.CancellationReasons!.map((reason) => reason.Code), ['None', 'ConditionalCheckFailed']);
                assert.deepEqual(error.CancellationReasons![1].Item, {id: {S: 'diagnostic-balance'}, value: {N: '1'}});
                return true;
            });
        assert.equal(await new QueryBuilder(compositeTableName, dynamoDBClient)
            .get({id: 'diagnostic-order', sort: 1}).consistent().toPromise(), null);
        assert.deepEqual(await query().get({id: 'diagnostic-balance'}).consistent().toPromise(), {id: 'diagnostic-balance', value: 1});
        await query().delete({id: 'diagnostic-balance'}).toPromise();
    });

    test('prevents concurrent overspending with typed transactions', async () => {
        const definition = defineTable({name: tableName, schema: z.object({id: z.string(), value: z.number()}), key: {partition: 'id'}});
        const records = definition.using(dynamoDBClient);
        await records.create({id: 'concurrent-balance', value: 1}).toPromise();
        const spend = () => typedTransaction(dynamoDBClient).add(definition,
            (builder) => builder.update({id: 'concurrent-balance'}).add('value').eq(-1).where('value').gte(1)).toPromise();
        const results = await Promise.allSettled([spend(), spend()]);
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        const rejected = results.find((result) => result.status === 'rejected');
        assert.ok(rejected !== undefined && rejected.status === 'rejected');
        assert.ok(rejected.reason instanceof TransactionCanceledException);
        assert.deepEqual(await records.get({id: 'concurrent-balance'}).consistent().toPromise(), {id: 'concurrent-balance', value: 0});
        await records.delete({id: 'concurrent-balance'}).toPromise();
    });

    test('deduplicates transaction request tokens and rejects changed payloads', async () => {
        const query = () => new QueryBuilder(tableName, dynamoDBClient);
        await query().create({id: 'idempotent-counter', value: 0}).toPromise();
        const token = `query-${suffix}`;
        const increment = (amount: number) => QueryBuilder.transactWrite(dynamoDBClient).clientRequestToken(token)
            .add(tableName, (builder) => builder.update({id: 'idempotent-counter'}).add('value').eq(amount)).toPromise();
        await increment(1);
        await increment(1);
        await assert.rejects(increment(2), {name: 'IdempotentParameterMismatchException'});
        assert.deepEqual(await query().get({id: 'idempotent-counter'}).consistent().toPromise(), {id: 'idempotent-counter', value: 1});
        await query().delete({id: 'idempotent-counter'}).toPromise();
    });
});
