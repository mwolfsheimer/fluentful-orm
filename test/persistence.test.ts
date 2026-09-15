import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
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
        bytes: new Uint8Array([1, 2, 3])
    }).toPromise();
    await first.close();

    const restored = createEngine.file(path);
    engines.push(restored);
    assert.deepEqual(
        await new QueryBuilder('records', restored.db).get({id: 'one'}).toPromise(),
        {id: 'one', bytes: new Uint8Array([1, 2, 3])}
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
