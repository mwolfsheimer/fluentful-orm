import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {ConditionalCheckFailedException, DynamoDBServiceException, ResourceNotFoundException, TransactionCanceledException, waitUntilTableExists, waitUntilTableNotExists} from '@aws-sdk/client-dynamodb';
import type {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {z} from 'zod';
import {QueryBuilder} from '../src/query-builder';
import {QuerySerializer} from '../src/query-serializer';
import type {DynamoDBTableDefinition} from '../src/query-table-admin';
import {defineTable, typedTransaction} from '../src/typed-table';

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

export const queryBuilderContract = (backendName: string, dynamoDBClient: DynamoDBClient, close: () => void | Promise<void>) => describe(`query - QueryBuilder contract: ${backendName}`, {concurrency: false}, () => {
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
        assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).get({id: record.id}, true).toPromise(), record);
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
                    const write = operation === 'update'
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
                        if ('returningAllNew' in write) {
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
                assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).get({id: record.id}, true).toPromise(), record);

                const updatedRecord = {...record, count: 2};
                assert.deepEqual(await execute(1), scenario.success === 'none'
                    ? undefined : operation === 'update' ? updatedRecord : record);
                assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).get({id: record.id}, true).toPromise(),
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
                assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).get({id: record.id}, true).toPromise(), record);
                const expectedValue = operation === 'create' ? replacement : operation === 'update' ? {...record, count: 2} : record;
                assert.deepEqual(await write(1).toResult(), {applied: true, value: expectedValue});
                assert.deepEqual(await new QueryBuilder(tableName, dynamoDBClient).get({id: record.id}, true).toPromise(),
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
            const record = await query().get({group: 1, id: Buffer.from('first')}, true).toPromise<{label: string}>();
            assert.equal(record.label, 'alpha');
            const matched = await query().query({group: 1}, true).sortKey('label').beginsWith('al')
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
            const local = await query().query({group: 1}, true)
                .usingIndex('label', 'local')
                .select('payload')
                .toPromise<any[]>();

            assert.deepEqual(account, [{group: 1, id: 'projected', account: 'account'}]);
            assert.deepEqual(stats, [{group: 1, id: 'projected', createdBy: 'creator'}]);
            assert.deepEqual(local, [{payload: 'base-only'}]);
            await assert.rejects(
                query().query({account: 'account'}).usingIndex('account').select('payload').toPromise(),
                DynamoDBServiceException
            );
            await assert.rejects(
                query().query({account: 'account'}).usingIndex('account').where('payload').eq('base-only').toPromise(),
                DynamoDBServiceException
            );
            await assert.rejects(
                query().query({group: 1}, true).usingIndex('label', 'local').where('payload').eq('base-only').toPromise(),
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
            false,
            true
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
            .query({id: 'paged-query'}, true)
            .limit(2, null)
            .toPromise<any[]>();
        assert.deepEqual(all.map((item) => item.sort), [1, 2, 3, 4, 5, 6]);

        const limited = await new QueryBuilder(compositeTableName, dynamoDBClient)
            .query({id: 'paged-query'}, true)
            .limit(2, 5)
            .toPromise<any[]>();
        assert.deepEqual(limited.map((item) => item.sort), [1, 2, 3, 4, 5]);

        const filtered = await new QueryBuilder(compositeTableName, dynamoDBClient)
            .query({id: 'paged-query'}, true)
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

        const first = await table.using(dynamoDBClient).query({id: 'cursor-query'}, true).page({limit: 2});
        const second = await table.using(dynamoDBClient).query({id: 'cursor-query'}, true).page({limit: 2, cursor: first.cursor});
        assert.deepEqual(first.items.map((item) => item.sort), [1, 2]);
        assert.deepEqual(first.cursor, {id: 'cursor-query', sort: 2});
        assert.deepEqual(second.items.map((item) => item.sort), [3, 4]);

        const streamed: number[] = [];
        for await (const item of table.using(dynamoDBClient).query({id: 'cursor-query'}, true).items({limit: 2})) {
            streamed.push(item.sort);
        }
        assert.deepEqual(streamed, [1, 2, 3, 4, 5]);

        await assert.rejects(
            table.using(dynamoDBClient).query({id: 'cursor-query'}, true).page({cursor: {id: 'cursor-query'}}),
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
            .scan(true)
            .limit(2, null)
            .where('group').eq('selected')
            .select('id', 'value')
            .toPromise();
        const count = await table.using(dynamoDBClient)
            .scan(true)
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
        assert.equal((await new QueryBuilder(tableName, dynamoDBClient).get({id: 'bounded-live-0'}, true).toPromise<any>()).value, 42);

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
        assert.equal(await new QueryBuilder(tableName, dynamoDBClient).get({id: 'bounded-live-0'}, true).toPromise(), null);

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
                .query({category: 'greeting'}, true)
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
        assert.deepEqual(await query().get({id: 'isolated-values'}, true).toPromise(), {
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
            .get({id: 'diagnostic-order', sort: 1}, true).toPromise(), null);
        assert.deepEqual(await query().get({id: 'diagnostic-balance'}, true).toPromise(), {id: 'diagnostic-balance', value: 1});
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
        assert.deepEqual(await records.get({id: 'concurrent-balance'}, true).toPromise(), {id: 'concurrent-balance', value: 0});
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
        assert.deepEqual(await query().get({id: 'idempotent-counter'}, true).toPromise(), {id: 'idempotent-counter', value: 1});
        await query().delete({id: 'idempotent-counter'}).toPromise();
    });
});
