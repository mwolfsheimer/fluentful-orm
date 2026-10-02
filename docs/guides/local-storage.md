# Use memory, files, or browser storage

Run without AWS, or keep local records between application runs. Start with the [first application](../getting-started/first-application.md) before choosing persistence.

Applications can inject a DynamoDB-compatible engine instead of an AWS client. The existing memory engine is process-local, while file and IndexedDB engines persist the same table and record model.

```ts
import {createEngine, defineTable, QueryBuilder} from '@fluentful/orm';
import {z} from 'zod';

const engine = createEngine.memory();
// const engine = createEngine.file('./data/fluentful-orm.json');
// const engine = createEngine.browser('my-browser-app');

try {
    await QueryBuilder.createTable('accounts', 'id', engine.db);

    const accounts = defineTable({
        name: 'accounts',
        key: {partition: 'id'},
        schema: z.object({id: z.string(), credits: z.number()})
    }).using(engine.db);

    await accounts.create({id: 'account-1', credits: 10}).toPromise();
    await accounts.update({id: 'account-1'})
        .add('credits').eq(-1)
        .where('credits').gte(1)
        .toPromise();

    const account = await accounts.get({id: 'account-1'}).toPromise();
    // account: {id: 'account-1', credits: 9}

    await engine.reset();
} finally {
    await engine.close();
}
```

Pass `engine.db` into application constructors that already accept `DynamoDBClient`, or use it with the lower-level `new QueryBuilder(tableName, engine.db)`. Seed records through normal create/batch APIs. `reset()` clears records and transaction request tokens but retains table definitions. It returns a promise so file and IndexedDB changes are durably written before it resolves. `close()` destroys the client and rejects later requests; file and IndexedDB engines keep their stored snapshot for the next instance. Closing more than once is safe.

Persistent mutations roll back live records, definitions, and transaction tokens if saving fails. `close()` drains accepted requests and releases storage even after failed initialization. File snapshots preserve both `Uint8Array` and Node `Buffer` inputs as binary values, including binary sets. Unexpired transaction tokens survive reopening; `reset()` removes them.

File engines allow one writer per snapshot, enforced with a sibling `.lock` file. Always close the engine before reopening that path. After a process crash, remove a stale lock only after verifying that no writer remains; locks are not automatically stolen. Use one canonical path, avoiding symlink aliases. IndexedDB engines detect stale snapshot writes across instances/tabs and reject them instead of overwriting another writer's work. Close and reopen a stale engine before retrying; its reads remain its own snapshot, not live cross-tab reads. These backends do not promise power-loss durability or distributed locking.

Tables must be declared before use. Supply QueryBuilder-owned `DynamoDBTableDefinition` values as the optional second argument to `createEngine.file(path, [definition, ...])`, or to `createEngine.memory([definition, ...])` and `createEngine.browser(name, [definition, ...])`, for synchronous initialisation. You can also use `await QueryBuilder.createTable(definition, engine.db)`. Both paths use the same validation and translation, supporting composite keys, attribute types, global/local indexes and optional index projections without AWS request fields. Existing SDK `CreateTableCommandInput` constructor inputs remain supported for compatibility. Typed `defineTable()` describes application validation and does not create storage tables. Index projections support `ALL`, `KEYS_ONLY` and `INCLUDE`; omission preserves the existing `ALL` default.

Supported QueryBuilder behaviour:

- Create, get, replace, update/upsert and delete; update/delete return modes; timestamps; batch operations.
- Scalar, binary, list, map and set values through the existing serializer, with cloned reads and writes to avoid shared references.
- Generated conditions and filters: comparisons, stored-field references, `IN`, `BETWEEN`, `contains`, `begins_with`, existence/type checks, `size`, negation and scoped `AND`/`OR` groups.
- `SET`, `REMOVE`, numeric/set `ADD`, and set `DELETE` updates.
- Table/index queries and scans, sparse index membership, query sort ordering, nested projections, counts, page cursors and iterators. Page limits apply before filters, including empty filtered pages with continuation cursors. String ordering uses UTF-8 bytes, binary ordering/equality uses unsigned bytes regardless of JavaScript binary prototypes, and numeric ordering is numeric.
- Atomic cross-table write transactions and condition checks, rollback on failure, conditional failure diagnostics, duplicate-target rejection, and ten-minute transaction request-token idempotency. Typed tables and typed transactions use the same backend.
- Create, describe, list and delete table operations.

This is a test stub for the promise-based SDK commands and expression subset generated by QueryBuilder, not a general DynamoDB emulator. Unsupported commands and expression syntax throw rather than succeed silently. It does not reproduce every AWS request-validation rule, capacity/throttling, retries/unprocessed batches, TTL expiry, streams, IAM, eventual consistency, distributed transaction conflicts, SDK middleware/callbacks, or item/response byte-size limits. Numbers follow QueryBuilder's JavaScript-number serialization. Reads are immediately consistent. Table/index queries and scans resume from cursor key values even after deletion, index-key changes, or sparse index exit; no retained cursor record or tombstone is required. Pagination is not a snapshot. Raw SDK features outside the listed subset are not part of this contract.

Memory scans now use deterministic key order instead of insertion order: index partition/sort keys (or table keys), then base-table keys to break ties. Index queries use index sort keys, then base-table keys, reversing the complete order for descending reads. These scan/tie orders are not AWS guarantees. Restart in-progress memory scans/index queries when upgrading from the insertion-order implementation rather than reusing old cursors. Moving an index entry across a cursor can cause that item to be skipped or returned again; applications must not treat pagination as a stable snapshot. Parallel-scan cursors must stay with their original segment. Key-based continuation also survives file/IndexedDB reopening.

Memory additionally supports structured SET operands, sparse updated images, atomic read transactions, multi-attribute GSIs, and deterministic GSI creation/deletion over existing records. Index-definition changes persist with file/IndexedDB snapshots. Invalid existing index-key values reject memory index creation atomically; this does not simulate AWS backfill behavior. Provisioned capacity changes and TTL configuration are explicitly unsupported by memory.

## Shared backend tests

For contributor commands and live-service probe budgets, see [testing](../maintainers/testing.md).

`test/query-builder.contract.ts` defines the behavioural tests once and accepts a backend client. The memory and real DynamoDB runners execute the same test bodies and assertions, including CRUD, conditions, pagination, batches, typed operations and transactions. Add application-visible query behaviour tests to this shared suite rather than creating a separate fake-only copy.

From this package:

- `npm test` builds the package and runs the command-construction/serialization unit tests, the shared contract against memory, and fake-specific lifecycle checks. No AWS access is required.
- `npm run test:memory` runs only the shared memory contract and fake-specific lifecycle checks.
- `npm run test:persistence` runs the file-engine persistence tests directly.
- `npm run test:consumer` checks packaged declarations, CJS/ESM loading, and browser bundling without launching a browser.
- `npm run test:browser` additionally installs Chromium and executes the IndexedDB/typed API smoke fixture at desktop and mobile viewport sizes.
- `npm run test:integration` runs the shared contract against real DynamoDB only, after credential and `ListTables` preflight. It fails if credentials are unavailable. Each run tracks uniquely named temporary tables, uses an independent cleanup deadline, and reports possible orphan table names on cleanup failure.

Command-construction, mocked retry/failure, and type-validation unit tests remain separate because they inspect generated requests or deliberately inject SDK responses. Only backend-specific behaviours such as memory reset/close and unsupported-operation errors belong in the fake lifecycle suite. Real AWS execution remains necessary to catch differences the stub does not model.

Service-only shared tests exercise byte-limited pages, oversized items, resulting updates, transactions, batch wire payloads, and expression limits. They are explicitly skipped in memory. CI includes a weekly/manual AWS job when repository variable `AWS_INTEGRATION_ROLE_ARN` is configured; `AWS_INTEGRATION_REGION` defaults to `eu-west-2`. Configure the role's GitHub OIDC trust and permissions for temporary test tables before enabling it. Tests create/delete real tables and incur AWS charges. The browser job runs independently of this credential-dependent job.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
