import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {promises as fileSystem} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import 'fake-indexeddb/auto';
import {createEngine, QueryBuilder} from '../src/index';

function deleteIndexedDB(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error(`IndexedDB database is still open: ${name}`));
    });
}

for (const storage of ['file', 'browser'] as const) {
    test(`${storage} resumes deleted scan and index cursors after reopening`, async context => {
        const directory = await mkdtemp(join(tmpdir(), 'fluentful-cursors-'));
        const name = `fluentful-cursors-${Date.now()}-${Math.random()}`;
        const engines: Array<{close(): Promise<void>}> = [];
        context.after(async () => {
            await Promise.all(engines.map(engine => engine.close()));
            await rm(directory, {recursive: true, force: true});
            if (storage === 'browser') await deleteIndexedDB(name);
        });
        const open = () => {
            const engine = storage === 'file' ? createEngine.file(join(directory, 'state.json')) : createEngine.browser(name);
            engines.push(engine);
            return engine;
        };
        const first = open();
        await QueryBuilder.createTable({
            name: 'records', key: {partition: 'id'}, attributes: {id: 'S', category: 'S', rank: 'N'},
            indexes: {category: {kind: 'global', partition: 'category', sort: 'rank'}}
        }, first.db);
        const records = () => new QueryBuilder('records', first.db);
        await records().createBatch(['c', 'a', 'b'].map(id => ({id, category: 'c', rank: 1})));
        const scan = await records().scan().page({limit: 1});
        const index = await records().query({category: 'c'}).usingIndex('category').page({limit: 1});
        await records().delete({id: 'a'}).toPromise();
        await first.close();
        const restored = open();
        const read = () => new QueryBuilder('records', restored.db);
        const expected = ['b', 'c'].map(id => ({id, category: 'c', rank: 1}));
        assert.deepEqual((await read().scan().page({cursor: scan.cursor})).items, expected);
        assert.deepEqual((await read().query({category: 'c'}).usingIndex('category').page({cursor: index.cursor})).items, expected);
    });

    test(`${storage} preserves ordered multi-attribute index metadata`, async context => {
        const directory = await mkdtemp(join(tmpdir(), 'fluentful-multi-'));
        const name = `fluentful-multi-${Date.now()}-${Math.random()}`;
        const engines: Array<{close(): Promise<void>}> = [];
        context.after(async () => {
            await Promise.all(engines.map(engine => engine.close()));
            await rm(directory, {recursive: true, force: true});
            if (storage === 'browser') await deleteIndexedDB(name);
        });
        const open = () => {
            const engine = storage === 'file' ? createEngine.file(join(directory, 'state.json')) : createEngine.browser(name);
            engines.push(engine);
            return engine;
        };
        const definition = {name: 'records', key: {partition: 'id'},
            attributes: {id: 'S', tenant: 'S', region: 'N', rank: 'N', token: 'B'},
            indexes: {multi: {kind: 'global', partition: ['tenant', 'region'], sort: ['rank', 'token']},
                scalar: {kind: 'global', partition: 'tenant'}}} as const;
        const first = open();
        await QueryBuilder.createTable(definition, first.db);
        const record = {id: 'one', tenant: 't', region: 1, rank: 2, token: new Uint8Array([1])};
        await new QueryBuilder('records', first.db).create(record).toPromise();
        await first.close();
        const restored = open();
        assert.deepEqual(await QueryBuilder.getTableDefinition('records', restored.db), definition);
        assert.deepEqual(await new QueryBuilder('records', restored.db).query({tenant: 't', region: 1},
            {name: 'multi', ...definition.indexes.multi}).sortKey('rank').eq(2).toPromise(), [record]);
        await QueryBuilder.updateTable('records', restored.db, {deleteIndex: 'multi'});
        await QueryBuilder.updateTable('records', restored.db, {createIndex: {name: 'replacement',
            definition: definition.indexes.multi, attributes: {region: 'N', rank: 'N', token: 'B'}}});
        await restored.close();
        const reopened = open();
        assert.deepEqual(await new QueryBuilder('records', reopened.db).query({tenant: 't', region: 1},
            {name: 'replacement', ...definition.indexes.multi}).toPromise(), [record]);
        assert.equal((await QueryBuilder.getTableDefinition('records', reopened.db))?.indexes['multi'], undefined);
    });
}

test('file engines reject competing writers and recover from corrupt snapshots', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'fluentful-orm-errors-'));
    const path = join(directory, 'state.json');
    context.after(() => rm(directory, {recursive: true, force: true}));
    for (const content of ['{', JSON.stringify({version: 2, tables: []}), JSON.stringify({version: 1, tables: [null]}),
        JSON.stringify({version: 1, tables: [{description: {TableName: 'records'}, items: []}]}),
        JSON.stringify({version: 1, tables: [], corrupt: {fluentfulBinary: [256]}})]) {
        await writeFile(path, content);
        const broken = createEngine.file(path);
        await assert.rejects(QueryBuilder.listTables(broken.db));
        await Promise.all([broken.close(), broken.close()]);
    }
    await rm(path);
    const first = createEngine.file(path);
    await QueryBuilder.createTable('records', 'id', first.db);
    const second = createEngine.file(path);
    await assert.rejects(QueryBuilder.listTables(second.db), /already has a writer/);
    await second.close();
    await first.close();
    const restored = createEngine.file(path);
    assert.deepEqual(await QueryBuilder.listTables(restored.db), ['records']);
    await restored.close();
});

test('IndexedDB rejects stale writers and persists transaction tokens', async (context) => {
    const name = `fluentful-orm-writers-${Date.now()}-${Math.random()}`;
    const engines: Array<{close(): Promise<void>}> = [];
    context.after(async () => {
        await Promise.all(engines.map(engine => engine.close()));
        await deleteIndexedDB(name);
    });
    const first = createEngine.browser(name);
    engines.push(first);
    await QueryBuilder.createTable('records', 'id', first.db);
    const second = createEngine.browser(name);
    engines.push(second);
    await QueryBuilder.listTables(second.db);
    const transaction = (engine: typeof first) => QueryBuilder.transactWrite(engine.db).clientRequestToken('durable-token')
        .add('records', query => query.update({id: 'one'}).add('count').eq(1));
    await transaction(first).toPromise();
    await assert.rejects(new QueryBuilder('records', second.db).create({id: 'lost'}).toPromise(), /another engine/);
    assert.equal(await new QueryBuilder('records', second.db).get({id: 'lost'}).toPromise(), null);
    await first.close();
    await second.close();
    const restored = createEngine.browser(name);
    engines.push(restored);
    await transaction(restored).toPromise();
    assert.deepEqual(await new QueryBuilder('records', restored.db).get({id: 'one'}).toPromise(), {id: 'one', count: 1});
});

test('failed file rename preserves durable state and removes temporary output', async context => {
    const directory = await mkdtemp(join(tmpdir(), 'fluentful-orm-rename-'));
    const path = join(directory, 'state.json');
    const engine = createEngine.file(path);
    context.after(async () => { await engine.close(); await rm(directory, {recursive: true, force: true}); });
    await QueryBuilder.createTable('records', 'id', engine.db);
    const failure = new Error('Injected rename failure');
    const mock = context.mock.method(fileSystem, 'rename', async () => { throw failure; });
    syncBuiltinESMExports();
    try {
        await assert.rejects(new QueryBuilder('records', engine.db).create({id: 'failed'}).toPromise(), error => error === failure);
    } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
    }
    assert.equal(await new QueryBuilder('records', engine.db).get({id: 'failed'}).toPromise(), null);
    await assert.rejects(fileSystem.stat(`${path}.tmp`), {code: 'ENOENT'});
    const pending = new QueryBuilder('records', engine.db).create({id: 'accepted'}).toPromise();
    const closing = engine.close();
    await pending;
    await closing;
    const restored = createEngine.file(path);
    try { assert.deepEqual(await new QueryBuilder('records', restored.db).scan().toPromise(), [{id: 'accepted'}]); }
    finally { await restored.close(); }
});

test('IndexedDB aborted transactions roll back and version changes release connections', async context => {
    const name = `fluentful-orm-abort-${Date.now()}-${Math.random()}`;
    const engine = createEngine.browser(name);
    context.after(async () => { await engine.close(); await deleteIndexedDB(name); });
    await QueryBuilder.createTable('records', 'id', engine.db);
    const original = IDBObjectStore.prototype.put;
    const mock = context.mock.method(IDBObjectStore.prototype, 'put', function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const request = original.call(this, value, key);
        this.transaction.abort();
        return request;
    });
    try { await assert.rejects(new QueryBuilder('records', engine.db).create({id: 'aborted'}).toPromise()); }
    finally { mock.mock.restore(); }
    assert.equal(await new QueryBuilder('records', engine.db).get({id: 'aborted'}).toPromise(), null);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Engine failed to release version-changing connection'));
    });
    upgraded.close();
});

test('IndexedDB blocked opens fail explicitly and close late connections', async context => {
    const name = `fluentful-orm-blocked-${Date.now()}-${Math.random()}`;
    const original = indexedDB.open.bind(indexedDB);
    const mock = context.mock.method(indexedDB, 'open', (...args: Parameters<IDBFactory['open']>) => {
        const request = original(...args);
        queueMicrotask(() => request.onblocked?.call(request, {} as IDBVersionChangeEvent));
        return request;
    });
    const engine = createEngine.browser(name);
    try { await assert.rejects(QueryBuilder.listTables(engine.db), /blocked/); }
    finally { mock.mock.restore(); await engine.close(); }
    await deleteIndexedDB(name);
});

test('file engine restores tables, records, and binary values', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'fluentful-orm-'));
    const path = join(directory, 'engine.json');
    const engines: Array<{close(): Promise<void>}> = [];
    context.after(async () => {
        await Promise.all(engines.map((engine) => engine.close()));
        await rm(directory, {recursive: true, force: true});
    });

    const first = createEngine.file(path);
    engines.push(first);
    await QueryBuilder.createTable('records', 'id', first.db);
    await new QueryBuilder('records', first.db).create({
        id: 'one',
        bytes: Buffer.from([1, 2, 3]),
        binaries: new Set([Buffer.from([4, 5])])
    }).toPromise();
    await first.close();

    const restored = createEngine.file(path);
    engines.push(restored);
    assert.deepEqual(
        await new QueryBuilder('records', restored.db).get({id: 'one'}).toPromise(),
        {id: 'one', bytes: new Uint8Array([1, 2, 3]), binaries: new Set([new Uint8Array([4, 5])])}
    );
    await restored.reset();
    await restored.close();

    const reset = createEngine.file(path);
    engines.push(reset);
    assert.equal(await new QueryBuilder('records', reset.db).get({id: 'one'}).toPromise(), null);
});

test('file engine persists each successful mutation and rolls back failed transactions', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'fluentful-orm-'));
    const path = join(directory, 'engine.json');
    const engines: Array<{close(): Promise<void>}> = [];
    context.after(async () => {
        await Promise.all(engines.map((engine) => engine.close()));
        await rm(directory, {recursive: true, force: true});
    });

    let engine = createEngine.file(path);
    engines.push(engine);
    const restart = async () => {
        await engine.close();
        engine = createEngine.file(path);
        engines.push(engine);
    };
    const records = () => new QueryBuilder('records', engine.db);

    await QueryBuilder.createTable('records', 'id', engine.db);
    await QueryBuilder.createTable('temporary', 'id', engine.db);
    await restart();
    assert.deepEqual(await QueryBuilder.listTables(engine.db), ['records', 'temporary']);

    await records().create({id: 'first', status: 'created'}).toPromise();
    await restart();
    assert.deepEqual(await records().get({id: 'first'}).toPromise(), {id: 'first', status: 'created'});

    await records().update({id: 'first'}).set('status').eq('updated').toPromise();
    await restart();
    assert.deepEqual(await records().get({id: 'first'}).toPromise(), {id: 'first', status: 'updated'});

    await records().createBatch([
        {id: 'batch-a', status: 'created'},
        {id: 'batch-b', status: 'created'}
    ]);
    await restart();
    assert.deepEqual(
        (await records().scan().toPromise<Array<{id: string}>>()).map((record) => record.id).sort(),
        ['batch-a', 'batch-b', 'first']
    );

    await records().deleteBatch([{id: 'batch-a'}]);
    await restart();
    assert.equal(await records().get({id: 'batch-a'}).toPromise(), null);

    await QueryBuilder.transactWrite(engine.db)
        .add('records', (query) => query.update({id: 'first'}).set('status').eq('committed'))
        .add('records', (query) => query.create({id: 'transaction', status: 'created'}))
        .toPromise();
    await restart();
    assert.deepEqual(await records().get({id: 'first'}).toPromise(), {id: 'first', status: 'committed'});
    assert.deepEqual(await records().get({id: 'transaction'}).toPromise(), {id: 'transaction', status: 'created'});

    await assert.rejects(
        QueryBuilder.transactWrite(engine.db)
            .add('records', (query) => query.update({id: 'first'}).set('status').eq('rolled-back'))
            .add('records', (query) => query.conditionCheck({id: 'batch-b'}).where('status').eq('missing'))
            .toPromise()
    );
    await restart();
    assert.deepEqual(await records().get({id: 'first'}).toPromise(), {id: 'first', status: 'committed'});

    await QueryBuilder.deleteTable('temporary', engine.db);
    await restart();
    assert.deepEqual(await QueryBuilder.listTables(engine.db), ['records']);
});

test('failed IndexedDB saves restore every mutation and transaction token', async (context) => {
    const name = `fluentful-orm-rollback-${Date.now()}-${Math.random()}`;
    const engine = createEngine.browser(name);
    context.after(async () => {
        await engine.close();
        await deleteIndexedDB(name);
    });
    const records = () => new QueryBuilder('records', engine.db);
    await QueryBuilder.createTable('records', 'id', engine.db);
    await records().create({id: 'one', value: 1}).toPromise();
    const transaction = () => QueryBuilder.transactWrite(engine.db).clientRequestToken('retry-save')
        .add('records', query => query.update({id: 'one'}).set('value').eq(2));
    const mutations = [
        () => records().create({id: 'two'}).toPromise(),
        () => records().update({id: 'one'}).set('value').eq(2).toPromise(),
        () => records().delete({id: 'one'}).toPromise(),
        () => records().createBatch([{id: 'two'}]),
        () => records().deleteBatch([{id: 'one'}]),
        () => transaction().toPromise(),
        () => QueryBuilder.createTable('temporary', 'id', engine.db),
        () => QueryBuilder.deleteTable('records', engine.db),
        () => QueryBuilder.updateTable('records', engine.db, {createIndex: {name: 'value',
            definition: {kind: 'global', partition: 'value'}, attributes: {value: 'N'}}}),
        () => engine.reset()
    ];
    const failure = new Error('Injected save failure');
    for (const mutate of mutations) {
        const mock = context.mock.method(IDBObjectStore.prototype, 'put', () => { throw failure; });
        await assert.rejects(mutate(), error => error === failure);
        mock.mock.restore();
        assert.deepEqual(await QueryBuilder.listTables(engine.db), ['records']);
        assert.deepEqual(await records().scan().toPromise(), [{id: 'one', value: 1}]);
        assert.deepEqual((await QueryBuilder.getTableDefinition('records', engine.db))?.indexes, {});
    }
    await QueryBuilder.updateTable('records', engine.db, {createIndex: {name: 'value',
        definition: {kind: 'global', partition: 'value'}, attributes: {value: 'N'}}});
    const deletion = context.mock.method(IDBObjectStore.prototype, 'put', () => { throw failure; });
    await assert.rejects(QueryBuilder.updateTable('records', engine.db, {deleteIndex: 'value'}), error => error === failure);
    deletion.mock.restore();
    assert.deepEqual((await QueryBuilder.getTableDefinition('records', engine.db))?.indexes,
        {value: {kind: 'global', partition: 'value'}});
    await QueryBuilder.updateTable('records', engine.db, {deleteIndex: 'value'});
    await transaction().toPromise();
    await engine.close();
    const restored = createEngine.browser(name);
    try {
        assert.deepEqual(await new QueryBuilder('records', restored.db).scan().toPromise(), [{id: 'one', value: 2}]);
    } finally {
        await restored.close();
    }
});

test('IndexedDB engine restores records and persists reset', async (context) => {
    const name = `fluentful-orm-${Date.now()}-${Math.random()}`;
    const engines: Array<{close(): Promise<void>}> = [];
    context.after(async () => {
        await Promise.all(engines.map((engine) => engine.close()));
        await deleteIndexedDB(name);
    });

    const first = createEngine.browser(name);
    engines.push(first);
    await QueryBuilder.createTable('records', 'id', first.db);
    await new QueryBuilder('records', first.db).create({
        id: 'one',
        metadata: {version: 1},
        bytes: new Uint8Array([1, 2, 3])
    }).toPromise();
    await first.close();

    const restored = createEngine.browser(name);
    engines.push(restored);
    assert.deepEqual(
        await new QueryBuilder('records', restored.db).get({id: 'one'}).toPromise(),
        {id: 'one', metadata: {version: 1}, bytes: new Uint8Array([1, 2, 3])}
    );
    await restored.reset();
    await restored.close();

    const reset = createEngine.browser(name);
    engines.push(reset);
    assert.equal(await new QueryBuilder('records', reset.db).get({id: 'one'}).toPromise(), null);
});
