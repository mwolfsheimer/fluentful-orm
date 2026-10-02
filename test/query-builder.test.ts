import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {ConditionalCheckFailedException, TransactionCanceledException} from '@aws-sdk/client-dynamodb';
import {createTable, defineTable, deleteTable, describeTable, getTableDefinition, listTables, QueryBuilder, transactWrite} from '../src/index';
import {QuerySerializer} from '../src/query-serializer';
import {createFakeDynamoDB} from './fake-dynamodb';
import {z} from 'zod';
import {path, ref} from '../src/document-path';
import {ExpressionBuilder} from '../src/expression-builder';
import {collectPredicates} from '../src/predicate';
import type {ExpressionTarget} from '../src/expression-builder';

test('snapshots in-flight writes and accepts prototype-sensitive documents', async () => {
    let finish!: (value: object) => void;
    const fake = createFakeDynamoDB(() => new Promise(resolve => { finish = resolve; }));
    const write = new QueryBuilder('test', fake.db).create({id: 'one'});
    const pending = write.toPromise();
    write.returningAllOld();
    finish({});
    assert.deepEqual(await pending, {id: 'one'});
    assert.equal(fake.inputs[0].ReturnValues, undefined);
    const immediate = createFakeDynamoDB();
    const key = Object.fromEntries([['hasOwnProperty', 'one'], ['__proto__', 'two']]);
    await new QueryBuilder('test', immediate.db).get(key).toPromise();
    await new QueryBuilder('test', immediate.db).update(Object.assign(Object.create(null), {id: 'one'}))
        .with({hasOwnProperty: 'value'}).toPromise();
    assert.deepEqual(Object.keys(immediate.inputs[0].Key), ['hasOwnProperty', '__proto__']);
});

test('lists every table page and propagates subsequent page failures', async () => {
    const fake = createFakeDynamoDB((command, attempt) => {
        if (attempt === 1) return {TableNames: ['first'], LastEvaluatedTableName: 'first'};
        assert.equal(command.input.ExclusiveStartTableName, 'first');
        return {TableNames: ['second']};
    });
    assert.deepEqual(await QueryBuilder.listTables(fake.db), ['first', 'second']);
    const failure = new Error('page failed');
    const failing = createFakeDynamoDB((_command, attempt) => {
        if (attempt === 1) return {TableNames: ['first'], LastEvaluatedTableName: 'first'};
        throw failure;
    });
    await assert.rejects(QueryBuilder.listTables(failing.db), error => error === failure);
});

test('compiles scoped predicates and rolls back invalid callbacks', () => {
    const expressions = new ExpressionBuilder();
    expressions.addPredicate(collectPredicates('OR', group => group.where('status').eq('open')
        .whereAll(group => group.where('priority').gte(3).where('archived').eq(false))
        .whereNot(group => group.where(path('pricing', 'sale')).lt(ref('pricing', 'regular')))), true);
    const target: ExpressionTarget = {};
    expressions.applyTo(target);
    assert.equal(target.FilterExpression, '(#status = :condition0 OR (#priority >= :condition1 AND #archived = :condition2) OR NOT (#pricing.#sale < #pricing.#regular))');
    assert.equal(Object.keys(target.ExpressionAttributeValues!).length, 3);
    for (const callback of [() => undefined, (group: any) => group.where('a'),
        (group: any) => { group.where('a').eq(1); throw new Error('failed'); },
        async (group: any) => group.where('a').eq(1)]) {
        assert.throws(() => expressions.addPredicate(collectPredicates('AND', callback as any), true));
    }
    expressions.applyTo(target);
    assert.equal(Object.keys(target.ExpressionAttributeValues!).length, 3);
});

test('keeps explicit paths immutable and distinct from literal dotted attribute names', () => {
    const expressions = new ExpressionBuilder();
    const city = path('profile', 'address', 'city');
    assert.equal(expressions.addPath(city), '#profile.#address.#city');
    assert.equal(expressions.addPath(path('labels', 0)), '#labels[0]');
    assert.equal(expressions.addPath('profile.address.city'), '#name0');
    assert.ok(Object.isFrozen(city));
    assert.ok(Object.isFrozen(city.segments));
    assert.ok(Object.isFrozen(ref('quota')));
    for (const segments of [[], [0], [''], ['labels', -1], ['labels', 0.5], ['labels', Infinity], Array(34).fill('field')]) {
        assert.throws(() => path(...segments as any));
    }
});

test('exposes paths, groups, functions, references and index scans through public chains', async () => {
    const fake = createFakeDynamoDB(() => ({Items: [], Attributes: {}, Responses: {test: []}}));
    const scan = new QueryBuilder('test', fake.db).scan().usingIndex('category-index')
        .whereAny(group => group.where(path('profile', 'city')).beginsWith('Lon')
            .whereAll(group => group.where('used').lte(ref('quota')).where('payload').attributeType('M')))
        .whereNot(group => group.where('blocked').exists())
        .where('labels').size().not().between(-0.5, 2.5).where('score').in([ref('quota'), 3])
        .select('odd.name', path('labels', 1)).parallel(0, 4).limit(25);
    assert.equal((scan as any).ascending, undefined);
    await scan.toPromise();
    const input = fake.inputs[0];
    assert.equal(input.IndexName, 'category-index');
    assert.equal(input.TotalSegments, 4);
    assert.match(input.FilterExpression, /size\(#labels\) BETWEEN/);
    assert.match(input.FilterExpression, /#used <= #quota/);
    assert.match(input.ProjectionExpression, /#labels\[1\]/);
    assert.ok(!Object.values(input.ExpressionAttributeValues).some((value: any) => value.M));
    await new QueryBuilder('test', fake.db).update({id: 'one'}).set(path('profile', 'city')).eq('Manchester')
        .remove(path('labels', 1)).whereAll(group => group.where('used').between(ref('minimum'), ref('quota'))).toPromise();
    assert.match(fake.inputs[1].UpdateExpression, /SET #profile.#city = :update0 REMOVE #labels\[1\]/);
    await new QueryBuilder('test', fake.db).getBatch([{id: 'one'}], {select: [path('profile', 'city')]});
    assert.equal(fake.inputs[2].RequestItems.test.ProjectionExpression, '#profile.#city');
    for (const order of [true, false]) {
        assert.throws(() => order ? new QueryBuilder('test', fake.db).scan().consistent().usingIndex('gsi')
            : new QueryBuilder('test', fake.db).scan().usingIndex('gsi').consistent(), /consistent reads/);
    }
    assert.doesNotThrow(() => new QueryBuilder('test', fake.db).scan().consistent().usingIndex('lsi', 'local'));
    assert.throws(() => new QueryBuilder('test', fake.db).update({id: 'one'}).set(path('id', 'value')).eq(2), /key attributes/);
    assert.throws(() => new QueryBuilder('test', fake.db).update({id: 'one'}).set('profile').eq({}).remove(path('profile', 'city')), /Overlapping/);
    assert.throws(() => new QueryBuilder('test', fake.db).scan().where('labels').size().gt(Infinity), /finite numbers/);
    assert.throws(() => new QueryBuilder('test', fake.db).scan().where('payload').attributeType('X' as any), /attribute type/);
    assert.equal((new QueryBuilder('test', fake.db).scan().where('labels').size() as any).contains, undefined);
    assert.throws(() => new QueryBuilder('test', fake.db).update({id: 'one'}).set('value').eq(ref('other')), /update assignments/);
    assert.throws(() => new QueryBuilder('test', fake.db).scan().where('labels').contains(ref('other')), /Function arguments/);
});

test('allocates safe collision-free aliases for literal attribute names in every expression', async () => {
    const fake = createFakeDynamoDB(() => ({Items: [], Attributes: {id: {S: 'one'}}, Responses: {test: []}}));
    const fields = ['odd.name', 'odd-name', 'space name', 'caf\u00e9', '1start', 'name0', 'update0', 'condition0'];
    await new QueryBuilder('test', fake.db).query({'odd.name': 'partition'})
        .sortKey('odd-name').between(1, 2).select(...fields).where('space name').not().in([{a: [1]}, null]).toPromise();
    await new QueryBuilder('test', fake.db).update({id: 'one'}).with(Object.fromEntries(fields.map((field) => [field, 1])))
        .where('odd.name').exists().where('odd-name').contains('part').remove('space name').toPromise();
    await new QueryBuilder('test', fake.db).get({id: 'one'}).select(...fields).select('odd.name').toPromise();
    await new QueryBuilder('test', fake.db).getBatch([{id: 'one'}], {select: fields});
    await new QueryBuilder('test', fake.db).query({'odd-name': 'p'}).sortKey('odd.name').beginsWith('prefix').toPromise();
    for (const input of [...fake.inputs.slice(0, 3), fake.inputs[3].RequestItems.test, fake.inputs[4]]) {
        const expressions = [input.KeyConditionExpression, input.ConditionExpression, input.FilterExpression,
            input.UpdateExpression, input.ProjectionExpression].filter(Boolean).join(' ');
        for (const [alias, name] of Object.entries(input.ExpressionAttributeNames)) {
            assert.match(alias, /^#[A-Za-z0-9_]+$/);
            assert.ok(fields.includes(name as string));
            assert.ok(new Set<string>(expressions.match(/#[A-Za-z0-9_]+/g) || []).has(alias));
        }
        for (const alias of Object.keys(input.ExpressionAttributeValues || {})) {
            assert.match(alias, /^:[A-Za-z0-9_]+$/);
            assert.ok(new Set<string>(expressions.match(/:[A-Za-z0-9_]+/g) || []).has(alias));
        }
    }
    assert.equal(Object.keys(fake.inputs[2].ExpressionAttributeNames).length, 1);
    assert.equal(Object.values(fake.inputs[0].ExpressionAttributeNames).filter((name) => name === 'odd.name').length, 1);
});

test('enforces IN, query-key, segment and index-selection boundaries before sending', async () => {
    const fake = createFakeDynamoDB(() => ({Items: []}));
    for (const count of [1, 100]) {
        for (const negated of [false, true]) {
            const comparison = new QueryBuilder('test', fake.db).scan().where('value');
            await (negated ? comparison.not() : comparison).in(Array.from({length: count}, (_, i) => i)).toPromise();
        }
    }
    for (const negated of [false, true]) {
        const comparison = new QueryBuilder('test', fake.db).scan().where('value');
        assert.throws(() => (negated ? comparison.not() : comparison).in(Array(101).fill(1)), /at most 100/);
    }
    for (const value of ['', new Uint8Array(), null, [], false, Infinity, 1e126, 1e-131, 'x'.repeat(2049)]) {
        assert.throws(() => new QueryBuilder('test', fake.db).query({id: value as any}), /key/);
    }
    assert.throws(() => new QueryBuilder('test', fake.db).query({}), /partition key/);
    assert.throws(() => new QueryBuilder('test', fake.db).query({id: 'p'}).sortKey('id').eq('p'), /sort-key predicate/);
    assert.throws(() => new QueryBuilder('test', fake.db).query({id: 'p'}).sortKey('sort').gt(1).sortKey('sort').lt(3), /sort-key predicate/);
    assert.throws(() => new QueryBuilder('test', fake.db).query({id: 'p', sort: 1}).sortKey('sort').eq(1), /sort-key predicate/);
    assert.throws(() => new QueryBuilder('test', fake.db).query({id: 'p'}).sortKey('sort').beginsWith(1 as any), /prefix/);
    assert.throws(() => new QueryBuilder('test', fake.db).query({id: 'p'}).sortKey('sort').between(3, 1), /ordered bounds/);
    assert.throws(() => new QueryBuilder('test', fake.db).query({id: 'p'}).sortKey('sort').between(1, '2'), /matching types/);
    assert.throws(() => new QueryBuilder('test', fake.db).scan().parallel(0, 1000001), /segment/);
    assert.doesNotThrow(() => new QueryBuilder('test', fake.db).scan().parallel(999999, 1000000));
    assert.throws(() => new QueryBuilder('test', fake.db).usingIndex('index'), /query operation/);
    assert.throws(() => new QueryBuilder('test', fake.db).get({id: 'p'}).usingIndex('index'), /query operation/);
    const scan = new QueryBuilder('test', fake.db);
    scan.scan();
    assert.doesNotThrow(() => scan.usingIndex('index'));
    assert.throws(() => new QueryBuilder('test', fake.db).query({id: 'p'}).usingIndex(''), /requires a name/);
    assert.equal(fake.inputs.length, 4);
});

test('configures fluent DynamoDB request options and returns response metadata', async () => {
    const capacity = {TableName: 'test', CapacityUnits: 2};
    const metrics = {ItemCollectionKey: QuerySerializer.serialiseMap({id: 'item'}), SizeEstimateRangeGB: [0.01, 0.02]};
    const fake = createFakeDynamoDB((command) => {
        if (command.input.Key) {
            return {Item: QuerySerializer.serialiseMap({id: 'item', value: 1}), ConsumedCapacity: capacity};
        }
        if (command.input.Item) {
            return {Attributes: QuerySerializer.serialiseMap({id: 'previous', value: 0}), ConsumedCapacity: capacity, ItemCollectionMetrics: metrics};
        }
        return {Items: [], ConsumedCapacity: capacity};
    });

    const get = await new QueryBuilder('test', fake.db)
        .get({id: 'item'})
        .consistent()
        .select('id')
        .returnCapacity('TOTAL')
        .toResponse<{id: string} | null>();
    const create = await new QueryBuilder('test', fake.db)
        .create({id: 'item', value: 1})
        .returningAllOld()
        .returnItemCollectionMetrics()
        .toResponse<{id: string; value: number} | null>();
    await new QueryBuilder('test', fake.db)
        .query({id: 'item'})
        .descending()
        .returnCapacity()
        .toPromise();
    await new QueryBuilder('test', fake.db)
        .scan()
        .parallel(1, 3)
        .consistent()
        .toPromise();

    assert.deepEqual(get.value, {id: 'item'});
    assert.deepEqual(get.consumedCapacity, [capacity]);
    assert.deepEqual(create.value, {id: 'previous', value: 0});
    assert.deepEqual(create.itemCollectionMetrics, [metrics]);
    assert.equal(fake.inputs[0].ConsistentRead, true);
    assert.equal(fake.inputs[0].ProjectionExpression, '#id');
    assert.equal(fake.inputs[0].ReturnConsumedCapacity, 'TOTAL');
    assert.equal(fake.inputs[1].ReturnValues, 'ALL_OLD');
    assert.equal(fake.inputs[1].ReturnItemCollectionMetrics, 'SIZE');
    assert.equal(fake.inputs[2].ScanIndexForward, false);
    assert.equal(fake.inputs[3].Segment, 1);
    assert.equal(fake.inputs[3].TotalSegments, 3);
});

test('returns previous records for successful create and update operations', async () => {
    const previous = {id: 'item', value: 1};
    const fake = createFakeDynamoDB(() => ({Attributes: QuerySerializer.serialiseMap(previous)}));

    const created = await new QueryBuilder('test', fake.db)
        .create({id: 'item', value: 2})
        .returningAllOld()
        .toPromise<typeof previous | null>();
    const updated = await new QueryBuilder('test', fake.db)
        .update({id: 'item'})
        .set('value').eq(2)
        .returningAllOld()
        .toPromise<typeof previous | null>();

    assert.deepEqual(created, previous);
    assert.deepEqual(updated, previous);
    assert.equal(fake.inputs[0].ReturnValues, 'ALL_OLD');
    assert.equal(fake.inputs[1].ReturnValues, 'ALL_OLD');
});

test('passes batch read and write request options to each chunk', async () => {
    const fake = createFakeDynamoDB((command) => Array.isArray(command.input.RequestItems.test)
        ? {UnprocessedItems: {}}
        : {Responses: {test: []}, UnprocessedKeys: {}});

    await new QueryBuilder('test', fake.db).getBatch([{id: 'item'}], {
        concurrency: 1,
        consistentRead: true,
        select: ['id'],
        returnConsumedCapacity: 'TOTAL'
    });
    await new QueryBuilder('test', fake.db).createBatch([{id: 'item'}], {
        concurrency: 1,
        returnConsumedCapacity: 'TOTAL',
        returnItemCollectionMetrics: 'SIZE'
    });

    assert.equal(fake.inputs[0].ReturnConsumedCapacity, 'TOTAL');
    assert.equal(fake.inputs[0].RequestItems.test.ConsistentRead, true);
    assert.equal(fake.inputs[0].RequestItems.test.ProjectionExpression, '#id');
    assert.equal(fake.inputs[1].ReturnConsumedCapacity, 'TOTAL');
    assert.equal(fake.inputs[1].ReturnItemCollectionMetrics, 'SIZE');
});

test('passes metadata options through transaction requests', async () => {
    const fake = createFakeDynamoDB();

    await QueryBuilder.transactWrite(fake.db)
        .returnCapacity('TOTAL')
        .returnItemCollectionMetrics()
        .add('test', (records) => records.create({id: 'item'}))
        .toPromise();

    assert.equal(fake.inputs[0].ReturnConsumedCapacity, 'TOTAL');
    assert.equal(fake.inputs[0].ReturnItemCollectionMetrics, 'SIZE');
});

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

        await new QueryBuilder('test', fake.db).get({id: 'consistent-get'}).consistent().toPromise();
        assert.throws(
            () => new QueryBuilder('test', fake.db).query({id: 'consistent-query'}).consistent().usingIndex('global-index'),
            /Global secondary index global-index does not support consistent reads/
        );
        await new QueryBuilder('test', fake.db).query({id: 'consistent-query'}).consistent().usingIndex('local-index', 'local').toPromise<any[]>();
        await new QueryBuilder('test', fake.db).getBatch<any>([{id: 'consistent-batch-get'}], {consistentRead: true});
        await new QueryBuilder('test', fake.db).scan().consistent().toPromise<any[]>();

        assert.equal(fake.inputs[0].ConsistentRead, true);
        assert.equal(fake.inputs[1].ConsistentRead, true);
        assert.equal(fake.inputs[1].IndexName, 'local-index');
        assert.equal(fake.inputs[2].RequestItems.test.ConsistentRead, true);
        assert.equal(fake.inputs[3].ConsistentRead, true);
    });

    test('forwards fluent metadata, projection, ordering, and write-return modifiers', async () => {
        const previous = {id: 'previous', value: 1};
        const capacity = {TableName: 'test', CapacityUnits: 0.5};
        const metrics = [{ItemCollectionKey: QuerySerializer.serialiseMap({id: 'previous'}), SizeEstimateRangeGB: [0, 0.1]}];
        const fake = createFakeDynamoDB((command) => {
            if (command.input.Key) {
                return {
                    Item: QuerySerializer.serialiseMap(command.input.ProjectionExpression === '#id' ? {id: previous.id} : previous),
                    ConsumedCapacity: capacity
                };
            }
            if (command.input.Item) {
                return {Attributes: QuerySerializer.serialiseMap(previous), ConsumedCapacity: capacity, ItemCollectionMetrics: metrics};
            }
            return {Items: [], ConsumedCapacity: capacity};
        });

        const get = new QueryBuilder('test', fake.db)
            .get({id: previous.id})
            .consistent()
            .select('id')
            .returnCapacity('TOTAL');
        const first = get.toResponse<{id: string} | null>();
        assert.strictEqual(first, get.toResponse());
        assert.deepEqual(await first, {
            value: {id: previous.id},
            consumedCapacity: [capacity],
            itemCollectionMetrics: []
        });

        const created = await new QueryBuilder('test', fake.db)
            .create({id: 'replacement', value: 2})
            .returningAllOld()
            .returnCapacity()
            .returnItemCollectionMetrics()
            .toResponse<typeof previous | null>();
        assert.equal(created.value?.id, previous.id);
        assert.deepEqual(created.consumedCapacity, [capacity]);
        assert.deepEqual(created.itemCollectionMetrics, metrics);

        await new QueryBuilder('test', fake.db)
            .query({id: 'ordered'})
            .descending()
            .returnCapacity('NONE')
            .toResponse<any[]>();

        assert.equal(fake.inputs[0].ConsistentRead, true);
        assert.equal(fake.inputs[0].ProjectionExpression, '#id');
        assert.equal(fake.inputs[0].ReturnConsumedCapacity, 'TOTAL');
        assert.equal(fake.inputs[1].ReturnValues, 'ALL_OLD');
        assert.equal(fake.inputs[1].ReturnItemCollectionMetrics, 'SIZE');
        assert.equal(fake.inputs[2].ScanIndexForward, false);
        assert.equal(fake.inputs[2].ReturnConsumedCapacity, 'NONE');
        assert.equal(fake.inputs.length, 3);
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
