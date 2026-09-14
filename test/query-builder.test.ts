import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {ConditionalCheckFailedException, TransactionCanceledException} from '@aws-sdk/client-dynamodb';
import {createTable, defineTable, deleteTable, describeTable, getTableDefinition, listTables, QueryBuilder, transactWrite} from '../src/index';
import {QuerySerializer} from '../src/query-serializer';
import {createFakeDynamoDB} from './fake-dynamodb';
import {z} from 'zod';

describe('query - QueryBuilder command construction', () => {
    test('exposes typed and administrative helpers as named exports and class statics', () => {
        const classTable = QueryBuilder.defineTable({
            name: 'typed-api',
            schema: z.object({id: z.string(), value: z.number()}),
            key: {partition: 'id'}
        });
        const exportedTable = defineTable({
            name: 'typed-api',
            schema: z.object({id: z.string(), value: z.number()}),
            key: {partition: 'id'}
        });

        assert.equal(classTable.name, exportedTable.name);
        assert.equal(QueryBuilder.createTable, createTable);
        assert.equal(QueryBuilder.deleteTable, deleteTable);
        assert.equal(QueryBuilder.describeTable, describeTable);
        assert.equal(QueryBuilder.getTableDefinition, getTableDefinition);
        assert.equal(QueryBuilder.listTables, listTables);
        assert.equal(QueryBuilder.transactWrite, transactWrite);
    });

    test('toResult caches successful writes and shares execution with toPromise', async () => {
        for (const promiseFirst of [false, true]) {
            const record = {id: 'result', count: 1};
            const fake = createFakeDynamoDB(() => ({Attributes: QuerySerializer.serialiseMap(record)}));
            const write = new QueryBuilder('test', fake.db).update({id: record.id}).add('count').eq(1);
            if (promiseFirst) {
                assert.deepEqual(await write.toPromise(), record);
            }
            const first = write.toResult<typeof record>();
            assert.strictEqual(write.toResult(), first);
            const result = await first;
            assert.equal(result.applied, true);
            if (result.applied) {
                const count: number = result.value.count;
                assert.equal(count, 1);
            }
            assert.deepEqual(result, {applied: true, value: record});
            assert.deepEqual(await write.toPromise(), record);
            assert.equal(fake.inputs.length, 1);
        }
    });

    test('toResult decodes failure items without changing toPromise or toPromiseOrNull', async () => {
        for (const promiseFirst of [false, true]) {
            const previous = {id: 'legacy', value: {count: 3}, payload: Buffer.from('previous'), labels: new Set(['old'])};
            const failure = new ConditionalCheckFailedException({
                $metadata: {}, message: 'Limit reached', Item: QuerySerializer.serialiseMap(previous)
            });
            const fake = createFakeDynamoDB(() => { throw failure; });
            const write = new QueryBuilder('test', fake.db).update({id: previous.id}).add('count').eq(1)
                .where('count').lt(3).onConditionFailure().returningAllOld();
            if (promiseFirst) {
                await assert.rejects(write.toPromise(), (error) => error === failure);
            }
            const first = write.toResult<{count: number}, typeof previous>();
            assert.strictEqual(first, write.toResult());
            const result = await first;
            assert.deepEqual(result, {applied: false, previous});
            if (!result.applied && result.previous !== null) {
                const count: number = result.previous.value.count;
                assert.equal(count, 3);
            }
            await assert.rejects(write.toPromise(), (error) => error === failure);
            assert.equal(await write.toPromiseOrNull(), null);
            assert.equal(fake.inputs.length, 1);
        }
    });

    test('toResult preserves non-conditional failures and does not resend on retry', async () => {
        for (const failure of [
            new Error('Network unavailable'),
            Object.assign(new Error('Access denied'), {name: 'AccessDeniedException'}),
            Object.assign(new Error('Invalid expression'), {name: 'ValidationException'}),
            new TransactionCanceledException({$metadata: {}, message: 'Transaction cancelled'})
        ]) {
            const fake = createFakeDynamoDB(() => { throw failure; });
            const write = new QueryBuilder('test', fake.db).create({id: 'error'}).where('id').not().exists();
            const first = write.toResult();
            assert.strictEqual(first, write.toResult());
            await assert.rejects(first, (error) => error === failure);
            await assert.rejects(write.toResult(), (error) => error === failure);
            await assert.rejects(write.toPromise(), (error) => error === failure);
            assert.equal(fake.inputs.length, 1);
        }
    });

    test('forwards conditional failure return values for single-item writes', async () => {
        const fake = createFakeDynamoDB();
        await new QueryBuilder('test', fake.db)
            .create({id: 'counter', count: 1}).where('id').not().exists()
            .onConditionFailure().returningAllOld()
            .toPromise();
        await new QueryBuilder('test', fake.db)
            .update({id: 'counter'}).add('count').eq(1).where('count').lt(10)
            .onConditionFailure().returningAllOld()
            .toPromise();
        await new QueryBuilder('test', fake.db)
            .delete({id: 'counter'}).where('count').eq(10)
            .onConditionFailure().returningNone()
            .toPromise();

        assert.deepEqual(fake.inputs.map((input) => input.ReturnValuesOnConditionCheckFailure), ['ALL_OLD', 'ALL_OLD', 'NONE']);
    });

    test('preserves write chains and independent success return options', async () => {
        const fake = createFakeDynamoDB();
        await new QueryBuilder('test', fake.db)
            .create({id: 'create'})
            .onConditionFailure().returningAllOld()
            .where('id').not().exists()
            .onConditionFailure().returningNone()
            .toPromise();
        await new QueryBuilder('test', fake.db)
            .update({id: 'update'}).with({count: 1})
            .onConditionFailure().returningAllOld()
            .set('status').eq('active').where('count').lt(10)
            .onConditionFailure().returningNone()
            .returningNone()
            .onConditionFailure().returningAllOld()
            .toPromiseOrNull();
        await new QueryBuilder('test', fake.db)
            .delete({id: 'delete'})
            .onConditionFailure().returningAllOld()
            .where('count').eq(10).returningNone()
            .onConditionFailure().returningNone()
            .toPromise();
        await new QueryBuilder('test', fake.db)
            .conditionCheck({id: 'check'})
            .onConditionFailure().returningNone()
            .where('count').eq(10)
            .onConditionFailure().returningAllOld()
            .toPromise();

        assert.equal(fake.inputs[0].ReturnValuesOnConditionCheckFailure, 'NONE');
        assert.equal(fake.inputs[1].ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
        assert.equal(fake.inputs[1].ReturnValues, 'NONE');
        assert.equal(fake.inputs[2].ReturnValuesOnConditionCheckFailure, 'NONE');
        assert.equal(fake.inputs[2].ReturnValues, 'NONE');
        assert.equal(fake.inputs[3].TransactItems[0].ConditionCheck.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
    });

    test('rejects condition failure return values on read operations', () => {
        const fake = createFakeDynamoDB();
        for (const query of [
            new QueryBuilder('test', fake.db).onConditionFailure().returningAllOld(),
            new QueryBuilder('test', fake.db).onConditionFailure().returningNone()
        ]) {
            assert.throws(() => query.get({id: 'counter'}).toPromise(), /single-item write/);
        }
        assert.equal(fake.inputs.length, 0);
    });

    test('compiles repeated query filters', async () => {
        const fake = createFakeDynamoDB(() => ({Items: []}));

        await new QueryBuilder('test', fake.db)
            .query({id: 'expression-shape'})
            .where('value').gt(5)
            .where('value').lt(10)
            .toPromise<any[]>();

        assert.equal(fake.inputs.length, 1);
        assert.deepEqual(fake.inputs[0], {
            ReturnConsumedCapacity: 'INDEXES',
            TableName: 'test',
            ScanIndexForward: true,
            ConsistentRead: false,
            KeyConditionExpression: '#id = :id',
            FilterExpression: '#value > :condition0 AND #value < :condition1',
            ExpressionAttributeNames: {
                '#id': 'id',
                '#value': 'value'
            },
            ExpressionAttributeValues: {
                ':id': {S: 'expression-shape'},
                ':condition0': {N: '5'},
                ':condition1': {N: '10'}
            }
        });
    });

    test('compiles indexed query filters', async () => {
        const fake = createFakeDynamoDB(() => ({Items: []}));
        const minimumValue = 1_704_067_200_000;

        await new QueryBuilder('test', fake.db)
            .query({partition: 'partition-value'})
            .usingIndex('partition-index')
            .where('value').gte(minimumValue)
            .toPromise<any[]>();

        assert.equal(fake.inputs[0].TableName, 'test');
        assert.equal(fake.inputs[0].IndexName, 'partition-index');
        assert.equal(fake.inputs[0].KeyConditionExpression, '#partition = :partition');
        assert.equal(fake.inputs[0].FilterExpression, '#value >= :condition0');
        assert.deepEqual(fake.inputs[0].ExpressionAttributeNames, {
            '#partition': 'partition',
            '#value': 'value'
        });
        assert.deepEqual(fake.inputs[0].ExpressionAttributeValues, {
            ':partition': {S: 'partition-value'},
            ':condition0': {N: String(minimumValue)}
        });
    });

    test('projects selected attributes and returns partial items', async () => {
        const fake = createFakeDynamoDB(() => ({
            Items: [QuerySerializer.serialiseMap({id: 'projected', value: 2})]
        }));

        const result = await new QueryBuilder('test', fake.db)
            .scan()
            .select('id', 'value', 'id')
            .toPromise<any[]>();

        assert.deepEqual(result, [{id: 'projected', value: 2}]);
        assert.equal(fake.inputs[0].ProjectionExpression, '#id, #value');
        assert.deepEqual(fake.inputs[0].ExpressionAttributeNames, {'#id': 'id', '#value': 'value'});
    });

    test('rejects invalid and incompatible projections', () => {
        assert.throws(() => new QueryBuilder('test', createFakeDynamoDB().db).scan().select(), /at least one attribute/);
        assert.throws(() => new QueryBuilder('test', createFakeDynamoDB().db).scan().select(''), /at least one attribute/);
        assert.throws(
            () => new QueryBuilder('test', createFakeDynamoDB().db).scan().select('id').count(),
            /cannot be combined/
        );
    });

    test('compiles sort key range and prefix key conditions', async () => {
        const fake = createFakeDynamoDB(() => ({Items: []}));

        await new QueryBuilder('test', fake.db)
            .query({partition: 'records'})
            .sortKey('sort')
            .between(10, 20)
            .toPromise<any[]>();
        await new QueryBuilder('test', fake.db)
            .query({partition: 'records'})
            .sortKey('sort')
            .beginsWith('2026-')
            .toPromise<any[]>();

        assert.equal(fake.inputs[0].KeyConditionExpression, '#partition = :partition AND #sort BETWEEN :condition0 AND :condition1');
        assert.equal(fake.inputs[0].ExpressionAttributeValues[':condition0'].N, '10');
        assert.equal(fake.inputs[0].ExpressionAttributeValues[':condition1'].N, '20');
        assert.equal(fake.inputs[1].KeyConditionExpression, '#partition = :partition AND begins_with(#sort, :condition0)');
        assert.equal(fake.inputs[1].ExpressionAttributeValues[':condition0'].S, '2026-');
    });

    test('preserves negated create conditions', async () => {
        const fake = createFakeDynamoDB();

        await new QueryBuilder('test', fake.db)
            .create({id: 'create-expression-shape', value: 10})
            .where('value').not().gt(5)
            .where('size').not().exists()
            .toPromise();

        assert.equal(fake.inputs[0].ConditionExpression, 'NOT (#value > :condition0) AND attribute_not_exists(#size)');
        assert.deepEqual(fake.inputs[0].ExpressionAttributeNames, {
            '#value': 'value',
            '#size': 'size'
        });
        assert.deepEqual(fake.inputs[0].ExpressionAttributeValues, {
            ':condition0': {N: '5'}
        });
    });

    test('combines update actions, timestamps, and conditions', async () => {
        const fake = createFakeDynamoDB(() => ({
            Attributes: QuerySerializer.serialiseMap({id: 'update-expression-shape', value: 20})
        }));

        await new QueryBuilder('test', fake.db)
            .timestamps()
            .update({id: 'update-expression-shape'})
            .set('value').eq(20)
            .remove('obsolete')
            .where('value').not().lt(10)
            .toPromise();

        const input = fake.inputs[0];
        assert.equal(input.UpdateExpression, 'SET #value = :value, #modifiedAt = :modifiedAt REMOVE #obsolete');
        assert.equal(input.ConditionExpression, 'NOT (#value < :condition0)');
        assert.equal(input.ExpressionAttributeValues[':value'].N, '20');
        assert.equal(typeof input.ExpressionAttributeValues[':modifiedAt'].N, 'string');
        assert.equal(input.ExpressionAttributeValues[':condition0'].N, '10');
    });

    test('omits update and delete response payloads when requested', async () => {
        const fake = createFakeDynamoDB(() => ({}));

        const updated = await new QueryBuilder('test', fake.db)
            .update({id: 'update-none'})
            .set('value').eq(1)
            .returningNone()
            .where('id').exists()
            .toPromise<any>();
        const deleted = await new QueryBuilder('test', fake.db)
            .delete({id: 'delete-none'})
            .returningNone()
            .where('id').exists()
            .toPromise<any>();

        assert.equal(updated, undefined);
        assert.equal(deleted, undefined);
        assert.equal(fake.inputs[0].ReturnValues, 'NONE');
        assert.equal(fake.inputs[1].ReturnValues, 'NONE');
    });

    test('propagates payload-free delete failures', async () => {
        const serviceError = new Error('payload-free write failed');
        const fake = createFakeDynamoDB(() => {
            throw serviceError;
        });
        await assert.rejects(
            new QueryBuilder('test', fake.db).delete({id: 'failure'}).returningNone().toPromise(),
            (error) => error === serviceError
        );
    });

    test('combines numeric adjustments with existence conditions', async () => {
        const fake = createFakeDynamoDB(() => ({
            Attributes: QuerySerializer.serialiseMap({id: 'organisation-credits', credits: 15})
        }));

        await new QueryBuilder('test', fake.db)
            .update({id: 'organisation-credits'})
            .add('credits').eq(-5)
            .where('id').exists()
            .toPromise();

        assert.equal(fake.inputs[0].UpdateExpression, 'ADD #credits :credits');
        assert.equal(fake.inputs[0].ConditionExpression, 'attribute_exists(#id)');
        assert.deepEqual(fake.inputs[0].ExpressionAttributeNames, {
            '#credits': 'credits',
            '#id': 'id'
        });
        assert.deepEqual(fake.inputs[0].ExpressionAttributeValues, {
            ':credits': {N: '-5'}
        });
    });

    test('supports update actions after with()', async () => {
        const fake = createFakeDynamoDB(() => ({}));

        await new QueryBuilder('test', fake.db)
            .update({id: 'with-update'})
            .with({label: 'updated'})
            .returningNone()
            .add('value').eq(5)
            .where('id').exists()
            .toPromise();

        assert.equal(fake.inputs[0].ReturnValues, 'NONE');
        assert.equal(fake.inputs[0].UpdateExpression, 'SET #label = :label ADD #value :value');
        assert.equal(fake.inputs[0].ConditionExpression, 'attribute_exists(#id)');
        assert.deepEqual(fake.inputs[0].ExpressionAttributeValues, {
            ':label': {S: 'updated'},
            ':value': {N: '5'}
        });
    });

    test('passes consistent-read options and validates index consistency before AWS commands', async () => {
        const fake = createFakeDynamoDB((command) => {
            if (command.input.RequestItems) {
                return {Responses: {test: []}};
            }

            return command.input.KeyConditionExpression ? {Items: []} : {};
        });

        await new QueryBuilder('test', fake.db).get({id: 'consistent-get'}, true).toPromise();
        assert.throws(
            () => new QueryBuilder('test', fake.db).query({id: 'consistent-query'}, true).usingIndex('global-index'),
            /Global secondary index global-index does not support consistent reads/
        );
        await new QueryBuilder('test', fake.db).query({id: 'consistent-query'}, true).usingIndex('local-index', 'local').toPromise<any[]>();
        await new QueryBuilder('test', fake.db).getBatch<any>([{id: 'consistent-batch-get'}], false, true);
        await new QueryBuilder('test', fake.db).scan(true).toPromise<any[]>();

        assert.equal(fake.inputs[0].ConsistentRead, true);
        assert.equal(fake.inputs[1].ConsistentRead, true);
        assert.equal(fake.inputs[1].IndexName, 'local-index');
        assert.equal(fake.inputs[2].RequestItems.test.ConsistentRead, true);
        assert.equal(fake.inputs[3].ConsistentRead, true);
    });

    test('returns null items and empty pages for missing AWS result fields without false result logs', async () => {
        const responses = [{}, {}, {}, {}, {}, {Items: []}];
        const logs: any[] = [];
        const fake = createFakeDynamoDB(() => responses.shift());
        const logger = (message: any) => logs.push(message);

        const missingGet = await new QueryBuilder('test', fake.db).logger(logger).get({id: 'missing'}).toPromise();
        const missingDelete = await new QueryBuilder('test', fake.db).logger(logger).delete({id: 'missing'}).toPromise();
        const missingUpdate = await new QueryBuilder('test', fake.db).logger(logger).update({id: 'missing'}).set('value').eq(1).toPromise();
        const missingScan = await new QueryBuilder('test', fake.db).logger(logger).scan().toPromise();
        const missingQuery = await new QueryBuilder('test', fake.db).logger(logger).query({id: 'missing'}).toPromise();
        const emptyItems = await new QueryBuilder('test', fake.db).logger(logger).scan().toPromise<any[]>();

        assert.equal(missingGet, null);
        assert.equal(missingDelete, null);
        assert.equal(missingUpdate, null);
        assert.deepEqual(missingScan, []);
        assert.deepEqual(missingQuery, []);
        assert.deepEqual(emptyItems, []);
        assert.deepEqual(logs.filter((event) => event.result).map((event) => event.result.count), [0]);
    });

    test('rejects invalid chunk and hard limits', () => {
        const fake = createFakeDynamoDB();

        assert.throws(() => new QueryBuilder('test', fake.db).scan().limit(0, null), Error);
        assert.throws(() => new QueryBuilder('test', fake.db).query({id: 'invalid-limit'}).limit(-1, null), Error);
        assert.throws(() => new QueryBuilder('test', fake.db).scan().limit(1.5, null), /Invalid Chunk Size/);
        assert.throws(() => new QueryBuilder('test', fake.db).query({id: 'invalid-limit'}).limit(NaN, null), /Invalid Chunk Size/);
        assert.throws(() => new QueryBuilder('test', fake.db).scan().limit(Infinity, null), /Invalid Chunk Size/);
        assert.throws(() => new QueryBuilder('test', fake.db).scan().limit(1, 0), Error);
        assert.throws(() => new QueryBuilder('test', fake.db).query({id: 'invalid-hard-limit'}).limit(1, -1), Error);
        assert.throws(() => new QueryBuilder('test', fake.db).scan().limit(1, 1.5), /Invalid Hard Limit/);
        assert.throws(() => new QueryBuilder('test', fake.db).query({id: 'invalid-hard-limit'}).limit(1, NaN), /Invalid Hard Limit/);
        assert.throws(() => new QueryBuilder('test', fake.db).scan().limit(1, Infinity), /Invalid Hard Limit/);
    });

    test('controls timestamps without mutating caller documents', async () => {
        const fake = createFakeDynamoDB((command) => {
            if (command.input.UpdateExpression) {
                return {Attributes: QuerySerializer.serialiseMap({id: 'timestamp-update', value: 2})};
            }

            return {};
        });
        const createDocument: any = {id: 'timestamp-create'};
        const batchDocuments: any[] = [{id: 'timestamp-batch'}];

        await new QueryBuilder('test', fake.db).timestamps(false).create(createDocument).toPromise();
        await new QueryBuilder('test', fake.db).timestamps().createBatch(batchDocuments);
        await new QueryBuilder('test', fake.db).timestamps(false).update({id: 'timestamp-update'}).set('value').eq(2).toPromise();

        assert.equal(fake.inputs[0].Item.createdAt, undefined);
        assert.equal(createDocument.createdAt, undefined);
        assert.notEqual(fake.inputs[1].RequestItems.test[0].PutRequest.Item.createdAt, undefined);
        assert.equal(batchDocuments[0].createdAt, undefined);
        assert.equal(fake.inputs[2].ExpressionAttributeNames['#modifiedAt'], undefined);
    });

    test('uses the last value when an attribute is set repeatedly', async () => {
        const fake = createFakeDynamoDB(() => ({
            Attributes: QuerySerializer.serialiseMap({id: 'repeated-set', value: 2})
        }));

        await new QueryBuilder('test', fake.db)
            .update({id: 'repeated-set'})
            .set('value').eq(1)
            .set('value').eq(2)
            .toPromise();

        assert.equal(fake.inputs[0].UpdateExpression, 'SET #value = :value');
        assert.deepEqual(fake.inputs[0].ExpressionAttributeValues, {':value': {N: '2'}});
    });

    test('keeps generated condition values separate from colliding update attributes', async () => {
        const fake = createFakeDynamoDB(() => ({
            Attributes: QuerySerializer.serialiseMap({id: 'placeholder-collision'})
        }));

        await new QueryBuilder('test', fake.db)
            .update({id: 'placeholder-collision'})
            .set('seed').eq(1)
            .where('status').eq('open')
            .set('condition0').eq('replacement')
            .toPromise();

        assert.equal(fake.inputs[0].ConditionExpression, '#status = :condition0');
        assert.equal(fake.inputs[0].UpdateExpression, 'SET #seed = :seed, #condition0 = :update0');
        assert.deepEqual(fake.inputs[0].ExpressionAttributeValues, {
            ':seed': {N: '1'},
            ':condition0': {S: 'open'},
            ':update0': {S: 'replacement'}
        });
    });

    test('keeps only the last update action per attribute', async () => {
        const fake = createFakeDynamoDB(() => ({
            Attributes: QuerySerializer.serialiseMap({id: 'action-collision'})
        }));

        await new QueryBuilder('test', fake.db)
            .update({id: 'set-then-remove'})
            .set('value').eq(1)
            .remove('value')
            .toPromise();
        await new QueryBuilder('test', fake.db)
            .update({id: 'remove-then-set'})
            .remove('value')
            .set('value').eq(1)
            .toPromise();
        await new QueryBuilder('test', fake.db)
            .update({id: 'mixed-survivors'})
            .set('kept').eq(1)
            .set('dropped').eq(2)
            .remove('dropped')
            .toPromise();

        assert.equal(fake.inputs[0].UpdateExpression, 'REMOVE #value');
        assert.equal(fake.inputs[0].ExpressionAttributeValues, undefined);
        assert.equal(fake.inputs[1].UpdateExpression, 'SET #value = :value');
        assert.deepEqual(fake.inputs[1].ExpressionAttributeValues, {':value': {N: '1'}});
        assert.equal(fake.inputs[2].UpdateExpression, 'SET #kept = :kept REMOVE #dropped');
        assert.deepEqual(fake.inputs[2].ExpressionAttributeValues, {':kept': {N: '1'}});
    });

    test('prefers explicit modifiedAt values over automatic timestamps', async () => {
        const fake = createFakeDynamoDB(() => ({
            Attributes: QuerySerializer.serialiseMap({id: 'explicit-timestamp'})
        }));

        await new QueryBuilder('test', fake.db)
            .timestamps()
            .update({id: 'explicit-with'})
            .with({value: 1, modifiedAt: 123})
            .toPromise();
        await new QueryBuilder('test', fake.db)
            .timestamps()
            .update({id: 'explicit-set'})
            .set('modifiedAt').eq(456)
            .toPromise();

        assert.equal(fake.inputs[0].ExpressionAttributeValues[':modifiedAt'].N, '123');
        assert.equal(fake.inputs[1].ExpressionAttributeValues[':modifiedAt'].N, '456');
    });

    test('compiles IN filters and rejects empty IN comparisons', async () => {
        const fake = createFakeDynamoDB(() => ({Items: []}));

        await new QueryBuilder('test', fake.db)
            .query({id: 'in-filter'})
            .where('value').in([1, 2])
            .toPromise<any[]>();

        assert.equal(fake.inputs[0].FilterExpression, '#value IN (:condition0, :condition1)');
        assert.deepEqual(fake.inputs[0].ExpressionAttributeValues[':condition0'], {N: '1'});
        assert.deepEqual(fake.inputs[0].ExpressionAttributeValues[':condition1'], {N: '2'});
        assert.throws(
            () => new QueryBuilder('test', fake.db).query({id: 'empty-in'}).where('value').in([]),
            /IN comparison on value requires at least one value/
        );
        assert.throws(
            () => new QueryBuilder('test', fake.db).scan().where('value').not().in([]),
            /IN comparison on value requires at least one value/
        );
    });

    test('skips undefined document properties and rejects undefined selectors', async () => {
        const fake = createFakeDynamoDB(() => ({
            Attributes: QuerySerializer.serialiseMap({id: 'undefined-handling', kept: 1})
        }));

        await new QueryBuilder('test', fake.db)
            .create({id: 'undefined-create', kept: 1, missing: undefined})
            .toPromise();
        await new QueryBuilder('test', fake.db)
            .update({id: 'undefined-with'})
            .with({kept: 1, missing: undefined})
            .toPromise();

        assert.deepEqual(Object.keys(fake.inputs[0].Item), ['id', 'kept']);
        assert.equal(fake.inputs[1].UpdateExpression, 'SET #kept = :kept');
        assert.throws(() => new QueryBuilder('test', fake.db).get({id: undefined as any}), /Cannot serialise/);
        assert.throws(() => new QueryBuilder('test', fake.db).delete({id: undefined as any}), /Cannot serialise/);
        assert.throws(() => new QueryBuilder('test', fake.db).update({id: 'set-undefined'}).set('value').eq(undefined), /Cannot serialise/);
    });

    test('returns the serialized records submitted by create operations', async () => {
        const fake = createFakeDynamoDB();

        const created = await new QueryBuilder('test', fake.db)
            .create({id: 'normalised-create', missing: undefined, values: new Set([null])})
            .toPromise<any>();
        const batchCreated = await new QueryBuilder('test', fake.db)
            .createBatch<any>([{id: 'normalised-batch', missing: undefined, values: new Set([null])}]);

        assert.deepEqual(created, {id: 'normalised-create', values: [null]});
        assert.deepEqual(batchCreated, [{id: 'normalised-batch', values: [null]}]);
        assert.deepEqual(fake.inputs[0].Item, QuerySerializer.serialiseMap(created));
        assert.deepEqual(fake.inputs[1].RequestItems.test[0].PutRequest.Item, QuerySerializer.serialiseMap(batchCreated[0]));
    });

    test('returns the same promise for repeated toPromise calls', async () => {
        const fake = createFakeDynamoDB();
        const builder = new QueryBuilder('test', fake.db).create({id: 'single-send'});

        const first = builder.toPromise();
        const second = builder.toPromise();
        await first;
        await second;

        assert.equal(first, second);
        assert.equal(fake.inputs.length, 1);
    });

    test('continues pagination when a page has a start key but no items', async () => {
        const fake = createFakeDynamoDB((command, attempt) => {
            if (attempt === 1) {
                return {LastEvaluatedKey: QuerySerializer.serialiseMap({id: 'empty-page'})};
            }

            return {Items: [QuerySerializer.serialiseMap({id: 'final-page'})]};
        });

        const result = await new QueryBuilder('test', fake.db).scan().toPromise<any[]>();

        assert.deepEqual(result.map((item) => item.id), ['final-page']);
        assert.equal(fake.inputs.length, 2);
    });

    test('delegates static table administration calls', async () => {
        const responses = [
            {TableDescription: {TableName: 'delegated-create'}},
            {TableNames: ['delegated-list']},
            {Table: {TableName: 'delegated-describe', TableStatus: 'ACTIVE', TableArn: 'arn:aws:dynamodb:eu-west-1:123456789012:table/delegated-describe'}},
            {TableDescription: {TableName: 'delegated-delete'}}
        ];
        const fake = createFakeDynamoDB(() => responses.shift());

        const created = await QueryBuilder.createTable('delegated-create', 'customKey', fake.db);
        const listed = await QueryBuilder.listTables(fake.db);
        const described = await QueryBuilder.describeTable('delegated-describe', fake.db);
        const deleted = await QueryBuilder.deleteTable('delegated-delete', fake.db);

        assert.ok(created);
        assert.deepEqual(listed, ['delegated-list']);
        assert.deepEqual(described, {
            TableName: 'delegated-describe',
            TableStatus: 'ACTIVE',
            TableArn: 'arn:aws:dynamodb:eu-west-1:123456789012:table/delegated-describe'
        });
        assert.ok(deleted);
        assert.equal(fake.inputs[0].TableName, 'delegated-create');
        assert.equal(fake.inputs[0].AttributeDefinitions[0].AttributeName, 'customKey');
        assert.equal(fake.inputs[0].KeySchema[0].AttributeName, 'customKey');
        assert.equal(fake.inputs[2].TableName, 'delegated-describe');
        assert.equal(fake.inputs[3].TableName, 'delegated-delete');
    });

    test('normalises DynamoDB table key and index definitions', async () => {
        const fake = createFakeDynamoDB(() => ({Table: {
            TableName: 'tasks',
            AttributeDefinitions: [
                {AttributeName: 'projectId', AttributeType: 'S'},
                {AttributeName: 'taskId', AttributeType: 'B'},
                {AttributeName: 'status', AttributeType: 'S'},
                {AttributeName: 'priority', AttributeType: 'N'},
                {AttributeName: 'createdAt', AttributeType: 'N'}
            ],
            KeySchema: [
                {AttributeName: 'projectId', KeyType: 'HASH'},
                {AttributeName: 'taskId', KeyType: 'RANGE'}
            ],
            GlobalSecondaryIndexes: [{
                IndexName: 'status-index',
                KeySchema: [
                    {AttributeName: 'status', KeyType: 'HASH'},
                    {AttributeName: 'priority', KeyType: 'RANGE'}
                ],
                Projection: {ProjectionType: 'ALL'}
            }],
            LocalSecondaryIndexes: [{
                IndexName: 'created-index',
                KeySchema: [
                    {AttributeName: 'projectId', KeyType: 'HASH'},
                    {AttributeName: 'createdAt', KeyType: 'RANGE'}
                ],
                Projection: {ProjectionType: 'ALL'}
            }]
        }}));

        const definition = await QueryBuilder.getTableDefinition('tasks', fake.db);

        assert.deepEqual(definition, {
            name: 'tasks',
            key: {partition: 'projectId', sort: 'taskId'},
            attributes: {projectId: 'S', taskId: 'B', status: 'S', priority: 'N', createdAt: 'N'},
            indexes: {
                'status-index': {kind: 'global', partition: 'status', sort: 'priority'},
                'created-index': {kind: 'local', partition: 'projectId', sort: 'createdAt'}
            }
        });
        assert.deepEqual(fake.inputs, [{TableName: 'tasks'}]);
        assert.ok(definition);
        await QueryBuilder.createTable(definition, fake.db);
        assert.deepEqual(fake.inputs[1], {
            TableName: 'tasks', BillingMode: 'PAY_PER_REQUEST',
            KeySchema: [{AttributeName: 'projectId', KeyType: 'HASH'}, {AttributeName: 'taskId', KeyType: 'RANGE'}],
            AttributeDefinitions: [
                {AttributeName: 'projectId', AttributeType: 'S'}, {AttributeName: 'taskId', AttributeType: 'B'},
                {AttributeName: 'status', AttributeType: 'S'}, {AttributeName: 'priority', AttributeType: 'N'},
                {AttributeName: 'createdAt', AttributeType: 'N'}
            ],
            GlobalSecondaryIndexes: [{IndexName: 'status-index', Projection: {ProjectionType: 'ALL'},
                KeySchema: [{AttributeName: 'status', KeyType: 'HASH'}, {AttributeName: 'priority', KeyType: 'RANGE'}]}],
            LocalSecondaryIndexes: [{IndexName: 'created-index', Projection: {ProjectionType: 'ALL'},
                KeySchema: [{AttributeName: 'projectId', KeyType: 'HASH'}, {AttributeName: 'createdAt', KeyType: 'RANGE'}]}]
        });
    });

    test('rejects invalid creation definitions before sending a request', () => {
        const fake = createFakeDynamoDB();
        const valid = {name: 'tasks', key: {partition: 'id'}, attributes: {id: 'S' as const}, indexes: {}};
        assert.throws(() => QueryBuilder.createTable({...valid, attributes: {}}, fake.db), /attribute type/);
        assert.throws(() => QueryBuilder.createTable({...valid, attributes: {id: 'S', payload: 'S'}}, fake.db), /only table and index keys/);
        assert.throws(() => QueryBuilder.createTable({...valid, key: {partition: 'id', sort: 'id'}}, fake.db), /Invalid key/);
        assert.throws(() => QueryBuilder.createTable({...valid, name: ''}, fake.db), /requires a name/);
        assert.throws(() => QueryBuilder.createTable({...valid, indexes: {
            missing: {kind: 'global', partition: 'untyped'}
        }}, fake.db), /attribute type/);
        assert.throws(() => QueryBuilder.createTable({...valid, indexes: {
            local: {kind: 'local', partition: 'id', sort: 'order'}
        }}, fake.db), /Local index/);
        assert.throws(() => QueryBuilder.createTable({...valid, attributes: {id: 'S', order: 'N', other: 'S'},
            key: {partition: 'id', sort: 'order'}, indexes: {
                local: {kind: 'local', partition: 'other', sort: 'order'}
            }}, fake.db), /Local index/);
        assert.throws(() => QueryBuilder.createTable({...valid, attributes: {id: 'invalid' as 'S'}}, fake.db), /attribute type/);
        assert.throws(() => QueryBuilder.createTable({...valid, indexes: {
            unknown: {kind: 'invalid' as 'global', partition: 'id'}
        }}, fake.db), /Invalid index/);
        assert.equal(fake.inputs.length, 0);
    });

    test('creates and discovers secondary index projections', async () => {
        const definition = {
            name: 'projected-tasks',
            key: {partition: 'id'},
            attributes: {id: 'S' as const, status: 'S' as const},
            indexes: {
                keys: {kind: 'global' as const, partition: 'status', projection: {type: 'KEYS_ONLY' as const}},
                summary: {
                    kind: 'global' as const,
                    partition: 'status',
                    projection: {type: 'INCLUDE' as const, nonKeyAttributes: ['summary']}
                }
            }
        };
        const create = createFakeDynamoDB();
        await QueryBuilder.createTable(definition, create.db);
        assert.deepEqual(create.inputs[0].GlobalSecondaryIndexes, [
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
        ]);

        const describe = createFakeDynamoDB(() => ({Table: {
            TableName: definition.name,
            KeySchema: [{AttributeName: 'id', KeyType: 'HASH'}],
            AttributeDefinitions: [
                {AttributeName: 'id', AttributeType: 'S'},
                {AttributeName: 'status', AttributeType: 'S'}
            ],
            GlobalSecondaryIndexes: create.inputs[0].GlobalSecondaryIndexes
        }}));
        assert.deepEqual(await QueryBuilder.getTableDefinition(definition.name, describe.db), definition);
    });

    test('rejects missing or invalid attribute types in returned metadata', async () => {
        for (const attributes of [undefined, [{AttributeName: 'id', AttributeType: 'invalid'}]]) {
            const fake = createFakeDynamoDB(() => ({Table: {
                TableName: 'tasks', KeySchema: [{AttributeName: 'id', KeyType: 'HASH'}], AttributeDefinitions: attributes
            }}));
            await assert.rejects(QueryBuilder.getTableDefinition('tasks', fake.db), /attribute type/);
        }
    });

    test('validates missing DynamoDB table definition metadata', async () => {
        const missing = createFakeDynamoDB(() => ({}));
        const malformed = createFakeDynamoDB(() => ({Table: {TableName: 'malformed'}}));

        assert.equal(await QueryBuilder.getTableDefinition('missing', missing.db), null);
        await assert.rejects(
            QueryBuilder.getTableDefinition('malformed', malformed.db),
            /DynamoDB table malformed does not define a partition key/
        );
    });
});
