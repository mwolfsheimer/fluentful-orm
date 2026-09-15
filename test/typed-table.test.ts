import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {ConditionalCheckFailedException} from '@aws-sdk/client-dynamodb';
import type {ConditionalWriteResult, DynamoResponse} from '../src/index';
import {z} from 'zod';

test('exposes typed fluent request options and metadata responses', async () => {
    const fake = createFakeDynamoDB((command) => {
        if (command.input.Item) {
            return {
                Attributes: QuerySerializer.serialiseMap({id: 'item', category: 'news', value: 1}),
                ConsumedCapacity: {TableName: 'typed-records', CapacityUnits: 1}
            };
        }
        return {Items: [], ConsumedCapacity: {TableName: 'typed-records', CapacityUnits: 1}};
    });
    const records = createTestTable().using(fake.db);

    const response = await records
        .query({id: 'item'})
        .descending()
        .returnCapacity('TOTAL')
        .toResponse();
    const previous = await records
        .create({id: 'item', category: 'news', value: 2})
        .returningAllOld()
        .returnItemCollectionMetrics()
        .toPromise();
    await records.scan().parallel(0, 2).consistent().toPromise();

    assert.deepEqual(response.value, []);
    assert.equal(response.consumedCapacity.length, 1);
    assert.deepEqual(previous, {id: 'item', category: 'news', value: 1});
    assert.equal(fake.inputs[0].ScanIndexForward, false);
    assert.equal(fake.inputs[0].ReturnConsumedCapacity, 'TOTAL');
    assert.equal(fake.inputs[1].ReturnValues, 'ALL_OLD');
    assert.equal(fake.inputs[1].ReturnItemCollectionMetrics, 'SIZE');
    assert.equal(fake.inputs[2].Segment, 0);
    assert.equal(fake.inputs[2].TotalSegments, 2);
    assert.equal(fake.inputs[2].ConsistentRead, true);
});
import {QuerySerializer} from '../src/query-serializer';
import {defineTable, typedTransaction} from '../src/typed-table';
import {createFakeDynamoDB} from './fake-dynamodb';

const recordSchema = z.object({
    id: z.string().min(1),
    category: z.string().min(1),
    value: z.number().int().nonnegative(),
    label: z.string().optional(),
    tags: z.set(z.string()).optional(),
    labels: z.array(z.string()).optional()
}).strict();

type TestRecord = z.infer<typeof recordSchema>;

function createTestTable() {
    return defineTable({
        name: 'typed-records',
        schema: recordSchema,
        key: {partition: 'id'},
        indexes: {
            category: {kind: 'global', partition: 'category'},
            value: {kind: 'global', partition: 'value'}
        }
    });
}

describe('query - TypedTable', () => {
    test('infers typed results and keeps success and failure return options independent', async () => {
        const record: TestRecord = {id: 'result', category: 'news', value: 2};
        const fake = createFakeDynamoDB((command) => command.input.ReturnValues === 'NONE'
            ? {} : {Attributes: QuerySerializer.serialiseMap(record)});
        const records = createTestTable().using(fake.db);
        const created: Promise<ConditionalWriteResult<TestRecord, TestRecord>> = records.create(record)
            .where('id').not().exists().onConditionFailure().returningAllOld().toResult();
        const updated: Promise<ConditionalWriteResult<TestRecord | null, TestRecord>> = records.update({id: record.id})
            .with({value: 2}).where('value').lt(10).onConditionFailure().returningAllOld().toResult();
        const silentUpdate: Promise<ConditionalWriteResult<void, TestRecord>> = records.update({id: record.id})
            .set('value').eq(2).returningNone().onConditionFailure().returningAllOld()
            .add('value').eq(1).where('value').lt(10).toResult();
        const silentDelete: Promise<ConditionalWriteResult<void, TestRecord>> = records.delete({id: record.id})
            .onConditionFailure().returningAllOld().returningNone().where('value').eq(2).toResult();
        const restoredUpdate: Promise<ConditionalWriteResult<TestRecord | null, TestRecord>> = records.update({id: record.id})
            .set('value').eq(2).returningNone().onConditionFailure().returningNone().returningAllNew().toResult();
        const restoredDelete: Promise<ConditionalWriteResult<TestRecord | null, TestRecord>> = records.delete({id: record.id})
            .returningNone().onConditionFailure().returningNone().returningAllOld().toResult();

        assert.deepEqual(await created, {applied: true, value: record});
        assert.deepEqual(await updated, {applied: true, value: record});
        assert.deepEqual(await silentUpdate, {applied: true, value: undefined});
        assert.deepEqual(await silentDelete, {applied: true, value: undefined});
        assert.deepEqual(await restoredUpdate, {applied: true, value: record});
        assert.deepEqual(await restoredDelete, {applied: true, value: record});
        assert.deepEqual(fake.inputs.map((input) => input.ReturnValuesOnConditionCheckFailure),
            ['ALL_OLD', 'ALL_OLD', 'ALL_OLD', 'ALL_OLD', 'NONE', 'NONE']);

        if (false) {
            // @ts-expect-error Typed results infer their types from the schema, not caller assertions.
            records.create(record).toResult<string>();
            // @ts-expect-error Silent successful writes do not contain a record.
            const invalid: Promise<ConditionalWriteResult<TestRecord, TestRecord>> = records.delete({id: record.id}).returningNone().toResult();
            // @ts-expect-error Failure options do not accept updated-item payloads.
            records.delete({id: record.id}).onConditionFailure().returningAllNew();
            // @ts-expect-error Reads do not expose conditional write results.
            records.get({id: record.id}).toResult();
            // @ts-expect-error Standalone condition checks retain transaction error semantics.
            records.conditionCheck({id: record.id}).where('id').exists().onConditionFailure().returningAllOld().toResult();
        }
    });

    test('validates and caches previous typed records across fluent wrappers and terminal methods', async () => {
        let parses = 0;
        const table = defineTable({
            name: 'transformed-results',
            schema: z.object({id: z.string(), value: z.number().transform((value) => { parses++; return value + 1; })}),
            key: {partition: 'id'}
        });
        const failure = new ConditionalCheckFailedException({$metadata: {}, message: 'Conflict',
            Item: QuerySerializer.serialiseMap({id: 'result', value: 1})});
        const fake = createFakeDynamoDB(() => { throw failure; });
        const write = table.using(fake.db).update({id: 'result'}).remove('value')
            .where('id').exists().onConditionFailure().returningAllOld();
        const first = write.toResult();
        const rewrapped = write.onConditionFailure().returningAllOld();
        assert.strictEqual(first, rewrapped.toResult());
        const result = await first;
        assert.deepEqual(result, {applied: false, previous: {id: 'result', value: 2}});
        if (!result.applied && result.previous !== null) {
            const value: number = result.previous.value;
            assert.equal(value, 2);
        }
        await assert.rejects(write.toPromise(), (error) => error === failure);
        assert.equal(await write.toPromiseOrNull(), null);
        assert.equal(parses, 1);
        assert.equal(fake.inputs.length, 1);
    });

    test('typed toResult rejects malformed success and failure records without swallowing infrastructure errors', async () => {
        for (const operation of ['create', 'update', 'delete'] as const) {
            const record = {id: 'result', category: 'news', value: 1};
            const invalidRecord = {...record, value: 'invalid'};
            const serviceError = new Error('Service unavailable');
            for (const outcome of ['invalid-previous', 'service-error'] as const) {
                const fake = createFakeDynamoDB(() => {
                    if (outcome === 'service-error') {
                        throw serviceError;
                    }
                    throw new ConditionalCheckFailedException({$metadata: {}, message: 'Conflict',
                        Item: QuerySerializer.serialiseMap(invalidRecord)});
                });
                const records = createTestTable().using(fake.db);
                const write = operation === 'create' ? records.create(record)
                    : operation === 'update' ? records.update({id: record.id}).set('value').eq(2)
                        : records.delete({id: record.id});
                const result = write.onConditionFailure().returningAllOld().toResult();
                await assert.rejects(result, (error) => outcome === 'service-error' ? error === serviceError : error instanceof z.ZodError);
                assert.strictEqual(write.toResult(), result);
                assert.equal(fake.inputs.length, 1);
            }
            if (operation !== 'create') {
                const fake = createFakeDynamoDB(() => ({Attributes: QuerySerializer.serialiseMap(invalidRecord)}));
                const records = createTestTable().using(fake.db);
                const write = operation === 'update' ? records.update({id: record.id}).set('value').eq(2) : records.delete({id: record.id});
                await assert.rejects(write.toResult(), z.ZodError);
                assert.equal(fake.inputs.length, 1);
            }
        }
    });

    test('typed result success is cached and shares execution with toPromise in either order', async () => {
        for (const promiseFirst of [true, false]) {
            const record = {id: 'result', category: 'news', value: 1};
            const fake = createFakeDynamoDB(() => ({Attributes: QuerySerializer.serialiseMap(record)}));
            const write = createTestTable().using(fake.db).update({id: record.id}).set('value').eq(1);
            if (promiseFirst) {
                assert.deepEqual(await write.toPromise(), record);
            }
            const first = write.toResult();
            assert.strictEqual(first, write.toResult());
            assert.deepEqual(await first, {applied: true, value: record});
            assert.deepEqual(await write.toPromise(), record);
            assert.equal(fake.inputs.length, 1);
        }
    });

    test('typed transaction failure options are forwarded while per-item result execution is blocked', async () => {
        const fake = createFakeDynamoDB();
        const table = createTestTable();
        await typedTransaction(fake.db)
            .add(table, (query) => query.create({id: 'create', category: 'news', value: 1})
                .where('id').not().exists().onConditionFailure().returningAllOld())
            .add(table, (query) => query.update({id: 'update'}).set('value').eq(1)
                .onConditionFailure().returningAllOld(), {returnValuesOnConditionCheckFailure: 'NONE'})
            .add(table, (query) => query.delete({id: 'delete'}).onConditionFailure().returningAllOld())
            .add(table, (query) => query.conditionCheck({id: 'check'}).where('id').exists()
                .onConditionFailure().returningNone())
            .toPromise();
        const items = fake.inputs[0].TransactItems;
        assert.equal(items[0].Put.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
        assert.equal(items[1].Update.ReturnValuesOnConditionCheckFailure, 'NONE');
        assert.equal(items[2].Delete.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
        assert.equal(items[3].ConditionCheck.ReturnValuesOnConditionCheckFailure, 'NONE');
        assert.throws(() => typedTransaction(fake.db).add(table, (query) => query.create({id: 'blocked', category: 'news', value: 1}).toResult()),
            /transaction builder/);
        assert.equal(fake.inputs.length, 1);
    });

    test('infers result types and validates complete writes', async () => {
        const fake = createFakeDynamoDB();
        const records = createTestTable().using(fake.db);
        const resultPromise: Promise<TestRecord> = records.create({
            id: 'record-1',
            category: 'news',
            value: 1
        }).toPromise();

        assert.deepEqual(await resultPromise, {id: 'record-1', category: 'news', value: 1});
        assert.equal(fake.inputs.length, 1);
        assert.throws(
            () => records.create({id: 'invalid', category: 'news', value: -1}).toPromise(),
            z.ZodError
        );
        assert.equal(fake.inputs.length, 1);
    });

    test('validates and types records returned by reads, queries, updates, and deletes', async () => {
        const responses = [
            {Item: QuerySerializer.serialiseMap({id: 'read', category: 'news', value: 2})},
            {Items: [QuerySerializer.serialiseMap({id: 'query', category: 'news', value: 3})]},
            {Attributes: QuerySerializer.serialiseMap({id: 'update', category: 'news', value: 4})},
            {Attributes: QuerySerializer.serialiseMap({id: 'delete', category: 'news', value: 5})}
        ];
        const fake = createFakeDynamoDB(() => responses.shift());
        const records = createTestTable().using(fake.db);
        const readPromise: Promise<TestRecord | null> = records.get({id: 'read'}).toPromise();
        const queryPromise: Promise<TestRecord[]> = records.index('category').query({category: 'news'}).toPromise();
        const updatePromise: Promise<TestRecord | null> = records.update({id: 'update'}).set('value').eq(4).toPromise();
        const deletePromise: Promise<TestRecord | null> = records.delete({id: 'delete'}).returningAllOld().toPromise();

        assert.equal((await readPromise)?.value, 2);
        assert.equal((await queryPromise)[0].value, 3);
        assert.equal((await updatePromise)?.value, 4);
        assert.equal((await deletePromise)?.value, 5);
        assert.equal(fake.inputs[1].IndexName, 'category');
    });

    test('infers void for payload-free typed updates and deletes', async () => {
        const fake = createFakeDynamoDB(() => ({}));
        const records = createTestTable().using(fake.db);

        const updatePromise: Promise<void> = records
            .update({id: 'updated'})
            .set('value').eq(2)
            .returningNone()
            .where('id').exists()
            .toPromise();
        const conditionalUpdatePromise: Promise<void | null> = records
            .update({id: 'updated'})
            .set('value').eq(2)
            .returningNone()
            .where('id').exists()
            .toPromiseOrNull();
        const deletePromise: Promise<void> = records
            .delete({id: 'deleted'})
            .where('id').exists()
            .returningNone()
            .toPromise();

        assert.equal(await updatePromise, undefined);
        assert.equal(await conditionalUpdatePromise, undefined);
        assert.equal(await deletePromise, undefined);
        assert.equal(fake.inputs[0].ReturnValues, 'NONE');
        assert.equal(fake.inputs[1].ReturnValues, 'NONE');
        assert.equal(fake.inputs[2].ReturnValues, 'NONE');

        if (false) {
            // @ts-expect-error Updates only support all-new or no returned attributes.
            records.update({id: 'invalid'}).set('value').eq(1).returning('all-old');
            // @ts-expect-error Deletes only support all-old or no returned attributes.
            records.delete({id: 'invalid'}).returning('all-new');
        }
    });

    test('supports additive updates after with()', async () => {
        const fake = createFakeDynamoDB(() => ({}));
        const records = createTestTable().using(fake.db);

        await records.update({id: 'updated'})
            .with({label: 'updated'})
            .add('value').eq(1)
            .toPromise();

        assert.equal(fake.inputs[0].UpdateExpression, 'SET #label = :label ADD #value :value');
        assert.deepEqual(fake.inputs[0].ExpressionAttributeValues, {
            ':label': {S: 'updated'},
            ':value': {N: '1'}
        });
    });

    test('rejects malformed records returned by DynamoDB', async () => {
        const fake = createFakeDynamoDB(() => ({
            Item: QuerySerializer.serialiseMap({id: 'malformed', category: 'news', value: 'wrong'})
        }));
        const records = createTestTable().using(fake.db);

        await assert.rejects(records.get({id: 'malformed'}).toPromise(), z.ZodError);
    });

    test('rejects malformed records returned by selected index queries', async () => {
        const fake = createFakeDynamoDB(() => ({
            Items: [QuerySerializer.serialiseMap({id: 'malformed', category: 'news', value: 'wrong'})]
        }));
        const records = createTestTable().using(fake.db);

        await assert.rejects(
            records.index('category').query({category: 'news'}).toPromise(),
            z.ZodError
        );
    });

    test('rejects consistent global index reads and permits declared local index reads', async () => {
        const fake = createFakeDynamoDB(() => ({Items: []}));
        const table = defineTable({
            name: 'typed-index-consistency',
            schema: recordSchema,
            key: {partition: 'id'},
            indexes: {
                globalCategory: {kind: 'global', partition: 'category'},
                localCategory: {kind: 'local', partition: 'category'}
            }
        });
        const records = table.using(fake.db);

        assert.throws(
            () => records.index('globalCategory').query({category: 'news'}).consistent(),
            /Global secondary index globalCategory does not support consistent reads/
        );
        await records.index('localCategory').query({category: 'news'}).consistent().toPromise();

        assert.equal(fake.inputs.length, 1);
        assert.equal(fake.inputs[0].IndexName, 'localCategory');
        assert.equal(fake.inputs[0].ConsistentRead, true);
    });

    test('forwards typed fluent metadata, projection, ordering, and scan modifiers', async () => {
        const record = {id: 'typed-options', category: 'news', value: 1};
        const capacity = {TableName: 'typed-records', CapacityUnits: 1};
        const fake = createFakeDynamoDB((command) => {
            if (command.input.Key) {
                return {Item: QuerySerializer.serialiseMap({id: record.id}), ConsumedCapacity: capacity};
            }
            if (command.input.UpdateExpression) {
                return {Attributes: QuerySerializer.serialiseMap(record), ConsumedCapacity: capacity};
            }
            return {Items: [], ConsumedCapacity: capacity};
        });
        const records = createTestTable().using(fake.db);

        const response: Promise<DynamoResponse<Pick<TestRecord, 'id'> | null>> = records
            .get({id: record.id})
            .consistent()
            .select('id')
            .returnCapacity('TOTAL')
            .toResponse();
        assert.deepEqual((await response).value, {id: record.id});

        await records.query({id: record.id}).descending().returnCapacity().toResponse();
        await records.scan().consistent().parallel(0, 2).returnCapacity('NONE').toResponse();
        await records.update({id: record.id})
            .set('value').eq(1)
            .returningAllOld()
            .returnItemCollectionMetrics()
            .toResponse();

        assert.equal(fake.inputs[0].ConsistentRead, true);
        assert.equal(fake.inputs[0].ProjectionExpression, '#id');
        assert.equal(fake.inputs[1].ScanIndexForward, false);
        assert.equal(fake.inputs[2].Segment, 0);
        assert.equal(fake.inputs[2].TotalSegments, 2);
        assert.equal(fake.inputs[3].ReturnValues, 'ALL_OLD');
        assert.equal(fake.inputs[3].ReturnItemCollectionMetrics, 'SIZE');
    });

    test('types and validates projected arrays, pages, iterators, and counts', async () => {
        const fake = createFakeDynamoDB((command) => {
            if (command.input.Select === 'COUNT') {
                return {Count: 2};
            }
            if (command.input.ProjectionExpression === '#id') {
                return {Items: [QuerySerializer.serialiseMap({id: 'projected'})]};
            }
            if (command.input.ProjectionExpression === '#value') {
                return {Items: [QuerySerializer.serialiseMap({value: 3})]};
            }
            return {Items: [QuerySerializer.serialiseMap({id: 'projected', value: 3})]};
        });
        const records = createTestTable().using(fake.db);

        const projectedPromise: Promise<Pick<TestRecord, 'id' | 'value'>[]> = records
            .scan()
            .select('id', 'value')
            .toPromise();
        assert.deepEqual(await projectedPromise, [{id: 'projected', value: 3}]);

        const page: {items: Pick<TestRecord, 'id'>[], cursor: any} = await createTestTable()
            .using(fake.db)
            .scan()
            .select('id')
            .page({limit: 1});
        assert.deepEqual(page.items, [{id: 'projected'}]);

        const iterator: AsyncIterable<Pick<TestRecord, 'value'>> = createTestTable()
            .using(fake.db)
            .scan()
            .select('value')
            .items({limit: 1});
        const iterated: Pick<TestRecord, 'value'>[] = [];
        for await (const item of iterator) {
            iterated.push(item);
        }
        assert.deepEqual(iterated, [{value: 3}]);

        const countPromise: Promise<number> = createTestTable().using(fake.db).scan().count().toPromise();
        assert.equal(await countPromise, 2);
    });

    test('rejects invalid typed projections and malformed projected records', async () => {
        const malformed = createFakeDynamoDB(() => ({
            Items: [QuerySerializer.serialiseMap({id: 'projected', value: 'wrong'})]
        }));
        const records = createTestTable().using(malformed.db);

        await assert.rejects(records.scan().select('value').toPromise(), z.ZodError);
        assert.throws(() => records.scan().select('missing' as any), /unknown field/);
        assert.throws(() => records.scan().select('id').count(), /cannot be combined/);

        if (false) {
            // @ts-expect-error Projection fields are inferred from the record schema.
            records.scan().select('missing');
        }
    });

    test('infers and validates secondary index projected records', async () => {
        const schema = z.object({
            topic: z.string(),
            id: z.string(),
            account: z.string(),
            createdBy: z.string(),
            payload: z.string()
        }).strict();
        const table = defineTable({
            name: 'projected-records',
            schema: schema,
            key: {partition: 'topic', sort: 'id'},
            indexes: {
                account: {
                    kind: 'global',
                    partition: 'account',
                    sort: 'topic',
                    projection: {type: 'KEYS_ONLY'}
                },
                stats: {
                    kind: 'global',
                    partition: 'topic',
                    projection: {type: 'INCLUDE', nonKeyAttributes: ['createdBy']}
                },
                creator: {
                    kind: 'local',
                    partition: 'topic',
                    sort: 'createdBy',
                    projection: {type: 'KEYS_ONLY'}
                }
            }
        });
        const fake = createFakeDynamoDB((command) => {
            if (command.input.ProjectionExpression === '#payload') {
                return {Items: [QuerySerializer.serialiseMap({payload: 'full'})]};
            }
            if (command.input.IndexName === 'stats') {
                return {Items: [QuerySerializer.serialiseMap({topic: 'card', id: 'message', createdBy: 'person'})]};
            }
            return {Items: [QuerySerializer.serialiseMap({topic: 'card', id: 'message', account: 'account'})]};
        });
        const records = table.using(fake.db);

        const keys: Promise<{topic: string; id: string; account: string}[]> = records
            .index('account')
            .query({account: 'account'})
            .toPromise();
        const included: Promise<{topic: string; id: string; createdBy: string}[]> = records
            .index('stats')
            .query({topic: 'card'})
            .toPromise();
        const localPayload: Promise<{payload: string}[]> = records
            .index('creator')
            .query({topic: 'card'})
            .select('payload')
            .toPromise();

        assert.deepEqual(await keys, [{topic: 'card', id: 'message', account: 'account'}]);
        assert.deepEqual(await included, [{topic: 'card', id: 'message', createdBy: 'person'}]);
        assert.deepEqual(await localPayload, [{payload: 'full'}]);

        if (false) {
            // @ts-expect-error Global secondary indexes cannot return non-projected fields.
            records.index('account').query({account: 'account'}).select('payload');
            // @ts-expect-error Global secondary index filters require projected fields.
            records.index('stats').query({topic: 'card'}).where('payload').eq('hidden');
            // @ts-expect-error Local secondary index filters also require projected fields.
            records.index('creator').query({topic: 'card'}).where('payload').eq('hidden');
        }
    });

    test('validates keys, query keys, filters, and partial updates before sending', () => {
        const fake = createFakeDynamoDB();
        const records = createTestTable().using(fake.db);

        assert.throws(() => records.get({id: ''}), z.ZodError);
        assert.throws(() => records.get({id: 'valid', category: 'extra'} as any), /must contain exactly/);
        assert.throws(() => records.query({id: 'valid', category: 'extra'} as any), /must contain exactly/);
        assert.throws(() => records.index('category').query({id: 'valid'} as any), /must contain exactly/);
        assert.throws(() => records.index('category').query({category: ''}), z.ZodError);
        assert.throws(() => records.index('missing' as any).query({category: 'news'}), /does not define index missing/);
        assert.throws(() => records.update({id: 'valid'}).set('value').eq(-1), z.ZodError);
        assert.throws(() => records.update({id: 'valid'}).with({value: -1}), z.ZodError);
        assert.throws(() => records.update({id: 'valid'}).remove('missing' as any), /unknown field/);
        assert.throws(() => records.scan().where('value').eq(-1), z.ZodError);
        assert.throws(() => records.scan().where('tags').contains(1 as any), z.ZodError);
        assert.throws(() => records.delete({id: 'valid'}).where('missing' as any).not().exists(), /unknown field/);
        assert.equal(fake.inputs.length, 0);
    });

    test('validates contains values against Set and array element schemas', () => {
        const fake = createFakeDynamoDB();
        const records = createTestTable().using(fake.db);

        assert.doesNotThrow(() => records.scan().where('tags').contains('red'));
        assert.doesNotThrow(() => records.scan().where('labels').contains('urgent'));
        assert.throws(() => records.scan().where('tags').contains(1 as any), z.ZodError);
        assert.throws(() => records.scan().where('labels').contains(1 as any), z.ZodError);

        if (false) {
            // @ts-expect-error Set membership uses the Set element type.
            records.scan().where('tags').contains(1);
            // @ts-expect-error Array membership uses the array element type.
            records.scan().where('labels').contains(1);
        }

        assert.equal(fake.inputs.length, 0);
    });

    test('restricts selected index query keys at compile time', () => {
        const fake = createFakeDynamoDB();
        const records = createTestTable().using(fake.db);

        if (false) {
            // @ts-expect-error The category index requires its category key.
            records.index('category').query({id: 'wrong-key'});
            // @ts-expect-error One selected index cannot accept another index's key.
            records.index('category').query({value: 1});
            // @ts-expect-error Index names are inferred from the table definition.
            records.index('missing');
            // @ts-expect-error A simple key does not expose sort-key comparisons.
            records.query({id: 'record'}).sortKey();
            // @ts-expect-error Optional collection fields cannot be DynamoDB keys.
            defineTable({name: 'invalid-key-type', schema: recordSchema, key: {partition: 'tags'}});
        }

        assert.equal(fake.inputs.length, 0);
    });

    test('types and validates composite table and index sort key queries', async () => {
        const compositeSchema = z.object({
            id: z.string().min(1),
            sort: z.number().int().nonnegative(),
            category: z.string().min(1)
        }).strict();
        const table = defineTable({
            name: 'composite-records',
            schema: compositeSchema,
            key: {partition: 'id', sort: 'sort'},
            indexes: {category: {kind: 'global', partition: 'category', sort: 'sort'}}
        });
        const fake = createFakeDynamoDB(() => ({Items: []}));
        const records = table.using(fake.db);

        await records.query({id: 'record'}).sortKey().between(10, 20).toPromise();
        await records.index('category').query({category: 'news'}).sortKey().gte(5).toPromise();

        assert.equal(fake.inputs[0].KeyConditionExpression, '#id = :id AND #sort BETWEEN :condition0 AND :condition1');
        assert.equal(fake.inputs[1].KeyConditionExpression, '#category = :category AND #sort >= :condition0');
        assert.throws(() => records.query({id: 'record'}).sortKey().gte(-1), z.ZodError);
        assert.throws(() => records.get({id: 'record'} as any), /must contain exactly/);

        if (false) {
            // @ts-expect-error Queries accept the partition key without the sort key.
            records.query({id: 'record', sort: 1});
            // @ts-expect-error Exact reads require the complete composite key.
            records.get({id: 'record'});
            // @ts-expect-error Sort-key comparisons use the declared sort-key value type.
            records.query({id: 'record'}).sortKey().gte('1');
            // @ts-expect-error beginsWith is not valid for a numeric sort key.
            records.query({id: 'record'}).sortKey().beginsWith(1);
        }
    });

    test('validates batch writes and batch read results across internal chunk builders', async () => {
        const fakeWrites = createFakeDynamoDB();
        const writeRecords = createTestTable().using(fakeWrites.db);

        await assert.rejects(
            writeRecords.createBatch([{id: 'invalid-batch', category: 'news', value: -1}]),
            z.ZodError
        );
        assert.equal(fakeWrites.inputs.length, 0);

        const fakeReads = createFakeDynamoDB(() => ({Responses: {
            'typed-records': [QuerySerializer.serialiseMap({id: 'bad-read', category: 'news', value: 'wrong'})]
        }}));
        const readRecords = createTestTable().using(fakeReads.db);
        await assert.rejects(readRecords.getBatch([{id: 'bad-read'}]), z.ZodError);
    });

    test('builds schema-aware typed transactions from table definitions', async () => {
        const fake = createFakeDynamoDB();
        const table = createTestTable();

        await typedTransaction(fake.db)
            .clientRequestToken('typed-transaction')
            .add(table, (records) => records
                .conditionCheck({id: 'guard'})
                .where('value').gte(1), {returnValuesOnConditionCheckFailure: 'ALL_OLD'})
            .add(table, (records) => records
                .create({id: 'created', category: 'news', value: 1})
                .where('id').not().exists())
            .add(table, (records) => records
                .update({id: 'updated'})
                .set('value').eq(2)
                .where('id').exists())
            .add(table, (records) => records
                .delete({id: 'deleted'})
                .where('id').exists())
            .toPromise();

        const input = fake.inputs[0];
        assert.equal(input.ClientRequestToken, 'typed-transaction');
        assert.equal(input.TransactItems.length, 4);
        assert.equal(input.TransactItems[0].ConditionCheck.TableName, 'typed-records');
        assert.equal(input.TransactItems[0].ConditionCheck.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
        assert.equal(input.TransactItems[1].Put.Item.value.N, '1');
        assert.equal(input.TransactItems[2].Update.UpdateExpression, 'SET #value = :value');
        assert.equal(input.TransactItems[3].Delete.ConditionExpression, 'attribute_exists(#id)');
    });

    test('rejects invalid typed transaction documents before sending', () => {
        const fake = createFakeDynamoDB();
        const table = createTestTable();
        const transaction = typedTransaction(fake.db);

        assert.throws(
            () => transaction.add(table, (records) => records.create({id: 'invalid', category: 'news', value: -1})),
            z.ZodError
        );
        assert.throws(
            () => transaction.add(table, (records) => records.update({id: ''}).set('value').eq(1)),
            z.ZodError
        );
        assert.equal(fake.inputs.length, 0);
        assert.throws(() => transaction.toPromise(), /at least one operation/);
    });

    test('preserves and caches typed transaction service failures', async () => {
        const serviceError = new Error('typed transaction cancelled');
        serviceError.name = 'TransactionCanceledException';
        const fake = createFakeDynamoDB(() => {
            throw serviceError;
        });
        const transaction = typedTransaction(fake.db)
            .add(createTestTable(), (records) => records.create({
                id: 'service-failure',
                category: 'news',
                value: 1
            }));

        const first = transaction.toPromise();
        const second = transaction.toPromise();

        assert.strictEqual(first, second);
        await assert.rejects(first, (error) => error === serviceError);
        assert.equal(fake.inputs.length, 1);
    });

    test('rejects invalid typed transaction lifecycle operations', async () => {
        const table = createTestTable();

        assert.throws(
            () => typedTransaction(createFakeDynamoDB().db).add(table, () => undefined),
            /must be configured/
        );
        assert.throws(
            () => typedTransaction(createFakeDynamoDB().db).add(table, (records) => records.conditionCheck({id: 'unchecked'})),
            /requires at least one condition/
        );

        const limitFake = createFakeDynamoDB();
        const limited = typedTransaction(limitFake.db);
        for (let index = 0; index < 100; index++) {
            limited.add(table, (records) => records.create({
                id: `limit-${index}`,
                category: 'news',
                value: index
            }));
        }
        assert.throws(
            () => limited.add(table, (records) => records.create({id: 'limit-101', category: 'news', value: 101})),
            /at most 100 operations/
        );
        assert.equal(limitFake.inputs.length, 0);

        const startedFake = createFakeDynamoDB();
        const started = typedTransaction(startedFake.db)
            .add(table, (records) => records.create({id: 'started', category: 'news', value: 1}));
        const result = started.toPromise();
        assert.throws(
            () => started.add(table, (records) => records.create({id: 'too-late', category: 'news', value: 2})),
            /after a transaction has executed/
        );
        await result;
        assert.equal(startedFake.inputs.length, 1);
    });

    test('rejects invalid and unknown key metadata', () => {
        assert.throws(
            () => defineTable({name: 'missing-partition', schema: recordSchema, key: {} as any}),
            /requires a partition key/
        );
        assert.throws(
            () => defineTable({name: 'unknown-key', schema: recordSchema, key: {partition: 'missing'} as any}),
            /references unknown field missing/
        );
        assert.throws(
            () => defineTable({name: 'duplicate-key', schema: recordSchema, key: {partition: 'id', sort: 'id'}}),
            /partition and sort keys must be different/
        );
        assert.throws(
            () => defineTable({
                name: 'unknown-index-key',
                schema: recordSchema,
                key: {partition: 'id'},
                indexes: {invalid: {kind: 'global', partition: 'missing'}} as any
            }),
            /references unknown field missing/
        );
        assert.throws(
            () => defineTable({
                name: 'missing-index-kind',
                schema: recordSchema,
                key: {partition: 'id'},
                indexes: {invalid: {partition: 'category'}} as any
            }),
            /requires a global or local kind/
        );
    });
});
