import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {QueryBuilder} from '../src/query-builder';
import {QuerySerializer} from '../src/query-serializer';
import {Quewe} from '../src/quewe';
import {createFakeDynamoDB} from './fake-dynamodb';

describe('query - QueryBuilder pagination and batches', () => {
    test('returns one page and resumes from its cursor', async () => {
        const fake = createFakeDynamoDB((command, attempt) => {
            if (attempt === 1) {
                return {
                    Items: [QuerySerializer.serialiseMap({id: 'page-a'})],
                    LastEvaluatedKey: QuerySerializer.serialiseMap({id: 'page-a'})
                };
            }

            assert.equal(command.input.ExclusiveStartKey.id.S, 'page-a');
            return {Items: [QuerySerializer.serialiseMap({id: 'page-b'})]};
        });

        const first = await new QueryBuilder('test', fake.db).scan().page<any>({limit: 1});
        const second = await new QueryBuilder('test', fake.db).scan().page<any>({limit: 1, cursor: first.cursor});

        assert.deepEqual(first, {items: [{id: 'page-a'}], cursor: {id: 'page-a'}});
        assert.deepEqual(second, {items: [{id: 'page-b'}], cursor: null});
        assert.equal(fake.inputs.length, 2);
        assert.equal(fake.inputs[0].Limit, 1);
    });

    test('iterates pages lazily and stops without fetching the next page', async () => {
        const fake = createFakeDynamoDB(() => ({
            Items: [QuerySerializer.serialiseMap({id: 'lazy'})],
            LastEvaluatedKey: QuerySerializer.serialiseMap({id: 'lazy'})
        }));
        const pages = new QueryBuilder('test', fake.db).scan().pages<any>({limit: 1});

        for await (const page of pages) {
            assert.deepEqual(page.items, [{id: 'lazy'}]);
            break;
        }

        assert.equal(fake.inputs.length, 1);
    });

    test('snapshots a lazy cursor before iteration and between pages', async () => {
        const fake = createFakeDynamoDB((command, attempt) => attempt === 1
            ? {
                Items: [QuerySerializer.serialiseMap({id: 'first'})],
                LastEvaluatedKey: QuerySerializer.serialiseMap({id: 'next'})
            }
            : {Items: []});
        const cursor = {id: 'before'};
        const pages = new QueryBuilder('test', fake.db).scan().pages<any>({cursor});
        cursor.id = 'mutated-before-iteration';

        const iterator = pages[Symbol.asyncIterator]();
        const first = await iterator.next();
        assert.equal(fake.inputs[0].ExclusiveStartKey.id.S, 'before');
        assert.equal(first.done, false);
        (first.value as any).cursor.id = 'mutated-after-first-page';
        await iterator.next();

        assert.equal(fake.inputs[1].ExclusiveStartKey.id.S, 'next');
    });

    test('item iteration crosses empty filtered pages', async () => {
        const fake = createFakeDynamoDB((command, attempt) => attempt === 1
            ? {Items: [], LastEvaluatedKey: QuerySerializer.serialiseMap({id: 'empty-page'})}
            : {Items: [QuerySerializer.serialiseMap({id: 'matched'})]});
        const items: any[] = [];

        for await (const item of new QueryBuilder('test', fake.db).scan().items<any>({limit: 1})) {
            items.push(item);
        }

        assert.deepEqual(items, [{id: 'matched'}]);
        assert.equal(fake.inputs[1].ExclusiveStartKey.id.S, 'empty-page');
    });

    test('rejects invalid page options, repeat execution, and iterator service failures', async () => {
        const invalid = new QueryBuilder('test', createFakeDynamoDB().db).scan();
        assert.throws(() => invalid.page({limit: 0}), /positive integer/);
        await invalid.page();
        assert.throws(() => new QueryBuilder('test', createFakeDynamoDB().db).scan().pages({cursor: {}}), /at least one key/);

        const fake = createFakeDynamoDB(() => ({Items: []}));
        const query = new QueryBuilder('test', fake.db).scan();
        await query.page();
        assert.throws(() => query.pages(), /only be executed once/);
        assert.throws(() => query.toPromise(), /only be executed once/);

        const serviceError = new Error('page failed');
        const failing = createFakeDynamoDB(() => {
            throw serviceError;
        });
        const iterator = new QueryBuilder('test', failing.db).scan().items();
        await assert.rejects(iterator[Symbol.asyncIterator]().next(), (error) => error === serviceError);
    });

    test('counts matches across pages without loading items', async () => {
        const fake = createFakeDynamoDB((command, attempt) => attempt === 1
            ? {Count: 2, ScannedCount: 4, LastEvaluatedKey: QuerySerializer.serialiseMap({id: 'count-page'})}
            : {Count: 1, ScannedCount: 3});

        const count = await new QueryBuilder('test', fake.db)
            .scan()
            .limit(4, null)
            .where('status').eq('active')
            .count()
            .toPromise();

        assert.equal(count, 3);
        assert.equal(fake.inputs.length, 2);
        assert.equal(fake.inputs[0].Select, 'COUNT');
        assert.equal(fake.inputs[1].ExclusiveStartKey.id.S, 'count-page');
    });

    test('returns zero for missing count and propagates count service failures', async () => {
        const empty = createFakeDynamoDB(() => ({}));
        assert.equal(await new QueryBuilder('test', empty.db).scan().count().toPromise(), 0);

        const serviceError = new Error('count failed');
        const failing = createFakeDynamoDB(() => {
            throw serviceError;
        });
        await assert.rejects(
            new QueryBuilder('test', failing.db).query({id: 'count'}).count().toPromise(),
            (error) => error === serviceError
        );
    });

    test('carries scan start keys and applies the hard limit', async () => {
        const logs: any[] = [];
        const fake = createFakeDynamoDB((command, attempt) => {
            if (attempt === 1) {
                return {
                    Items: [
                        QuerySerializer.serialiseMap({id: 'page-1-a'}),
                        QuerySerializer.serialiseMap({id: 'page-1-b'})
                    ],
                    LastEvaluatedKey: QuerySerializer.serialiseMap({id: 'page-1-b'})
                };
            }

            assert.equal(command.input.ExclusiveStartKey.id.S, 'page-1-b');
            return {
                Items: [
                    QuerySerializer.serialiseMap({id: 'page-2-a'}),
                    QuerySerializer.serialiseMap({id: 'page-2-b'})
                ]
            };
        });

        const result = await new QueryBuilder('test', fake.db)
            .logger((message) => logs.push(message))
            .scan()
            .limit(2, 3)
            .toPromise<any[]>();

        assert.deepEqual(result.map((item) => item.id), ['page-1-a', 'page-1-b', 'page-2-a']);
        assert.equal(fake.inputs.length, 2);
        assert.deepEqual(logs.map((message) => message.event || message.method), [
            'scan',
            'scan',
            'next_page',
            'scan',
            'scan'
        ]);
        assert.deepEqual(logs.filter((message) => message.result).map((message) => message.result.count), [2, 2]);
    });

    test('runs queued write chunks serially', async () => {
        const chunkSizes: number[] = [];
        let activeRequests = 0;
        let maximumActiveRequests = 0;
        const db = {
            send: (command: any) => {
                activeRequests++;
                maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
                chunkSizes.push(command.input.RequestItems.test.length);

                return Promise.resolve({}).then((result) => {
                    activeRequests--;
                    return result;
                });
            }
        } as unknown as DynamoDBClient;
        const documents = Array.from({length: 26}).map((_, index) => ({id: `queued-${index}`}));

        const result = await new QueryBuilder('test', db).createBatch<any>(documents, true);

        assert.equal(result.length, 26);
        assert.deepEqual(chunkSizes.sort((left, right) => left - right), [1, 25]);
        assert.equal(maximumActiveRequests, 1);
    });

    test('handles empty, exact, and over-limit chunk boundaries', async () => {
        const writeSizes: number[] = [];
        const getSizes: number[] = [];
        const fake = createFakeDynamoDB((command) => {
            const tableRequest = command.input.RequestItems.test;

            if (Array.isArray(tableRequest)) {
                writeSizes.push(tableRequest.length);
                return {};
            }

            getSizes.push(tableRequest.Keys.length);
            return {Responses: {test: []}};
        });
        const twentyFive = Array.from({length: 25}).map((_, index) => ({id: `boundary-25-${index}`}));
        const twentySix = Array.from({length: 26}).map((_, index) => ({id: `boundary-26-${index}`}));
        const oneHundred = Array.from({length: 100}).map((_, index) => ({id: `boundary-100-${index}`}));
        const oneHundredOne = Array.from({length: 101}).map((_, index) => ({id: `boundary-101-${index}`}));

        assert.deepEqual(await new QueryBuilder('test', fake.db).createBatch<any>([]), []);
        assert.deepEqual(await new QueryBuilder('test', fake.db).getBatch<any>([]), []);
        await new QueryBuilder('test', fake.db).deleteBatch([]);
        assert.equal(fake.inputs.length, 0);

        await new QueryBuilder('test', fake.db).createBatch<any>(twentyFive);
        await new QueryBuilder('test', fake.db).deleteBatch(twentyFive);
        await new QueryBuilder('test', fake.db).deleteBatch(twentySix);
        await new QueryBuilder('test', fake.db).getBatch<any>(oneHundred);
        await new QueryBuilder('test', fake.db).getBatch<any>(oneHundredOne);

        assert.deepEqual(writeSizes, [25, 25, 25, 1]);
        assert.deepEqual(getSizes, [100, 100, 1]);
    });

    test('runs unqueued chunks concurrently', async () => {
        const resolvers: (() => void)[] = [];
        let activeRequests = 0;
        let maximumActiveRequests = 0;
        const db = {
            send: () => {
                activeRequests++;
                maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);

                return new Promise((resolve) => {
                    resolvers.push(() => {
                        activeRequests--;
                        resolve({});
                    });
                });
            }
        } as unknown as DynamoDBClient;
        const documents = Array.from({length: 26}).map((_, index) => ({id: `parallel-${index}`}));

        const work = new QueryBuilder('test', db).createBatch<any>(documents, false);
        resolvers.forEach((resolve) => resolve());
        const result = await work;

        assert.equal(result.length, 26);
        assert.equal(maximumActiveRequests, 2);
    });

    test('bounds default and configured batch concurrency', async () => {
        const measureConcurrency = async (concurrency: number | undefined) => {
            const resolvers: (() => void)[] = [];
            let activeRequests = 0;
            let maximumActiveRequests = 0;
            const db = {
                send: () => {
                    activeRequests++;
                    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
                    return new Promise((resolve) => resolvers.push(() => {
                        activeRequests--;
                        resolve({});
                    }));
                }
            } as unknown as DynamoDBClient;
            const documents = Array.from({length: 126}).map((_, index) => ({id: `bounded-${index}`}));
            const work = concurrency === undefined
                ? new QueryBuilder('test', db).createBatch(documents)
                : new QueryBuilder('test', db).createBatch(documents, {concurrency: concurrency});

            while (activeRequests > 0 || resolvers.length > 0) {
                resolvers.splice(0).forEach((resolve) => resolve());
                await new Promise((resolve) => setImmediate(resolve));
            }
            await work;
            return maximumActiveRequests;
        };

        assert.equal(await measureConcurrency(undefined), 4);
        assert.equal(await measureConcurrency(2), 2);
    });

    test('rejects invalid batch concurrency and stops scheduling after worker failure', async () => {
        assert.throws(
            () => new QueryBuilder('test', createFakeDynamoDB().db).createBatch([{id: 'invalid'}], {concurrency: 0}),
            /positive integer/
        );

        let requests = 0;
        const serviceError = new Error('batch worker failed');
        const db = {
            send: async () => {
                requests++;
                if (requests === 1) {
                    throw serviceError;
                }
                return {};
            }
        } as unknown as DynamoDBClient;
        const documents = Array.from({length: 101}).map((_, index) => ({id: `failure-${index}`}));

        await assert.rejects(
            new QueryBuilder('test', db).createBatch(documents, {concurrency: 1}),
            (error) => error === serviceError
        );
        assert.equal(requests, 1);

        let releaseActive: () => void = () => undefined;
        let concurrentRequests = 0;
        const concurrentDb = {
            send: () => {
                concurrentRequests++;
                if (concurrentRequests === 1) {
                    return Promise.reject(serviceError);
                }
                return new Promise((resolve) => (releaseActive = () => resolve({})));
            }
        } as unknown as DynamoDBClient;
        const concurrentWork = new QueryBuilder('test', concurrentDb).createBatch(documents, {concurrency: 2});
        let settled = false;
        const expectation = assert.rejects(concurrentWork, (error) => error === serviceError).finally(() => (settled = true));

        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        assert.equal(concurrentRequests, 2);
        releaseActive();
        await expectation;
        assert.equal(settled, true);
    });

    test('retries unprocessed keys and accumulates partial results', async (t) => {
        t.mock.method(Math, 'random', () => 0.5);
        const logs: any[] = [];
        const fake = createFakeDynamoDB((command, attempt) => {
            if (attempt === 1) {
                const tableRequest = command.input.RequestItems.test;
                return {
                    Responses: {test: [QuerySerializer.serialiseMap({id: 'partial-a'})]},
                    UnprocessedKeys: {
                        test: {
                            ConsistentRead: tableRequest.ConsistentRead,
                            Keys: [tableRequest.Keys[1]]
                        }
                    }
                };
            }

            assert.equal(command.input.RequestItems.test.Keys.length, 1);
            assert.equal(command.input.RequestItems.test.Keys[0].id.S, 'partial-b');
            return {Responses: {test: [QuerySerializer.serialiseMap({id: 'partial-b'})]}};
        });

        const result = await new QueryBuilder('test', fake.db)
            .logger((message) => logs.push(message))
            .getBatch<any>([{id: 'partial-a'}, {id: 'partial-b'}]);

        assert.deepEqual(result.map((item) => item.id), ['partial-a', 'partial-b']);
        assert.equal(fake.inputs.length, 2);
        assert.equal(logs.length, 5);
        assert.equal(logs[0].method, 'batchGetItem');
        assert.equal(logs[1].result.count, 1);
        assert.equal(logs[2].event, 'retry_unprocessed_batch');
        assert.equal(logs[2].attempt, 1);
        assert.equal(logs[2].delay, 13);
        assert.equal(logs[3].method, 'batchGetItem');
        assert.equal(logs[4].result.count, 2);
    });

    test('rejects after eight unprocessed-item retries', async (t) => {
        t.mock.timers.enable({apis: ['setTimeout']});
        const fake = createFakeDynamoDB((command) => ({
            Responses: {test: []},
            UnprocessedKeys: command.input.RequestItems
        }));

        const expectation = assert.rejects(
            new QueryBuilder('test', fake.db).getBatch<any>([{id: 'retry-exhaustion'}]),
            new Error('DynamoDB batch operation still had unprocessed items after 8 retries')
        );

        for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise((resolve) => setImmediate(resolve));
            t.mock.timers.runAll();
        }

        await expectation;
        assert.equal(fake.inputs.length, 9);
    });

    test('retries unprocessed batch writes', async () => {
        const fake = createFakeDynamoDB((command, attempt) => {
            return attempt === 1 ? {UnprocessedItems: command.input.RequestItems} : {};
        });

        const result = await new QueryBuilder('test', fake.db).createBatch<any>([{id: 'batch-write-retry'}]);

        assert.deepEqual(result, [{id: 'batch-write-retry'}]);
        assert.equal(fake.inputs.length, 2);
    });

    test('deduplicates batch get keys regardless of property order without serialising twice', async (t) => {
        const serialiseMap = QuerySerializer.serialiseMap;
        let serialisationCount = 0;
        t.mock.method(QuerySerializer, 'serialiseMap', (document: Record<string, unknown>) => {
            serialisationCount++;
            return serialiseMap(document);
        });
        const fake = createFakeDynamoDB((command) => ({
            Responses: {test: command.input.RequestItems.test.Keys}
        }));

        const result = await new QueryBuilder('test', fake.db).getBatch<any>([
            {id: 'dedupe-a', sort: 1},
            {sort: 1, id: 'dedupe-a'},
            {id: 'dedupe-b', sort: 2}
        ]);

        assert.equal(fake.inputs.length, 1);
        assert.deepEqual(
            fake.inputs[0].RequestItems.test.Keys.map((key: any) => key.id.S),
            ['dedupe-a', 'dedupe-b']
        );
        assert.deepEqual(result.map((item) => item.id).sort(), ['dedupe-a', 'dedupe-b']);
        assert.equal(serialisationCount, 3);
    });

    test('serialises queue pushes against in-flight work', async () => {
        const queue = new Quewe();
        const events: string[] = [];
        let releaseFirst: () => void = () => undefined;
        const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));

        const first = queue.push(() => {
            events.push('first-start');
            return firstGate.then(() => {
                events.push('first-end');
                return 'first-result';
            });
        });
        const second = queue.push(() => {
            events.push('second-start');
            return 'second-result';
        });

        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(events, ['first-start']);

        releaseFirst();
        assert.equal(await first, 'first-result');
        assert.equal(await second, 'second-result');
        assert.deepEqual(events, ['first-start', 'first-end', 'second-start']);
    });

    test('propagates queue work failures and keeps processing', async () => {
        const queue = new Quewe();

        await assert.rejects(
            queue.push(() => Promise.reject(new Error('queue-failure'))),
            new Error('queue-failure')
        );
        assert.equal(await queue.push(() => 'after-failure'), 'after-failure');
    });
});
