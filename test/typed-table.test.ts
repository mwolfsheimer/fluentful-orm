import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {ConditionalCheckFailedException} from '@aws-sdk/client-dynamodb';
import type {ConditionalWriteResult, DynamoResponse} from '../src/index';
import {z} from 'zod';
import {literal, listAppend, plus, ifNotExists} from '../src/update-expression';
import {typedReadTransaction} from '../src/typed-table';

test('infers heterogeneous atomic reads and projection-aware recoverable batches', async () => {
    const first = defineTable({name: 'first', key: {partition: 'id'}, schema: z.object({id: z.string(), value: z.number()})});
    const second = defineTable({name: 'second', key: {partition: 'key'}, schema: z.object({key: z.number(), label: z.string()})});
    const fake = createFakeDynamoDB(() => ({Responses: [{Item: {value: {N: '3'}}}, {Item: {key: {N: '1'}, label: {S: 'one'}}}]}));
    const transaction = typedReadTransaction(fake.db).add(first, {id: 'one'}, ['value']).add(second, {key: 1});
    const result: [{value: number} | null, {key: number; label: string} | null] = await transaction.toPromise();
    assert.deepEqual(result, [{value: 3}, {key: 1, label: 'one'}]);
    const reads = createFakeDynamoDB(() => ({Responses: {first: [{value: {N: '3'}}]}}));
    const outcome = await first.using(reads.db).getBatchResult([{id: 'one'}], {select: ['value']});
    const value: number = outcome.results[0].value;
    assert.equal(value, 3);
    assert.equal(outcome.completed[0].input.id, 'one');
    if (false) {
        // @ts-expect-error Projected transaction result excludes id.
        result[0]?.id;
        // @ts-expect-error Projected recovery result excludes id.
        outcome.results[0].id;
        // @ts-expect-error Exact transaction key type is required.
        typedReadTransaction(fake.db).add(second, {key: 'wrong'});
    }
});

test('retains confirmed batch completion and parsed results when a later schema parse fails', async () => {
    const table = defineTable({name: 'records', key: {partition: 'id'}, schema: z.object({id: z.string(), value: z.number()})});
    const fake = createFakeDynamoDB(() => ({Responses: {records: [
        {id: {S: 'good'}, value: {N: '1'}}, {id: {S: 'bad'}, value: {S: 'wrong'}}
    ]}}));
    const outcome = await table.using(fake.db).getBatchResult([{id: 'good'}, {id: 'bad'}]);
    assert.equal(outcome.completed.length, 2);
    assert.deepEqual(outcome.results, [{id: 'good', value: 1}]);
    assert.ok(outcome.errors[0] instanceof z.ZodError);
    assert.deepEqual(outcome.resumable, []);
    const writes = createFakeDynamoDB();
    await assert.rejects(table.using(writes.db).createBatchResult([{id: 'good', value: 1}, {id: 'bad', value: 'wrong'}] as any), z.ZodError);
    assert.equal(writes.inputs.length, 0);
});

test('validates typed assignment operands without applying whole-field constraints to deltas', async () => {
    const fake = createFakeDynamoDB();
    const records = defineTable({name: 'assignments', key: {partition: 'id'}, schema: z.object({
        id: z.string(), count: z.number().min(10), label: z.string(), items: z.array(z.string().min(2)).min(3)
    })}).using(fake.db);
    await records.update({id: 'one'}).assign('count', fields => plus(fields.ref('count'), 1))
        .assign('items', fields => listAppend(fields.ref('items'), ['ok'])).returningNone().toPromise();
    assert.equal(fake.inputs.length, 1);
    assert.throws(() => records.update({id: 'one'}).assign('count', fields => fields.ref('label') as any), /incompatible schema/);
    assert.throws(() => records.update({id: 'one'}).assign('count', () => literal(1)), /Too small/);
    assert.throws(() => records.update({id: 'one'}).assign('items', fields => listAppend(fields.ref('items'), ['x'])), /Too small/);
    assert.throws(() => records.update({id: 'one'}).assign('count', fields => ifNotExists(fields.ref('count'), 'bad' as any)), /number/);
    assert.equal(fake.inputs.length, 1);
});

test('restricts typed TTL configuration to numeric top-level fields and forwards cancellation', async () => {
    const fake = createFakeDynamoDB(command => ({TimeToLiveSpecification: command.input.TimeToLiveSpecification}));
    const records = defineTable({name: 'expiry', key: {partition: 'id'}, schema: z.object({id: z.string(), expiresAt: z.number().optional()})}).using(fake.db);
    const controller = new AbortController();
    assert.deepEqual(await records.configureTimeToLive('expiresAt', true, {signal: controller.signal}), {AttributeName: 'expiresAt', Enabled: true});
    assert.equal(fake.options[0].abortSignal, controller.signal);
    assert.throws(() => records.configureTimeToLive('id' as any, true), /numeric/);
    if (false) {
        // @ts-expect-error TTL fields must store numbers.
        records.configureTimeToLive('id', true);
    }
});

test('validates literal secondary-index assignments before sending', () => {
    const fake = createFakeDynamoDB();
    const records = defineTable({name: 'literal-key', key: {partition: 'id'}, schema: z.object({id: z.string(), category: z.string()}),
        indexes: {category: {kind: 'global', partition: 'category'}}}).using(fake.db);
    assert.throws(() => records.update({id: 'one'}).assign('category', () => literal('')), /DynamoDB key/);
    assert.equal(fake.inputs.length, 0);
});

test('parses nullable and tuple sparse images without synthesizing defaults', () => {
    const table = defineTable({name: 'partial', key: {partition: 'id'}, schema: z.object({
        id: z.string(), profile: z.object({name: z.string(), defaulted: z.number().default(1)}).nullable(),
        tuple: z.tuple([z.string(), z.number()])
    })});
    assert.deepEqual(table.parsePartialStored({profile: null, tuple: [3]}), {profile: null, tuple: [3]});
    assert.deepEqual(table.parsePartialStored({profile: {name: 'one'}}), {profile: {name: 'one'}});
});

test('infers complete GSI partitions and sequential sort components', async () => {
    const fake = createFakeDynamoDB(() => ({Items: [{id: {S: 'one'}, tenant: {S: 't'}, region: {N: '1'}, year: {N: '2026'}, token: {B: new Uint8Array([1])}}]}));
    const records = defineTable({name: 'multi', key: {partition: 'id'}, schema: z.object({
        id: z.string(), tenant: z.string(), region: z.number(), year: z.number(), token: z.instanceof(Uint8Array), hidden: z.boolean()
    }), indexes: {multi: {kind: 'global', partition: ['tenant', 'region'], sort: ['year', 'token'], projection: {type: 'KEYS_ONLY'}}}}).using(fake.db);
    const read = () => records.index('multi').query({tenant: 't', region: 1});
    const result = await read().limit(2).sortKey('year').eq(2026).sortKey('token').beginsWith(new Uint8Array([1])).toPromise();
    assert.deepEqual(result.map(record => record.id), ['one']);
    assert.equal(fake.inputs[0].IndexName, 'multi');
    assert.throws(() => records.index('multi').query({tenant: 't'} as any), /exactly/);
    assert.throws(() => read().where('tenant').eq('t'), /active key/);
    if (false) {
        // @ts-expect-error Every partition component is required.
        records.index('multi').query({tenant: 't'});
        // @ts-expect-error The first sort component must come first.
        read().sortKey('token');
        // @ts-expect-error Numeric sort values remain numeric.
        read().sortKey('year').eq('2026');
        // @ts-expect-error A range terminates the sort prefix.
        read().sortKey('year').gt(2020).sortKey('token');
        // @ts-expect-error KEYS_ONLY results omit non-key fields.
        result[0].hidden;
    }
});

test('keeps partial writes sparse and create old results nullable', async () => {
    const table = defineTable({name: 'sparse', key: {partition: 'id'},
        schema: z.object({id: z.string(), count: z.number().default(0), label: z.string().optional()})});
    const fake = createFakeDynamoDB();
    await table.using(fake.db).update({id: 'one'}).with({label: 'changed'}).returningNone().toPromise();
    assert.deepEqual(Object.values(fake.inputs[0].ExpressionAttributeNames), ['label']);
    assert.deepEqual(table.parseUpdate({}), {});
    assert.deepEqual(table.parseUpdate({count: undefined}), {});
    const old = table.using(fake.db).create({id: 'new'}).returningAllOld().returnCapacity().where('id').exists();
    assert.equal(await old.toPromise(), null);
    assert.equal((await old.toResponse()).value, null);
    assert.deepEqual(await old.toResult(), {applied: true, value: null});
    if (false) {
        // @ts-expect-error A first put has no previous record.
        const invalid: Promise<{id: string}> = old.toPromise();
        void invalid;
    }
    assert.throws(() => defineTable({name: 'invalid', key: {partition: 'id'},
        schema: z.object({id: z.string(), category: z.string()}),
        indexes: {local: {kind: 'local', partition: 'category'}}}), /Local index/);
});

test('separates transformed write inputs from stored outputs', async () => {
    const schema = z.object({id: z.string(), value: z.string().transform(Number)});
    const fake = createFakeDynamoDB(command => command.input.Key ? {Item: QuerySerializer.serialiseMap({id: 'one', value: 3})} : {});
    assert.throws(() => defineTable({name: 'transforms', key: {partition: 'id'}, schema})
        .using(fake.db).create({id: 'one', value: '3'}), /outputSchema/);
    assert.equal(fake.inputs.length, 0);
    const table = defineTable({name: 'transforms', key: {partition: 'id'}, schema,
        outputSchema: z.object({id: z.string(), value: z.number()})});
    const records = table.using(fake.db);
    assert.deepEqual(await records.create({id: 'one', value: '3'}).toPromise(), {id: 'one', value: 3});
    assert.deepEqual(await records.get({id: 'one'}).toPromise(), {id: 'one', value: 3});
    assert.deepEqual(await records.get({id: 'one'}).select('value').toPromise(), {value: 3});
    assert.deepEqual(await records.createBatch([{id: 'two', value: '4'}]), [{id: 'two', value: 4}]);
});

test('validates deltas and subsets independently of stored field bounds', async () => {
    const fake = createFakeDynamoDB();
    const records = defineTable({name: 'deltas', key: {partition: 'id'},
        schema: z.object({id: z.string(), count: z.number().nonnegative(), tags: z.set(z.string().min(2)).min(2)})}).using(fake.db);
    await records.update({id: 'one'}).add('count').eq(-1).delete('tags').eq(new Set(['aa'])).returningNone().toPromise();
    assert.deepEqual(fake.inputs[0].ExpressionAttributeValues, {':count': {N: '-1'}, ':tags': {SS: ['aa']}});
    assert.throws(() => records.update({id: 'one'}).delete('tags').eq(new Set(['a'])), z.ZodError);
});

test('validates an entire typed batch before sending any chunk', async () => {
    const fake = createFakeDynamoDB();
    const records = defineTable({name: 'batch-validation', key: {partition: 'id'},
        schema: z.object({id: z.string(), value: z.number().positive()})}).using(fake.db);
    const documents = Array.from({length: 26}, (_, index) => ({id: String(index), value: index === 25 ? -1 : 1}));
    await assert.rejects(records.createBatch(documents, {concurrency: 1}), z.ZodError);
    assert.equal(fake.inputs.length, 0);
});

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

test('types and validates nested paths, references, groups and partial projected lists', async () => {
    const schema = z.object({
        id: z.string(), category: z.string(), used: z.number(), quota: z.number(),
        profile: z.object({address: z.object({city: z.string(), country: z.string().default('GB')})}).readonly().optional(),
        labels: z.array(z.object({label: z.string(), rank: z.number().default(0)})),
        dictionary: z.record(z.string(), z.object({enabled: z.boolean()})),
        choice: z.union([z.object({value: z.string()}), z.object({value: z.number()})]),
        payload: z.object({value: z.string().optional()}).optional()
    });
    const table = defineTable({name: 'nested', schema, key: {partition: 'id'},
        indexes: {category: {kind: 'global', partition: 'category', projection: {type: 'KEYS_ONLY'}}}});
    const projected = {id: 'one', profile: {address: {city: 'London'}}, labels: [{label: 'second'}]};
    const fake = createFakeDynamoDB(command => command.input.RequestItems ? {Responses: {nested: [QuerySerializer.serialiseMap(projected)]}}
        : command.input.IndexName ? {Items: [QuerySerializer.serialiseMap({id: 'one', category: 'news'})]}
            : command.input.Key ? {Item: QuerySerializer.serialiseMap(projected)} : {Items: []});
    const records = table.using(fake.db);
    const city = records.path('profile', 'address', 'city');
    const label = records.path('labels', 2, 'label');
    const result: Promise<{id: string; profile?: {address?: {city?: string}}; labels?: {label?: string}[]} | null> = records.get({id: 'one'}).select('id', city, label).toPromise();
    assert.deepEqual(await result, projected);
    const mixed = {labels: [{label: 'first', rank: 1}, {label: 'second'}]};
    assert.deepEqual(table.parseProjection(mixed, [records.path('labels', 0), records.path('labels', 1, 'label')]), mixed);
    assert.deepEqual(await records.getBatch([{id: 'one'}], {select: ['id', city, label]}), [projected]);
    await records.scan().whereAll(group => group.where(city).beginsWith('Lon').where('used').lte(records.ref('quota'))
        .whereNot(group => group.where('labels').size().between(-0.5, 2.5))).parallel(0, 2).toPromise();
    assert.doesNotThrow(() => records.scan().where(records.path('dictionary', 'dynamic', 'enabled')).eq(true));
    assert.doesNotThrow(() => records.scan().where(records.path('choice', 'value')).eq(1));
    assert.throws(() => records.scan().where(city).eq(123 as any), z.ZodError);
    assert.throws(() => records.scan().whereAny(group => group.where(city).eq(123 as any)), z.ZodError);
    assert.throws(() => records.update({id: 'one'}).set('payload').eq(records.ref('quota') as any), /update assignments/);
    assert.throws(() => records.scan().where('payload').contains(records.ref('quota') as any), /Function arguments/);
    assert.deepEqual(await records.index('category').scan().where('category').eq('news').limit(25).toPromise(), [{id: 'one', category: 'news'}]);
    assert.throws(() => records.index('category').scan().where('used' as any), /projected fields/);
    assert.throws(() => records.index('category').scan().select(city as any), /projected fields/);
    assert.throws(() => records.index('category').scan().where('category').eq(records.ref('used') as any), /projected fields/);
    if (false) {
        // @ts-expect-error Path segments follow the schema.
        records.path('profile', 'missing');
        // @ts-expect-error List dereferences require numeric positions.
        records.path('labels', 'label');
        // @ts-expect-error Nested SET operands follow the selected leaf type.
        records.update({id: 'one'}).set(city).eq(3);
        // @ts-expect-error Stored references retain their value types.
        records.scan().where('used').eq(records.ref('category'));
        // @ts-expect-error Group scopes are predicate-only.
        records.scan().whereAny(group => group.scan());
        // @ts-expect-error GSI scans cannot select non-projected fields.
        records.index('category').scan().select(city);
        // @ts-expect-error Size comparisons do not expose collection functions.
        records.scan().where('labels').size().contains(2);
    }
});

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
            key: {partition: 'id', sort: 'value'},
            indexes: {
                globalCategory: {kind: 'global', partition: 'category'},
                localCategory: {kind: 'local', partition: 'id', sort: 'category'}
            }
        });
        const records = table.using(fake.db);

        assert.throws(
            () => records.index('globalCategory').query({category: 'news'}).consistent(),
            /Global secondary index globalCategory does not support consistent reads/
        );
        await records.index('localCategory').query({id: 'one'}).consistent().toPromise();

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

    test('validates partial operands through collection wrappers without container constraints', async () => {
        const fake = createFakeDynamoDB(() => ({Items: []}));
        const member = z.string().min(2).transform((value) => value.toUpperCase());
        const records = defineTable({
            name: 'operands',
            schema: z.object({
                id: z.string(),
                sort: z.string().regex(/^ITEM#\\d+$/),
                text: z.string().min(5).regex(/^full/),
                list: z.array(member).min(2).max(3).readonly().nullable().optional(),
                set: z.set(member).min(2).readonly().default(new Set(['AA', 'BB'])),
                caught: z.array(member).min(2).catch(['AA', 'BB']),
                piped: z.array(member).pipe(z.array(z.string()).min(2)),
                union: z.union([z.array(member).min(2), z.set(member).min(2)]),
                prefault: z.array(member).min(2).prefault(['AA', 'BB']).nonoptional()
            }),
            key: {partition: 'id', sort: 'sort'}
        }).using(fake.db);
        for (const field of ['list', 'set', 'caught', 'piped', 'union', 'prefault'] as const) {
            await records.scan().where(field).contains('ab').toPromise();
            assert.deepEqual(fake.inputs.at(-1).ExpressionAttributeValues[':condition0'], {S: 'AB'});
            assert.throws(() => records.scan().where(field).contains('a'), z.ZodError);
        }
        assert.doesNotThrow(() => records.scan().where('text').contains('u'));
        assert.throws(() => records.scan().where('text').eq('u'), z.ZodError);
        assert.throws(() => records.scan().where('list').eq(['ab']), z.ZodError);
        assert.doesNotThrow(() => records.query({id: 'p'}).sortKey().beginsWith('ITEM#'));
        assert.throws(() => records.query({id: 'p'}).sortKey().eq('ITEM#'), z.ZodError);
        assert.throws(() => records.query({id: 'p'}).sortKey().beginsWith(1 as any), z.ZodError);
        if (false) {
            // @ts-expect-error Readonly sets still use their member type.
            records.scan().where('set').contains(1);
            // @ts-expect-error Readonly arrays still use their member type.
            records.scan().where('list').contains(1);
            // @ts-expect-error Prefixes require strings for string keys.
            records.query({id: 'p'}).sortKey().beginsWith(1);
        }
    });

    test('rejects active query-key filters and preserves index metadata through continuations', () => {
        const fake = createFakeDynamoDB();
        const records = defineTable({
            name: 'active-keys',
            schema: z.object({id: z.string(), sort: z.number(), category: z.string(), rank: z.number(), text: z.string()}),
            key: {partition: 'id', sort: 'sort'},
            indexes: {category: {kind: 'global', partition: 'category', sort: 'rank'}}
        }).using(fake.db);
        assert.throws(() => records.query({id: 'p'}).where('id'), /active key/);
        assert.throws(() => records.query({id: 'p'}).where('sort'), /active key/);
        assert.throws(() => records.query({id: 'p'}).where('text').eq('x').where('id'), /active key/);
        assert.throws(() => records.index('category').query({category: 'c'}).descending().select('id', 'rank').where('rank'), /active key/);
        assert.throws(() => records.index('category').query({category: 'c'}).sortKey().gte(1).where('category'), /active key/);
        assert.doesNotThrow(() => records.index('category').query({category: 'c'}).where('id').eq('p').where('sort').eq(1));
        assert.doesNotThrow(() => records.scan().where('id').eq('p'));
        assert.equal(fake.inputs.length, 0);
    });

    test('validates declared key sizes and present index keys on all typed write paths', async () => {
        const fake = createFakeDynamoDB();
        const table = defineTable({
            name: 'typed-key-writes',
            schema: z.object({id: z.string(), sort: z.string(), category: z.string(), rank: z.number(), text: z.string()}),
            key: {partition: 'id', sort: 'sort'},
            indexes: {category: {kind: 'global', partition: 'category', sort: 'rank'}}
        });
        const records = table.using(fake.db);
        const key = {id: 'p', sort: 's'};
        const document = {...key, category: 'valid', rank: 1, text: 'text'};
        for (const category of ['', '\u{10000}'.repeat(513)]) {
            assert.throws(() => records.create({...document, category}), /DynamoDB key/);
            assert.throws(() => records.update(key).set('category').eq(category), /DynamoDB key/);
            assert.throws(() => records.update(key).with({category}), /DynamoDB key/);
            await assert.rejects(records.createBatch([{...document, category}]), /DynamoDB key/);
            assert.throws(() => typedTransaction(fake.db).add(table, (query) => query.create({...document, category})), /DynamoDB key/);
        }
        assert.throws(() => records.get({id: '', sort: 's'}), /DynamoDB key/);
        assert.throws(() => records.get({id: 'p', sort: '\u{10000}'.repeat(257)}), /DynamoDB key/);
        assert.throws(() => records.create({...document, rank: 1e126}), /DynamoDB key/);
        assert.doesNotThrow(() => records.get({id: '\u{10000}'.repeat(512), sort: '\u{10000}'.repeat(256)}));
        assert.equal(fake.inputs.length, 0);
    });

    test('accepts partial literal/enum strings without relaxing complete equality', () => {
        const fake = createFakeDynamoDB();
        const records = defineTable({
            name: 'literal-operands',
            schema: z.object({id: z.string(), sort: z.literal('ITEM#1'), status: z.enum(['full-one', 'full-two'])}),
            key: {partition: 'id', sort: 'sort'}
        }).using(fake.db);
        assert.doesNotThrow(() => records.query({id: 'p'}).sortKey().beginsWith('ITEM#'));
        assert.doesNotThrow(() => records.scan().where('status').contains('one'));
        assert.throws(() => records.scan().where('status').eq('one' as any), z.ZodError);
    });

    test('validates binary prefix types without applying complete-key refinements', () => {
        const fake = createFakeDynamoDB();
        const records = defineTable({
            name: 'binary-prefix',
            schema: z.object({id: z.string(), sort: z.instanceof(Uint8Array).refine((bytes) => bytes.length === 8)}),
            key: {partition: 'id', sort: 'sort'}
        }).using(fake.db);
        assert.doesNotThrow(() => records.query({id: 'p'}).sortKey().beginsWith(new Uint8Array([1])));
        assert.throws(() => records.query({id: 'p'}).sortKey().eq(new Uint8Array([1])), z.ZodError);
        assert.throws(() => records.query({id: 'p'}).sortKey().beginsWith('wrong' as any), z.ZodError);
        assert.throws(() => records.query({id: 'p'}).sortKey().beginsWith(new Uint8Array()), /DynamoDB key/);
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
