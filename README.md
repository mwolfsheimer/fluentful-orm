# @fluentful/orm

`@fluentful/orm` is a fluent wrapper around the AWS SDK v3 DynamoDB client. Its primary `QueryBuilder` API provides:

- schema-aware tables and inferred TypeScript results with Zod
- create, get, update, delete, query, and scan operations
- conditions and filters without writing DynamoDB expressions
- composite keys and secondary indexes
- projections, counts, cursors, and lazy async iteration
- chunked batch operations with bounded concurrency and retries
- atomic write transactions
- optional write timestamps and request logging

New code should normally use the typed API built around `defineTable()`. The lower-level `QueryBuilder` remains available for dynamic tables, incremental migration, and operations that do not have a schema definition.

## Install

```bash
npm install @fluentful/orm @aws-sdk/client-dynamodb@^3.1037.0 zod@^4.3.6
```

Supported environments are Node.js 20 or later and TypeScript 6. Install the required peer dependencies alongside the package: `@aws-sdk/client-dynamodb` ^3.1037.0 and `zod` ^4.3.6. Bring your own configured `DynamoDBClient`, or use the in-memory backend in tests and local workflows.

## License and contributions

@fluentful/orm is available under the [Apache License 2.0](LICENSE). Contributions are welcome under the [maintainer-led process](CONTRIBUTING.md) and require a [DCO sign-off](DCO.md). Pull requests are proposals; acceptance, review, merge, and release are not guaranteed.

## Contents

- [Quick start](#quick-start)
- [Define a table](#define-a-table)
- [Create and read records](#create-and-read-records)
- [Update records](#update-records)
- [Delete records](#delete-records)
- [Conditions](#conditions)
- [Queries and indexes](#queries-and-indexes)
- [Scans and filters](#scans-and-filters)
- [Projections and counts](#projections-and-counts)
- [Pagination and streaming](#pagination-and-streaming)
- [Batch operations](#batch-operations)
- [Transactions](#transactions)
- [Timestamps and logging](#timestamps-and-logging)
- [Values and serialization](#values-and-serialization)
- [Lower-level QueryBuilder](#lower-level-querybuilder)
- [Table administration](#table-administration)
- [In-memory backend](#in-memory-backend)
- [Errors and operational rules](#errors-and-operational-rules)
- [API reference](#api-reference)

## Quick start

```ts
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {z} from 'zod';
import {defineTable} from '@fluentful/orm';

const dynamoDB = new DynamoDBClient({region: 'eu-west-1'});

const taskSchema = z.object({
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    status: z.enum(['todo', 'doing', 'done']),
    title: z.string().min(1),
    priority: z.number().int().min(0),
    tags: z.set(z.string()).optional(),
    notes: z.string().optional(),
    createdAt: z.number().optional(),
    modifiedAt: z.number().optional()
}).strict();

const tasksTable = defineTable({
    name: 'tasks',
    schema: taskSchema,
    key: {partition: 'projectId', sort: 'taskId'},
    indexes: {
        'status-index': {kind: 'global', partition: 'status', sort: 'priority'}
    },
    timestamps: true
});

const tasks = tasksTable.using(dynamoDB);

await tasks.create({
    projectId: 'project-1',
    taskId: 'task-1',
    status: 'todo',
    title: 'Write the guide',
    priority: 10
}).where('projectId').not().exists().toPromise();

const task = await tasks.get({
    projectId: 'project-1',
    taskId: 'task-1'
}).toPromise();

const openTasks = await tasks
    .query({projectId: 'project-1'})
    .where('status').ne('done')
    .toPromise();
```

The schema is used at runtime as well as compile time. Inputs, keys, filter values, updates, projections, and records returned by DynamoDB are validated.

## In-memory backend

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

### Shared backend tests

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

## Define a table

Call `defineTable()` once and reuse the resulting definition. Call `.using(client)` where an operation needs to be performed. The typed factory is also available as `QueryBuilder.defineTable()`.

```ts
const tasksTable = defineTable({
    name: 'tasks',
    schema: taskSchema,
    key: {partition: 'projectId', sort: 'taskId'},
    indexes: {
        'status-index': {kind: 'global', partition: 'status', sort: 'priority'}
    },
    timestamps: true
});

const tasks = tasksTable.using(dynamoDB);
```

### Keys

A key definition has a required partition field and an optional sort field:

```ts
key: {partition: 'id'}
key: {partition: 'accountId', sort: 'createdAt'}
```

Key fields must be required schema fields whose output type is `string`, `number`, or `Uint8Array`. Exact operations such as `get`, `update`, and `delete` require the complete key and no extra properties. A `query` accepts only the partition key because sort-key restrictions are added through `.sortKey()`. Local indexes require a composite table key, the table's partition key, and an index sort key.

Indexes use the same key shape, plus a required `kind: 'global'` or `kind: 'local'`. Their names and key fields are inferred:

```ts
indexes: {
    'status-index': {kind: 'global', partition: 'status', sort: 'priority'},
    'owner-index': {kind: 'global', partition: 'ownerId'}
}
```

### Zod input and output types

`create()` and `createBatch()` accept the schema input type and store its parsed output. Schemas with transforms must provide an `outputSchema` for writes. This object schema validates stored values on reads, projections, and returned writes without running input transforms again; it must not itself contain transforms. Read-only definitions may still use a transforming `schema` without an `outputSchema`.

```ts
const measurements = defineTable({
    name: 'measurements',
    key: {partition: 'id'},
    schema: z.object({id: z.string(), value: z.string().transform(Number)}),
    outputSchema: z.object({id: z.string(), value: z.number()})
}).using(dynamoDB);
await measurements.create({id: 'one', value: '3'}).toPromise();
// Reads return {id: 'one', value: 3}, not a second transformation.
```

Partial `.with()` updates parse only supplied, defined fields; omitted defaults do not overwrite existing attributes. Numeric `ADD` validates a delta, and set `ADD`/`DELETE` validate member subsets, independently of whole-field bounds. Use conditions to protect stored invariants; returned records are still schema-validated. `create().returningAllOld()` returns a nullable record because a first insertion has no old item.

Use a strict object schema when records should not contain undeclared fields. If `timestamps: true` is enabled, declare optional numeric `createdAt` and `modifiedAt` fields in a strict schema as shown above.

## Create and read records

### Create

```ts
const created = await tasks.create({
    projectId: 'project-1',
    taskId: 'task-2',
    status: 'todo',
    title: 'Add examples',
    priority: 5
}).toPromise();
```

`created` is the validated record that was written. A put replaces an existing item with the same key unless a condition prevents it. A common create-only guard is:

```ts
await tasks.create(newTask)
    .where('projectId').not().exists()
    .toPromise();
```

### Get

```ts
const task = await tasks.get({
    projectId: 'project-1',
    taskId: 'task-2'
}).toPromise();
```

The result is the record or `null` when it does not exist. Call `.consistent()` for a strongly consistent table read:

```ts
const task = await tasks.get(key).consistent().toPromise();
```

Strongly consistent reads are not supported by DynamoDB global secondary indexes.

## Update records

Updates return the complete new record by default, or `null` if DynamoDB returns no attributes.

### Set several fields

```ts
const updated = await tasks.update(key).with({
    status: 'doing',
    title: 'Write and review the guide'
}).toPromise();
```

### Fluent update actions

Actions can be chained into one atomic item update:

```ts
const updated = await tasks.update(key)
    .set('status').eq('doing')
    .set('priority').eq(20)
    .remove('notes')
    .add('tags').eq(new Set(['documentation']))
    .delete('tags').eq(new Set(['draft']))
    .toPromise();
```

The actions map directly to DynamoDB update expression groups:

| Method | Purpose |
| --- | --- |
| `.with({...})` | `SET` every defined, non-key property in a partial document |
| `.set(field).eq(value)` | Set or replace a value |
| `.remove(field)` | Remove an attribute |
| `.add(field).eq(number)` | Increment or decrement a number |
| `.add(field).eq(set)` | Add members to a DynamoDB set |
| `.delete(field).eq(set)` | Remove members from a DynamoDB set |

When the same attribute receives several update actions, the last action wins.

### Prevent accidental upserts

DynamoDB `UpdateItem` creates an item when its key does not exist. Add an existence condition when the operation must only affect an existing item:

```ts
await tasks.update(key)
    .add('priority').eq(-1)
    .where('projectId').exists()
    .toPromise();
```

### Skip returned attributes

Use `.returningNone()` when the updated record is not needed. The inferred result is `Promise<void>` and DynamoDB does not return `ALL_NEW` attributes.

```ts
await tasks.update(key)
    .set('status').eq('done')
    .where('projectId').exists()
    .returningNone()
    .toPromise();
```

Updates support `returningAllNew()`, which is the default, or `returningNone()`. `returningAllNew()` returns the complete item after a successful update, including when an assigned value is unchanged.

### Structured SET assignments

Use `assign()` for stored-field copies and update functions; `.with()` and `.set().eq()` remain literal APIs.

```ts
import {defineTable, ifNotExists, listAppend, plus} from '@fluentful/orm';

const counters = defineTable({
    name: 'counters', key: {partition: 'id'},
    schema: z.object({id: z.string(), count: z.number(), previous: z.number(), labels: z.array(z.string())})
}).using(dynamoDB);

await counters.update({id: 'one'})
    .assign('previous', fields => fields.ref('count'))
    .assign('count', fields => plus(ifNotExists(fields.ref('count'), 0), 1))
    .assign('labels', fields => listAppend(ifNotExists(fields.ref('labels'), []), ['new']))
    .toPromise();
```

`literal(value)`, `ifNotExists(reference, fallback)`, `listAppend(left, right)`, `plus(left, right)`, and `minus(left, right)` produce isolated operand descriptors. Right-hand references read the pre-update record, even when that source field is updated in the same request. Arithmetic is one binary `+` or `-`, not arbitrary or nested arithmetic. Missing references, invalid operand types, and missing parent containers fail. `ifNotExists` distinguishes absent attributes from stored `null`.

The typed callback validates reference schema shapes and supplied literals. Numeric deltas and appended elements are validated without imposing whole-field minimums on fragments. Stored values and refinements cannot be fully checked before reading them; output-schema parsing can still fail after a successful write. Low-level `ref()` has an unknown value type; annotate `AttributeReference<number>` or `AttributeReference<string[]>` when using typed numeric/list helpers without a table schema. Primary keys and overlapping paths remain protected. The last action for an identical path wins, and explicit `modifiedAt` actions take precedence over automatic timestamps.

### Sparse update images

`returningUpdatedNew()` requests only changed-attribute fragments after an update; `returningUpdatedOld()` requests their previous values. Typed results use `PartialProjection<T> | null`, preserving scalar, binary and set leaves while making nested records partial and list fragments compact. Missing attributes are omitted, schema defaults are not inserted, and an absent image returns `null`. These modes follow update actions, not a deep diff: assigning an unchanged value can still return that attribute. Successful transaction writes do not return per-item images. Conditional-failure `returningAllOld()` remains independent and parses the full previous record.

List removals shift positions before `UPDATED_NEW` projects the affected paths. For example, setting `items[2]` and removing `items[0]` from a three-element list returns the final value at `items[0]`, not the assigned value now at `items[1]`. Removing a list element can therefore return the value shifted into its position; removing the last element produces no fragment for that path.

## Delete records

```ts
const deleted = await tasks.delete(key).toPromise();
```

Deletes return the previous record by default, or `null` when there was no previous record. Conditions can protect the delete:

```ts
await tasks.delete(key)
    .where('status').eq('done')
    .toPromise();
```

Use `.returningNone()` to avoid returning the old record:

```ts
await tasks.delete(key)
    .where('projectId').exists()
    .returningNone()
    .toPromise();
```

Deletes support `returningAllOld()`, which is the default, or `returningNone()`.

## Conditions

Conditions are available on `create`, `update`, `delete`, and `conditionCheck`. Multiple `.where()` calls are combined with `AND`.

```ts
await tasks.update(key)
    .set('status').eq('done')
    .where('status').eq('doing')
    .where('priority').gte(5)
    .toPromise();
```

Supported comparisons are:

```ts
.where('priority').eq(10)
.where('priority').ne(10)
.where('priority').gt(10)
.where('priority').gte(10)
.where('priority').lt(10)
.where('priority').lte(10)
.where('title').contains('guide')
.where('status').in(['todo', 'doing'])
.where('notes').exists()
.where('notes').not().exists()
.where('status').not().eq('done')
.where('title').beginsWith('Draft')
.where('priority').between(3, 10)
.where('tags').attributeType('SS')
.where('tags').size().gte(2)
```

`.in([])` is invalid; `IN` accepts at most 100 candidates. The same helpers work in read filters and write conditions. The typed API validates supplied comparison values against the selected field. For a set or array field, `.contains(value)` validates the member type rather than the collection type. String/binary prefixes validate partial operands rather than requiring a complete stored value.

`attributeType()` accepts the separate `ExpressionAttributeType` union: `S`, `N`, `B`, `BOOL`, `NULL`, `M`, `L`, `SS`, `NS`, `BS`. Table/key definitions still accept only `S`, `N`, and `B`. `size()` exposes numeric comparisons, `between()`, `in()`, and `not()`. Thresholds are finite numbers, including negative and fractional numbers. Size uses UTF-16 code units for strings, bytes for binary, and member counts for lists, maps, and sets; missing or unsupported stored operand types do not match positive size comparisons.

### Scoped groups

```ts
const matches = await tasks.scan()
    .whereAny(group => group
        .where('status').eq('doing')
        .whereAll(all => all
            .where('priority').gte(3)
            .where('title').beginsWith('Draft')))
    .whereNot(group => group.where('status').eq('done'))
    .toPromise();
```

The filter is equivalent to:

```text
(status = 'doing' OR (priority >= 3 AND begins_with(title, 'Draft')))
AND NOT (status = 'done')
```

`whereAny`, `whereAll`, and `whereNot` create explicit parenthesized OR, AND, and NOT groups. A NOT group negates the conjunction of its predicates. These callbacks expose predicates only, including nested groups, and also work on conditional writes and transaction conditions. Empty, incomplete, asynchronous, and throwing callbacks fail without committing any of their predicates. Keep callbacks synchronous and do not retain their scoped builders after they return. Repeated ordinary `.where()` calls remain AND.

Use a group to allow alternative states in a conditional write:

```ts
const completed = await tasks.update(key)
    .set('status').eq('done')
    .where('projectId').exists()
    .whereAny(group => group
        .where('status').eq('doing')
        .whereAll(all => all
            .where('status').eq('todo')
            .where('priority').gte(3)))
    .toPromiseOrNull();
```

This updates an existing task only if its stored status is `doing`, or its stored status is `todo` and priority is at least 3. Conditions inspect the item before the update, not the new `done` value. `completed` is the updated task on success or `null` when the condition fails; other service failures still reject.

See [AWS expression rules](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.OperatorsAndFunctions.html) for function and operator semantics.

Failed conditions reject with the AWS SDK error, normally `ConditionalCheckFailedException`. For an update where a failed condition is an expected not-found or no-op outcome, use `.toPromiseOrNull()` to return `null` for that error while continuing to propagate other DynamoDB failures:

```ts
const updated = await tasks.update(key)
    .set('status').eq('done')
    .where('projectId').exists()
    .toPromiseOrNull();
```

### Conditional failure payloads

For single-item writes through `QueryBuilder`, call `onConditionFailure().returningAllOld()` after the write actions and conditions, before `toPromise()`, to receive the existing item when a condition fails:

```ts
try {
    await new QueryBuilder('cache', dynamoDBClient)
        .update({key: 'counter'})
        .add('count').eq(1)
        .where('count').lt(10)
        .onConditionFailure().returningAllOld()
        .toPromise();
} catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
    }
    const previous = error.Item === undefined ? null : QuerySerializer.parseItem(error.Item);
}
```

Import `ConditionalCheckFailedException` from `@aws-sdk/client-dynamodb` and `QuerySerializer` from the query module. The methods support create, update, delete, and condition-check operations; reads and batches reject them. `onConditionFailure().returningNone()` explicitly disables the failure payload. The SDK exception is preserved, and its `Item` contains raw DynamoDB attributes, not a schema-validated document; no item is returned when the key is missing. Successful write results are unchanged. Use `toPromise()` rather than `toPromiseOrNull()` when the failure snapshot is needed. Transaction item options override the builder setting when supplied; transaction failures still use cancellation reasons rather than `ConditionalCheckFailedException.Item`.

`onConditionFailure()` exposes only `returningAllOld()` and `returningNone()`. Choosing either option returns the original write chain. Success and failure return options are independent, so `.returningNone().onConditionFailure().returningAllOld().toPromise()` suppresses the success payload while retaining the old item on conditional failure. This configures the error payload; it does not catch or suppress the failure.

### Independent and combined return options

These examples use the untyped `QueryBuilder` API. Each operation can succeed or reject depending on its condition; handle conditional failures as shown above.

**Success only:** suppress the successful update payload. Conditional failures still reject without an old-item payload because no failure-return option was selected.

```ts
await new QueryBuilder('cache', dynamoDBClient)
    .update({key: 'counter'})
    .add('count').eq(1)
    .where('count').lt(10)
    .returningNone()
    .toPromise();
```

**Failure only:** include the previous item on conditional failure. Successful updates still return the complete updated item through the default `returningAllNew()` behaviour.

```ts
const updated = await new QueryBuilder('cache', dynamoDBClient)
    .update({key: 'counter'})
    .add('count').eq(1)
    .where('count').lt(10)
    .onConditionFailure().returningAllOld()
    .toPromise<{key: string; count: number}>();
```

**Together:** suppress the success payload while including the previous item on conditional failure.

```ts
await new QueryBuilder('cache', dynamoDBClient)
    .update({key: 'counter'})
    .add('count').eq(1)
    .where('count').lt(10)
    .returningNone()
    .onConditionFailure().returningAllOld()
    .toPromise();
```

The reverse order, `.onConditionFailure().returningAllOld().returningNone()`, has the same effect: the first return option configures the failure payload and returns the write chain, so the second configures the success payload.

| Write-chain success option | Failure option | Successful update | Successful delete | Conditional failure |
| --- | --- | --- | --- | --- |
| Omitted | Omitted | Updated item | Deleted item | Rejects without `Item` |
| `returningNone()` | Omitted | `undefined` | `undefined` | Rejects without `Item` |
| Omitted | `onConditionFailure().returningAllOld()` | Updated item | Deleted item | Rejects with old `Item` when present |
| `returningNone()` | `onConditionFailure().returningAllOld()` | `undefined` | `undefined` | Rejects with old `Item` when present |
| Omitted | `onConditionFailure().returningNone()` | Updated item | Deleted item | Rejects without `Item` |
| `returningNone()` | `onConditionFailure().returningNone()` | `undefined` | `undefined` | Rejects without `Item` |

For successful updates, `returningAllNew()` explicitly selects the default full payload; for successful deletes, use `returningAllOld()`. `create()` also supports `returningAllOld()` to return the item it overwrote. These success methods remain independent of either failure option. A successful delete without an existing item returns `null` by default. Condition-check chains support only failure-return options. The failure configuration does not offer `returningAllNew()`: no updated item exists when a condition rejects the write.

`onConditionFailure()` alone is a configuration step, not an executable write chain. Select `returningAllOld()` or `returningNone()` to resume the chain. `toPromiseOrNull()` on an update still discards a conditional failure's payload and resolves to `null`, even when old-item return is enabled; use `toPromise()` and catch the SDK error when the snapshot is needed.

The shared contract tests cover updates and deletes with defaults, success-only options, failure-only options, combined options, and both configuration orders. They assert successful return values, conditional failure payloads, and persisted records. Run `npm run test:memory` offline or `npm run test:integration` against the configured real DynamoDB test backend.

### Conditional write results

Use `toResult<T, TPrevious = T>()` on untyped `QueryBuilder` create, update, or delete chains when a failed condition is an expected outcome that should not require `try/catch`. It returns the exported `ConditionalWriteResult` union:

```ts
type ConditionalWriteResult<T, TPrevious = T> =
    | {applied: true; value: T}
    | {applied: false; previous: TPrevious | null};
```

Configure the failure payload separately, using the same two-step API:

```ts
type Counter = {key: string; count: number; resetAt: number; ttl: number};

const result = await new QueryBuilder('cache', dynamoDBClient)
    .update({key: 'counter'})
    .add('count').eq(1)
    .where('resetAt').gt(Date.now())
    .where('count').lt(10)
    .onConditionFailure().returningAllOld()
    .toResult<Counter>();

if (result.applied) {
    const updated = result.value;
} else {
    const previous = result.previous;
}
```

| Terminal method | Successful write | Conditional failure |
| --- | --- | --- |
| `toPromise<T>()` | Resolves to the existing write value | Rejects with the SDK error |
| `toPromiseOrNull<T>()` (updates only) | Resolves to the existing write value | Resolves to `null`, discarding failure details |
| `toResult<T, TPrevious>()` | Resolves to `{applied: true, value}` | Resolves to `{applied: false, previous}` |

`toResult()` catches only `ConditionalCheckFailedException`. Network errors, access-denied errors, invalid requests, parsing failures, and other errors still reject. It does not make another DynamoDB request or enable old-item returns automatically. `previous: null` means no failure item was returned: the item may be missing, or failure payloads may be disabled. Request `onConditionFailure().returningAllOld()` when that distinction matters, as in the throttle.

The old item is deserialised with `QuerySerializer.parseItem()`. `TPrevious` defaults to `T` but may describe a different legacy shape. This generic is a caller-supplied type, not runtime schema validation; validate untrusted or legacy fields before using them. `ConditionalWriteResult` can be imported from the query module.

Success values match `toPromise()`: create returns the submitted document, update returns the updated item by default, and delete returns the deleted item or `null` when absent. Payload-free update/delete writes resolve to `{applied: true, value: undefined}`. For example:

```ts
const result = await new QueryBuilder('cache', dynamoDBClient)
    .update({key: 'counter'})
    .add('count').eq(1)
    .where('count').lt(10)
    .returningNone()
    .onConditionFailure().returningAllOld()
    .toResult<void, Counter>();
```

Repeated `toResult()` calls on the same chain return the cached result promise. Calling `toPromise()` or `toPromiseOrNull()` on that same chain shares the original execution without another write, while retaining each method's success/failure semantics. A new builder is needed to retry a conditional write. Reads, batches, standalone condition checks, and transaction builders do not expose `toResult()`; transaction cancellation reasons are not converted into single-item conditional results. Typed table writes support the inferred, schema-validated variant below.

The shared backend contracts cover create/update/delete results, missing and suppressed failure payloads, and payload-free successes. Unit tests cover deserialisation, result type narrowing, execution caching, terminal-method compatibility, and infrastructure-error propagation. Run `npm test` offline; the shared contracts also run under `npm run test:integration`.

### Typed conditional write results

Typed table create, update, and delete chains support the same two-step failure-return options and `toResult()`, without caller-supplied generics. The table schema determines both the successful record type and the previous-record type:

```ts
const counters = defineTable({
    name: 'cache',
    schema: z.object({
        key: z.string(),
        count: z.number().int().nonnegative(),
        resetAt: z.number().int(),
        ttl: z.number().int()
    }).strict(),
    key: {partition: 'key'}
}).using(dynamoDBClient);

const result = await counters.update({key: 'counter'})
    .add('count').eq(1)
    .where('resetAt').gt(Date.now())
    .where('count').lt(10)
    .onConditionFailure().returningAllOld()
    .toResult();

if (result.applied) {
    const updated = result.value;
} else {
    const previous = result.previous;
}
```

Successful values retain the existing typed API contracts: create returns the schema record, while update and delete return the schema record or `null`. Failure results contain a schema-validated record or `null` when no old item was returned. Malformed old records reject with `ZodError` rather than being exposed under an incorrect inferred type. Unlike the untyped `toResult<T, TPrevious>()`, the typed method does not allow a generic assertion to bypass validation for a legacy record; use a schema that explicitly supports the stored data or use the untyped API with appropriate validation.

Success and failure return options remain independent and can be ordered either way. After `returningNone()`, the successful result's `value` is inferred as `void`, but `previous` remains the schema record or `null`:

```ts
const result = await counters.update({key: 'counter'})
    .add('count').eq(1)
    .where('count').lt(10)
    .returningNone()
    .onConditionFailure().returningAllOld()
    .toResult();
```

Calling `returningAllNew()` on updates or `returningAllOld()` on deletes restores the full success type. Failure configuration returns the original typed chain, so subsequent conditions and update actions retain field/value validation. `TypedCreateChain` and `TypedWriteFinal` are exported for consumers that need to name these interfaces.

Typed result promises are cached across fluent wrappers for the same underlying write. Previous-item validation runs once for that result, including schemas with transforms. `toPromise()` and `toPromiseOrNull()` share the write execution but keep their original behaviour: conditional errors from `toPromise()` remain raw SDK errors, and `toPromiseOrNull()` discards conditional failure details. Infrastructure errors and schema-validation failures are not converted into conditional results.

Typed condition checks and transaction callbacks may configure `onConditionFailure().returningAllOld()` or `.returningNone()`. Per-item transaction options still override that configuration. Execute transactions through their transaction builder's `toPromise()`; calling `toResult()` inside a typed transaction callback throws before sending a request. Standalone condition checks do not expose `toResult()` because they execute through DynamoDB transactions, which return cancellation reasons rather than single-item condition errors.

Offline `npm test` covers inferred types, void/full success options, schema validation, shared execution, and transaction configuration. The common backend contract also tests real typed conditional writes and is included in `npm run test:integration`.

### Standalone condition checks

`conditionCheck()` is primarily useful inside transactions:

```ts
typedTransaction(dynamoDB)
    .add(tasksTable, (tasks) => tasks
        .conditionCheck(key)
        .where('status').eq('doing'))
    // Add writes that depend on the checked state.
    .toPromise();
```

A condition check must contain at least one condition.

## Queries and indexes

Use `query()` when the partition key is known. It is more efficient than a scan.

```ts
const projectTasks = await tasks
    .query({projectId: 'project-1'})
    .toPromise();
```

For a composite key, constrain the declared sort key through `.sortKey()`:

```ts
await tasks.query({projectId: 'project-1'}).sortKey().eq('task-1').toPromise();
await tasks.query({projectId: 'project-1'}).sortKey().gt('task-1').toPromise();
await tasks.query({projectId: 'project-1'}).sortKey().gte('task-1').toPromise();
await tasks.query({projectId: 'project-1'}).sortKey().lt('task-9').toPromise();
await tasks.query({projectId: 'project-1'}).sortKey().lte('task-9').toPromise();
await tasks.query({projectId: 'project-1'}).sortKey().between('task-1', 'task-9').toPromise();
await tasks.query({projectId: 'project-1'}).sortKey().beginsWith('task-').toPromise();
```

`beginsWith()` is available only for string and binary sort keys. The sort-key condition is part of DynamoDB's key condition and is applied before reading items.

### Query an index

Select an index before calling `query()`:

```ts
const todoTasks = await tasks
    .index('status-index')
    .query({status: 'todo'})
    .sortKey().gte(5)
    .toPromise();
```

Typed index definitions require a `kind` so the query can enforce DynamoDB's consistency rules:

```ts
const tasks = defineTable({
    name: 'tasks',
    schema: taskSchema,
    key: {partition: 'projectId', sort: 'taskId'},
    indexes: {
        'status-index': {
            kind: 'global',
            partition: 'status',
            sort: 'priority',
            projection: {type: 'INCLUDE', nonKeyAttributes: ['summary']}
        }
    }
});
```

The selected index determines the required partition key and the type of `.sortKey()` comparisons. A consistent read requested from a declared global secondary index throws before sending the request. Local secondary indexes can use consistent reads when declared with `kind: 'local'`.

Untyped `QueryBuilder.usingIndex()` treats an omitted kind as `global`. Pass `.usingIndex('index-name', 'local')` only for a known local secondary index when requesting a consistent read.

### Multi-attribute GSIs

Global indexes accept scalar key names or ordered tuples of one to four partition components and zero to four sort components. Table keys and local secondary indexes remain scalar. All partition components require equality, and sort conditions must form an ordered contiguous prefix with at most one final range condition.

```ts
const events = defineTable({
    name: 'events', key: {partition: 'id'},
    schema: z.object({id: z.string(), tenant: z.string(), region: z.string(), year: z.number(), sequence: z.number()}),
    indexes: {byTenant: {kind: 'global', partition: ['tenant', 'region'], sort: ['year', 'sequence']}}
}).using(dynamoDB);

await events.index('byTenant').query({tenant: 'one', region: 'west'})
    .sortKey('year').eq(2026).sortKey('sequence').gte(100).toPromise();
```

Scalar indexes keep the existing `.sortKey()` spelling without an argument. Tuple indexes use `.sortKey(component)` and infer the next allowed component. Projection-aware result inference includes every index key. GSIs reject strongly consistent reads and omit records missing any key component. Portable creation/discovery preserves ordered HASH/RANGE entries without concatenating stored values. Schema-aware low-level queries use `new QueryBuilder(name, db).query(partitionDocument, {name: indexName, kind: 'global', partition: [...], sort: [...]})`; they cannot switch to a different index afterward. The legacy schema-free query path remains unchanged.

### Query filters

Additional `.where()` clauses on a query are DynamoDB filter expressions:

```ts
const importantOpenTasks = await tasks
    .query({projectId: 'project-1'})
    .where('status').ne('done')
    .where('priority').gte(10)
    .toPromise();
```

Filters are applied after DynamoDB evaluates items. They reduce returned items, not read capacity. Do not use a filter where a table or index key can model the access pattern.

## Scans and filters

A scan reads across the table and can use the same filter comparisons as a query:

```ts
const matching = await tasks
    .scan()
    .where('status').eq('doing')
    .where('title').contains('guide')
    .toPromise();
```

Call `.consistent()` for a strongly consistent scan:

```ts
const matching = await tasks.scan().consistent().where('status').eq('doing').toPromise();
```

Scans may consume substantial read capacity. Prefer a query for request paths and known access patterns.

### Index scans

```ts
await tasks.index('status-index').scan()
    .where('status').eq('doing')
    .limit(25)
    .toPromise();
```

A low-level scan can read one parallel segment:

```ts
const firstSegment = await new QueryBuilder('tasks', dynamoDB).scan()
    .usingIndex('status-index', 'global')
    .parallel(0, 4)
    .toPromise();
```

`firstSegment` contains only segment `0` of four, not the whole index. To read every segment, create an independent operation for each:

```ts
const segments = [0, 1, 2, 3];
const segmentResults = await Promise.all(segments.map(segment =>
    new QueryBuilder('tasks', dynamoDB).scan()
        .usingIndex('status-index', 'global')
        .parallel(segment, segments.length)
        .toPromise()
));
const indexedTasks = segmentResults.flat();
```

Each `toPromise()` follows all pages for its segment. This runs four segment reads concurrently; merging their results does not impose an order or provide a point-in-time snapshot of a changing index.

Index scans support projections, counts, pagination, lazy pages/items, hard limits, consumed-capacity metadata, and parallel segments. They have no ascending/descending controls. GSI consistent reads are rejected before sending in either modifier order. LSI scans support consistency and may explicitly select permitted non-projected table fields. GSI reads can return only projected fields; typed index filters and references also require projected fields. Low-level GSI scan filters see non-projected fields as absent. Query-key filter restrictions do not apply to scans.

Scan results are unordered. Pass continuation cursors unchanged, including table/index keys, and use each parallel-scan cursor only with its original segment. See the [AWS Scan API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Scan.html).

## Projections and counts

### Select fields

`select()` requests only named attributes and narrows the inferred result type:

```ts
const summaries = await tasks
    .query({projectId: 'project-1'})
    .select('taskId', 'title', 'status')
    .toPromise();

// Inferred as Array<Pick<Task, 'taskId' | 'title' | 'status'>>.
```

Projected records are validated with a projection schema. At least one field is required, and duplicate fields are removed.

### Document paths and references

These examples use the `dynamoDB` client from the quick start and assume a `records` table already exists with `id` as its string partition key.

```ts
const records = defineTable({
    name: 'records',
    key: {partition: 'id'},
    schema: z.object({
        id: z.string(), used: z.number(), quota: z.number(),
        profile: z.object({
            address: z.object({city: z.string(), country: z.string().default('GB')}),
            nickname: z.string().optional()
        }),
        labels: z.array(z.string())
    })
}).using(dynamoDB);

const recordKey = {id: 'record-1'};
await records.create({
    ...recordKey,
    used: 2,
    quota: 5,
    profile: {address: {city: 'London', country: 'GB'}},
    labels: ['review', 'urgent', 'draft']
}).toPromise();

const city = records.path('profile', 'address', 'city');
const secondLabel = records.path('labels', 1);
const nickname = records.path('profile', 'nickname');
const summary = await records.get(recordKey).consistent()
    .select('id', city, secondLabel, nickname).toPromise();
```

`summary` is:

```json
{
    "id": "record-1",
    "profile": {"address": {"city": "London"}},
    "labels": ["urgent"]
}
```

The original `labels[1]` becomes the only element of the returned list, at position `0`. The absent `nickname` is omitted. The unselected `country` is also omitted, even though its schema has a default; projection parsing does not fill it in.

Reuse the same paths in batch reads, filters, and conditional updates:

```ts
const summaries = await records.getBatch([recordKey], {
    consistentRead: true,
    select: ['id', city, secondLabel, nickname]
});

const withinQuota = await records.scan()
    .where(city).eq('London')
    .where('used').lte(records.ref('quota'))
    .toPromise();

const updated = await records.update(recordKey)
    .set(city).eq('Manchester')
    .remove(secondLabel)
    .where('used').lt(records.ref('quota'))
    .toPromiseOrNull();
```

For the seeded record, `summaries` is `[summary]`, and the filter includes the record because its stored `used` value is 2 and `quota` is 5. The conditional update returns:

```json
{
    "id": "record-1",
    "used": 2,
    "quota": 5,
    "profile": {"address": {"city": "Manchester", "country": "GB"}},
    "labels": ["review", "draft"]
}
```

The update preserves unmodified fields and removes the element at the original list position `1`. If the stored `used` value is no longer below `quota`, it returns `null` without applying either change.

Both table definitions and bound tables expose schema-aware `path()` and `ref()` helpers. The low-level equivalents are named exports: `import {path, ref} from '@fluentful/orm'`. Descriptors and their segments are immutable. String segments identify map fields, numeric segments identify non-negative integer list positions, and paths allow at most 32 dereferences. Ordinary strings remain literal attribute names: `'profile.address.city'` is one field, not a nested path.

For example, these low-level filters address different attributes:

```ts
import {path, QueryBuilder} from '@fluentful/orm';

const literalMatches = await new QueryBuilder('records', dynamoDB).scan()
    .where('profile.address.city').eq('Manchester').toPromise();
const nestedMatches = await new QueryBuilder('records', dynamoDB).scan()
    .where(path('profile', 'address', 'city')).eq('Manchester').toPromise();
```

For the seeded record after the update, only the nested filter matches: the record has no literal top-level attribute named `profile.address.city`.

Paths work in filters, conditions, projections (including `getBatch(..., {select: [...]})`), SET, and REMOVE. ADD and DELETE remain top-level only. Invalid segments, primary-key mutations, and overlapping parent/child updates or projections fail before sending. Nested SET requires existing parent containers and does not create missing maps. Multiple list updates/removals address original list positions. See [AWS update expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.UpdateExpressions.html).

Projected maps retain their nested shape. Selected list elements form compacted lists, in original list order, without holes or objects keyed by original indices. Missing selections are omitted, including parent containers with no selected descendants. Nested projection types use partial fields and arrays; parsing validates only returned branches and does not materialize absent fields from defaults. Whole top-level string selections retain the existing `Pick` result types.

References are explicit stored-field operands for EQ/NE, ordered comparisons, BETWEEN bounds, and IN candidates. They are resolved against the consuming table/index schema, never serialized as supplied values. In comparisons, the left path must differ from any referenced right operand. Ordinary strings and objects remain literal values. `ref('pricing', 'regular')` addresses a nested field, while `ref('pricing.regular')` addresses one literal name. Predicate-function arguments do not accept references; structured SET assignments use the separate `assign()` API described above.

### Count matches

```ts
const openCount = await tasks
    .query({projectId: 'project-1'})
    .where('status').ne('done')
    .count()
    .toPromise();
```

Counts continue across all DynamoDB pages and include only records that pass filters. `select()` and `count()` cannot be combined on one operation.

## Pagination and streaming

There are four read execution styles. Create a fresh fluent operation for each style.

### Read every matching item

```ts
const all = await tasks.query({projectId: 'project-1'}).toPromise();
```

### Read one resumable page

```ts
const firstPage = await tasks
    .query({projectId: 'project-1'})
    .page({limit: 25});

const secondPage = firstPage.cursor === null
    ? null
    : await tasks
        .query({projectId: 'project-1'})
        .page({limit: 25, cursor: firstPage.cursor});
```

A page has this shape:

```ts
interface QueryPage<T> {
    items: T[];
    cursor: Record<string, string | number | Uint8Array> | null;
    count?: number;
    scannedCount?: number;
    consumedCapacity?: ConsumedCapacity;
}
```

The cursor is DynamoDB's deserialized `LastEvaluatedKey`. Treat it as opaque and return it unchanged. For a composite table or index it must contain the complete primary key required by DynamoDB. `null` means there are no more pages.

The page limit is DynamoDB's evaluated-item limit. A filtered page can contain fewer items than the requested limit, including zero items, while still returning a non-null cursor.

Metadata is page-local, not cumulative: `count` is the service count after filtering, `scannedCount` is evaluated work, and capacity is returned when requested with `returnCapacity()`. Absent metadata stays absent rather than being changed to zero. Capacity values are cloned.

### Iterate pages lazily

```ts
for await (const page of tasks
    .query({projectId: 'project-1'})
    .pages({limit: 25})) {
    await processPage(page.items);
}
```

Pass `cursor` alongside `limit` to resume the iterator.

### Iterate items lazily

```ts
for await (const task of tasks
    .query({projectId: 'project-1'})
    .items({limit: 25})) {
    await processTask(task);
}
```

Async iterators request pages only as iteration advances.

### Chunk size and hard limit

`limit(chunkSize, hardLimit)` configures all-page `toPromise()` reads:

```ts
const firstHundred = await tasks
    .scan()
    .limit(25, 100)
    .where('status').eq('todo')
    .toPromise();
```

- `chunkSize` is the DynamoDB `Limit` for each request.
- `hardLimit` is the maximum number of returned items across requests.
- use `null` for no hard result limit: `.limit(25, null)`.
- filtering can require several DynamoDB requests to reach the hard result limit.

Both limits must be positive when supplied. For externally controlled pagination, prefer `page()`.

## Batch operations

DynamoDB limits batch writes to 25 items and batch gets to 100 keys. QueryBuilder chunks larger arrays, retries unprocessed items with jitter, and runs up to four chunks concurrently by default.

```ts
const created = await tasks.createBatch(newTasks);
const loaded = await tasks.getBatch(taskKeys);
await tasks.deleteBatch(taskKeys);
```

Set bounded concurrency explicitly when needed:

```ts
await tasks.createBatch(newTasks, {concurrency: 2});
await tasks.getBatch(taskKeys, {concurrency: 2, consistentRead: true});
await tasks.deleteBatch(taskKeys, {concurrency: 2});
```

`getBatch()` accepts `consistentRead` in its options object and removes duplicate keys before sending requests. DynamoDB does not guarantee that batch-get results have the same order as the input keys.

Empty input arrays complete without sending a DynamoDB request: creates and gets return `[]`, while deletes return `void`. Unprocessed reads and writes are retried up to eight times with jittered backoff; the operation rejects if DynamoDB still returns unprocessed items after the final retry. When one concurrent chunk fails, no new chunks are scheduled, but already-running chunks are allowed to settle before the batch rejects.

Retry exhaustion throws exported `BatchRetryError`. Its `operation`, raw SDK `unprocessedItems` map, and decoded `partialResults` describe the failing chunk only, not other concurrent chunks. For reads, the map contains `KeysAndAttributes`; for writes it contains write requests. Retry only unprocessed work, not the entire original write batch. Ordinary SDK failures preserve their original error identity and may leave an ambiguous partial outcome. Create batches validate all documents before scheduling chunks; service failures still make batches non-atomic. Binary-key deduplication compares bytes regardless of `Buffer`/`Uint8Array` representation. Duplicate write targets within one request are rejected by both AWS and memory.

For legacy callers, a boolean second argument remains supported: `true` means serial chunks and `false` means unbounded concurrency. New code should use `{concurrency}`.

Batch operations are not atomic and do not support per-item conditions. Use a transaction when all writes must succeed or fail together.

### Recoverable batch outcomes

`getBatchResult()`, `createBatchResult()`, and `deleteBatchResult()` are additive alternatives to the legacy batch methods. They settle active chunks and return a `BatchOutcome` with `completed`, `unprocessed`, `notSubmitted`, and `unknown` work. Each entry retains its original input index and an isolated input value. Missing read records count as completed work; duplicate read inputs retain their individual positions even though requests are deduplicated.

```ts
const outcome = await tasks.createBatchResult(newTasks, {concurrency: 2, signal});
console.log(outcome.errors, outcome.unknown);
// Only these inputs were explicitly unprocessed or never submitted:
const safeToResume = outcome.resumable;
```

`results` retains parsed read results (without promising input ordering) or confirmed prepared create documents. `errors` retains original failure objects, including cancellation reasons. Input validation still rejects before sending; service, parsing and cancellation outcomes are reported after execution starts. `resumable` never includes uncertain writes. It contains API inputs, so resubmission reapplies current validation, transforms and timestamp settings. Do not blindly retry `unknown` work: reconcile it using application keys/idempotency first. Batches remain non-atomic.

### Cancellation

Pass `{signal}` to terminals (`toPromise`, `toResponse`, `toResult`, `toPromiseOrNull`), pages/iterators, batches, transactions, and administrative options. The first execution binds the original signal outside cloned request data; later cached calls may omit it or reuse it, but cannot replace it. Aborts stop scheduling, page/item traversal, and retry delays, and are forwarded to AWS sends. In-flight batch workers settle before an aggregate result is returned. Memory rejects cancelled queued work before execution.

Cancellation is not rollback: a write may have reached DynamoDB before cancellation or a network failure. Waiter cancellation also does not undo table creation or deletion. Pre-aborted signals avoid sending: ordinary terminals reject, while recoverable batches report the reason and never-submitted inputs. Cached failures retain their original identity.

## Transactions

`typedTransaction()` composes up to 100 create, update, delete, or condition-check operations across typed tables.

```ts
import {typedTransaction} from '@fluentful/orm';

await typedTransaction(dynamoDB)
    .clientRequestToken('complete-task:project-1:task-1')
    .add(tasksTable, (tasks) => tasks
        .update(key)
        .set('status').eq('done')
        .where('status').eq('doing'), {
        returnValuesOnConditionCheckFailure: 'ALL_OLD'
    })
    .add(auditTable, (events) => events
        .create({
            eventId: 'event-1',
            type: 'task-completed',
            taskId: 'task-1'
        }))
    .toPromise();
```

Each `.add()` callback must configure exactly one write or condition check. The optional item setting `returnValuesOnConditionCheckFailure: 'ALL_OLD'` asks DynamoDB to include the previous item in transaction cancellation details. The alternative is `'NONE'`.

`clientRequestToken()` supplies DynamoDB's idempotency token. `logger()` accepts the same logging callback described below.

Like individual operations, a transaction caches its execution promise. Repeated `.toPromise()` calls on the same transaction do not submit it again, including when the first request rejects.

Transaction rules inherited from DynamoDB include:

- 1 to 100 operations are required.
- The same item cannot be targeted by more than one operation in a transaction. A condition check and update of the same item therefore need to be expressed as one conditional update instead.
- Transactions cannot contain reads, queries, scans, or batch operations.
- A failed condition rolls back every write.
- Operations cannot be added after `.toPromise()` starts execution.

### Atomic read transactions

`typedReadTransaction(db).add(tableDefinition, key, optionalProjection)` infers a heterogeneous ordered tuple; `transactGet(db).add(tableName, key, optionalProjection)` is the low-level equivalent. Both expose `toPromise({signal})`, `toResponse({signal})`, `returnCapacity('TOTAL' | 'NONE')`, and `logger()`. Results are cached after the first execution. Missing items retain a `null` position; a projection selecting no existing attributes also returns `null`, so these cases cannot be distinguished from that response alone. Multiple reads of the same table/key in one transaction are rejected, even with different projections or when the item is missing.

```ts
import {typedReadTransaction} from '@fluentful/orm';
const [task, project] = await typedReadTransaction(dynamoDB)
    .add(taskTable, taskKey, ['title'])
    .add(projectTable, projectKey)
    .toPromise();
```

This is one atomic `TransactGetItems` request, never chunked: 1-100 entries, base tables only, same account/region, and a service aggregate limit of 4 MB. Memory takes a deterministic serial snapshot but does not simulate distributed contention or byte limits. DynamoDB service failures are propagated unchanged.

## Timestamps and logging

### Automatic timestamps

Set `timestamps: true` on a typed table:

```ts
const table = defineTable({
    name: 'tasks',
    schema: taskSchema,
    key: {partition: 'projectId', sort: 'taskId'},
    timestamps: true
});
```

Creates receive `createdAt = Date.now()`. Updates receive `modifiedAt = Date.now()`. An explicitly supplied `modifiedAt` value wins over the automatic value.

Timestamps are ordinary numeric attributes. They are not added to reads and do not implement optimistic locking.

### Logging

The lower-level builder and transactions can log request summaries and consumed capacity:

```ts
const log = (message: unknown) => console.debug(message);

await new QueryBuilder('tasks', dynamoDB)
    .logger(log)
    .get(key)
    .toPromise();

await typedTransaction(dynamoDB)
    .logger(log)
    .add(tasksTable, (tasks) => tasks.update(key).set('status').eq('done'))
    .toPromise();
```

Avoid logging records or request values when they may contain secrets or personal data.

### Response metadata

`toPromise()` continues to return only the operation value. Call `toResponse()` after `returnCapacity()` when the caller also needs DynamoDB response metadata:

```ts
const response = await tasks
    .query({projectId: 'project-1'})
    .descending()
    .returnCapacity('TOTAL')
    .toResponse();

response.value;            // Task[]
response.consumedCapacity; // one entry per DynamoDB request or page
```

`returnCapacity()` accepts `'NONE'`, `'TOTAL'`, or `'INDEXES'`; omission keeps the existing `'INDEXES'` request mode. Writes can additionally call `returnItemCollectionMetrics()` to receive approximate local-secondary-index collection sizes in `response.itemCollectionMetrics`. `create()` and `update()` also support `returningAllOld()` for a successful overwrite's previous item. Point reads support `.select(...)`; `query()` supports `.ascending()` and `.descending()`; and `scan().parallel(segment, totalSegments)` configures one parallel-scan segment.

## Comparison and access rules

- `.eq(['val'])` matches the entire list, not membership. Lists compare positionally, including length and duplicates; maps ignore property insertion order; DynamoDB sets ignore member order. Equality is type-sensitive (for example, a number is not its string representation, and a set is not a list). Missing attributes are distinct from stored `null`.
- `.contains(value)` tests a substring or one list/set member. `.in(values)` compares the complete attribute against 1-100 candidates, including serializable complex values. Negation follows DynamoDB expression semantics; `.ne(value)` matches a missing attribute, including when the operand is `null`. `.eq(null)` only matches a stored null, not an absent attribute. For conditional writes that require a present value that differs, also add `.where(field).exists()`.
- Attribute strings, including names containing dots, spaces or hyphens, are literal top-level names. Safe aliases are allocated for conditions, updates, query keys and projections (including batch reads); these strings do not select nested paths.
- Queries require partition-key equality and at most one sort-key predicate. Key operands must be non-empty strings/binaries or finite DynamoDB-range numbers; key byte limits are enforced. Sort-key `BETWEEN` requires matching types and ordered bounds, and `beginsWith` requires string/binary operands. Typed query filters reject the active table/index keys; use key conditions instead. Base-table keys may be filtered when they are not keys of the selected index.
- Present secondary-index keys must match their declared scalar types and cannot be null or empty; missing components keep an item out of a sparse index. Typed writes validate present key operands using their definitions before sending; memory validates the resulting items for puts, updates, batches and transactions before mutation. Index cursors contain both table and index keys. Ordering between items with equal index sort keys is unspecified.
- Parallel scan `totalSegments` is an integer from 1 to 1,000,000, with `0 <= segment < totalSegments`. `usingIndex()` supports queries and scans and rejects unsupported operations instead of silently ignoring the selection. The typed equivalent is `index(name).query(...)` or `index(name).scan()`.
- Scan result order is not guaranteed by DynamoDB; the memory backend's deterministic key order is not a portable ordering contract.

The shared contract covers complex `IN`, missing-versus-null comparisons, nested paths and projections, scoped AND/OR/NOT groups, condition/filter functions, stored-field references, conditional writes and transactions, and secondary-index scans. Run `npm run test:integration` with AWS credentials to verify these cases against live DynamoDB; passing the offline suite alone does not establish AWS parity.

## Values and serialization

The serializer maps JavaScript values to DynamoDB `AttributeValue` shapes:

| JavaScript value | DynamoDB value | Deserialized value |
| --- | --- | --- |
| string, finite number, boolean, or `null` | `S`, `N`, `BOOL`, or `NULL` | the same scalar value |
| `Buffer` or `Uint8Array` | `B` | a binary value, usually a `Uint8Array` from AWS |
| array | `L` | an array, preserving order and duplicates |
| plain object | `M` | a plain object |
| non-empty `Set<string>` | `SS` | `Set<string>` |
| non-empty `Set<number>` | `NS` | `Set<number>` |
| non-empty `Set<Buffer>` or `Set<Uint8Array>` | `BS` | a set of binary values |

Maps in this table mean DynamoDB maps represented by plain JavaScript objects, for example `{owner: {id: 'account-1'}}`. They are not ECMAScript `Map` instances; convert a `Map` with `Object.fromEntries()` before writing it. Arrays are DynamoDB lists, so they may be empty and may contain different serializable value types. A Set is unordered and cannot be empty. Mixed-type, boolean, or object Sets are serialized as lists and deserialize as arrays, so use a homogeneous DynamoDB-compatible Set when set behaviour matters.

For typed tables, express complex fields in the Zod schema, for example `z.array(z.string())`, `z.set(z.string())`, `z.object({owner: z.string()})`, and `z.instanceof(Uint8Array)`. Complete arrays and sets are validated on writes and reads. A typed `.contains(value)` comparison validates `value` against the element schema for both array and Set fields, rather than expecting the whole collection. Collection size constraints do not restrict membership operands. Optional, nullable, default, readonly, catch, prefault, nonoptional and pipe wrappers are unwrapped for partial operands; union branches validate their respective operand schemas. Element validation/transforms remain active, but whole-field transforms and container refinements are not applied to partial operands. String substrings and sort-key prefixes validate their scalar type without requiring a complete value that satisfies the stored field's length/pattern constraints. Equality still validates the complete field schema:

```ts
const taskSchema = z.object({
    id: z.string(),
    labels: z.array(z.string()),
    tags: z.set(z.string()),
    metadata: z.object({owner: z.string()}),
    payload: z.instanceof(Uint8Array)
});

const tasks = defineTable({
    name: 'tasks',
    schema: taskSchema,
    key: {partition: 'id'}
}).using(dynamoDB);

await tasks.scan()
    .where('labels').contains('urgent')
    .where('tags').contains('review')
    .toPromise();
```

Numbers must be finite and within DynamoDB's magnitude range: zero, or absolute value at least `1e-130` and below `1e126`. Decoding rejects numeric strings that do not round-trip through JavaScript's decimal number representation, rather than silently changing precise values or collapsing number-set members. This is not arbitrary-precision arithmetic: memory numeric updates still use JavaScript arithmetic. Store application values requiring more precision as strings, or use the raw AWS SDK with an appropriate number representation.

`undefined` object properties are omitted from creates and `.with()` updates, but an `undefined` array member is invalid. Non-finite/out-of-range numbers, symbols, functions, empty Sets, cycles, nesting beyond 32 levels, and unsupported object instances such as `Date` or `Map` are rejected. Convert these explicitly before writing. Only own enumerable document attributes are encoded, including literal `__proto__`, `constructor`, and `hasOwnProperty` names. Binary sets deduplicate equal bytes. Malformed known AttributeValue descriptors are rejected; unknown descriptor tags retain the existing `undefined` result.

Avoid relying on `undefined` to remove an existing attribute during an update. Use `.remove(field)`.

## Lower-level QueryBuilder

Use the untyped API when a typed table definition is not practical. It has the same fluent operation model but does not infer fields or validate records with Zod.

```ts
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {QueryBuilder} from '@fluentful/orm';

interface Task {
    projectId: string;
    taskId: string;
    status: string;
    priority: number;
}

const query = () => new QueryBuilder('tasks', dynamoDB);

const created = await query().create({
    projectId: 'project-1',
    taskId: 'task-1',
    status: 'todo',
    priority: 10
}).where('projectId').not().exists().toPromise<Task>();

const task = await query().get({
    projectId: 'project-1',
    taskId: 'task-1'
}).toPromise<Task | null>();

const tasks = await query()
    .query({projectId: 'project-1'})
    .sortKey('taskId').beginsWith('task-')
    .where('status').ne('done')
    .select('projectId', 'taskId', 'status')
    .toPromise<Array<Pick<Task, 'projectId' | 'taskId' | 'status'>>>();
```

The principal syntax differences are:

- instantiate `new QueryBuilder(tableName, client)` for each operation
- pass the sort-key attribute to `.sortKey('taskId')`
- select an index with `.query(indexPartitionKey).usingIndex('index-name')`
- supply result types to generic methods such as `.toPromise<Task>()`
- enable timestamps per builder with `.timestamps()`

### Lower-level transactions

```ts
await QueryBuilder.transactWrite(dynamoDB)
    .clientRequestToken('operation-123')
    .add('tasks', (tasks) => tasks
        .update(key)
        .set('status').eq('done')
        .where('status').eq('doing'))
    .add('audit-events', (events) => events
        .create({eventId: 'event-1', type: 'task-completed'}))
    .toPromise();
```

## Table administration

The static helpers are intended for tests and simple local table administration. The two table-read helpers have intentionally different contracts:

| Helper | Returns | Use it for |
| --- | --- | --- |
| `describeTable` | The raw AWS `TableDescription`, including operational metadata such as `TableStatus`, `TableArn`, item counts, and throughput details | Inspecting the live DynamoDB resource |
| `getTableDefinition` | A validated `DynamoDBTableDefinition` containing only the table name, key attributes, attribute types, indexes, and projections | Reusing or recreating the table's key/index shape |

`getTableDefinition` is derived from `describeTable`; it deliberately omits AWS resource metadata and cannot be used to clone billing, throughput, streams, TTL, encryption, or tags.

```ts
await QueryBuilder.createTable('temporary-tasks', 'id', dynamoDB);
const tableDescription = await QueryBuilder.describeTable('temporary-tasks', dynamoDB);
const definition = await QueryBuilder.getTableDefinition('temporary-tasks', dynamoDB);
const tableNames = await QueryBuilder.listTables(dynamoDB);
await QueryBuilder.deleteTable('temporary-tasks', dynamoDB);
```

`defineTable`, `createTable`, `deleteTable`, `describeTable`, `getTableDefinition`, `listTables`, and `transactWrite` are also named exports from `@fluentful/orm`; each has the same behaviour as its corresponding `QueryBuilder` static helper.

`listTables()` follows every `LastEvaluatedTableName` continuation. It returns all table names, not just the first service page.

The existing `createTable(name, key, client)` shorthand creates an on-demand table with one string partition key. For composite keys, other key types and indexes, use the QueryBuilder-owned definition overload:

```ts
import {QueryBuilder} from '@fluentful/orm';
import type {DynamoDBTableDefinition} from '@fluentful/orm';

const definition: DynamoDBTableDefinition = {
    name: 'tasks',
    key: {partition: 'projectId', sort: 'taskId'},
    attributes: {
        projectId: 'S',
        taskId: 'S',
        status: 'S',
        priority: 'N'
    },
    indexes: {
        'status-index': {kind: 'global', partition: 'status', sort: 'priority'}
    }
};

await QueryBuilder.createTable(definition, dynamoDB);
const discovered = await QueryBuilder.getTableDefinition('tasks', dynamoDB);
```

`attributes` is required and maps every table/index key attribute to `DynamoDBAttributeType`: `S` (string), `N` (number), or `B` (binary). It describes key types only, not every document field. Missing/invalid types, unused attributes and invalid key/index definitions fail before a request is sent. Use `indexes: {}` for a table without indexes. Local indexes require a composite table key, the same partition key as the table, and their own sort key.

Creation defaults to on-demand billing and `ALL` projection for every index. Set `projection: {type: 'KEYS_ONLY'}` for index and table keys only, or `projection: {type: 'INCLUDE', nonKeyAttributes: [...]}` to add selected document fields. Table and index keys are projected automatically and must not be repeated in `nonKeyAttributes`. The same definition works with real DynamoDB and the in-memory backend. Real table creation returns before the table necessarily becomes active; callers must wait for readiness before writing.

`getTableDefinition()` returns `{name, key, attributes, indexes}`, validates key and projection metadata, and preserves non-`ALL` projections and multi-component GSI keys. Canonical `ALL` projections remain omitted for compatibility. You can reuse that definition to create the supported key/index structure under a different name. Operational billing/throughput/TTL options remain separate; this is not a complete infrastructure-cloning API.

Global secondary index queries can return and filter only projected attributes. Local secondary index queries return projected attributes by default but may explicitly select attributes from the base table. Typed index queries infer these result shapes and validate returned partial records against projection-specific schemas.

The normalised definition does not include a Zod schema because DynamoDB does not store application-level validation rules. Runtime strings returned by DynamoDB also cannot provide the literal-key inference of a statically declared `defineTable()` definition; use this helper for inspection, generation, or runtime schema verification. Previously hand-written `DynamoDBTableDefinition` values must now supply `attributes`.

### Operational administration

All existing administration helpers accept an optional final options object with `signal`. `listTablePage(db, {limit, cursor, signal})` returns `{names, cursor}`, with a limit from 1 to 100. `listTables()` still follows all pages. `waitForTable(name, db, options)` and `waitForTableDeleted(...)` are abortable; `maxWaitTime`, `minDelay`, and `maxDelay` are seconds. Table readiness alone does not establish GSI backfill/convergence; inspect index status and poll expected results.

`createTable(definition, db, options)` defaults to on-demand billing. To provision capacity, pass `{billingMode: 'PROVISIONED', throughput: {read: 5, write: 5}, indexThroughput: {indexName: {read: 5, write: 5}}}`. Every GSI needs capacity in provisioned mode. On-demand mode rejects throughput settings.

`updateTable(name, db, options)` supports `billingMode`, table `throughput`, per-index `indexThroughput`, one `createIndex: {name, definition, attributes, throughput?}`, or one `deleteIndex: name`. Index creation and deletion cannot be combined in a request. Existing key definitions and key attribute types are immutable. Describe/update operations are separate requests; concurrent administration can still race at the service.

`configureTimeToLive(name, attribute, enabled, db, {signal})` and `describeTimeToLive(name, db, {signal})` expose TTL configuration/status. Typed bound tables also expose these methods and restrict configuration to numeric fields. Store Unix epoch **seconds**, not milliseconds. Expired records remain readable until the service deletes them; the ORM never filters them automatically. Memory explicitly rejects TTL and throughput simulation. Backups/PITR, global tables, streams, IAM, autoscaling, tags, encryption changes, and a complete SDK facade are outside this API.

## Errors and operational rules

- AWS service and condition errors are propagated to the caller.
- Typed operations can also throw `z.ZodError` before sending or while validating returned data.
- Every fluent operation is mutable and single-use. Build a fresh operation before using `toPromise()`, `page()`, `pages()`, or `items()`.
- Execution snapshots request configuration and submitted documents, including lazy iterators. Later mutations of a retained chain cannot change the in-flight request or its result interpretation. Transactions snapshot items when added.
- Repeated `toPromise()` calls on the same operation return the cached promise and do not send the request twice.
- Do not start one execution mode and then switch to another on the same operation.
- A query requires the exact partition-key document. Exact item operations require the complete primary key.
- Filters are post-read expressions and cannot replace key conditions.
- DynamoDB rejects filter expressions that reference table primary-key attributes in some query contexts; use key conditions for key fields.
- A global secondary index query must use eventual consistency.
- Empty result collections are returned as `[]`; missing single records are returned as `null`.
- Do not reuse a cursor with a different table, index, key condition, or scan.

## API reference

### Typed table definition

```ts
defineTable({
    name,
    schema,
    outputSchema?: storedOutputObjectSchema,
    key: {partition, sort?},
    indexes?: {name: {kind: 'global' | 'local', partition, sort?, projection?}},
    timestamps?: boolean
})
```

### Typed operations

| Operation | Result |
| --- | --- |
| `create(document).toPromise()` | created record |
| `get(key).toPromise()` | record or `null` |
| `update(key)...toPromise()` | new record or `null` |
| `update(key)...returningNone().toPromise()` | `void` |
| `delete(key).toPromise()` | old record or `null` |
| `delete(key).returningNone().toPromise()` | `void` |
| `query(partitionKey).toPromise()` | records |
| `index(name).query(partitionKey).toPromise()` | projection-aware records |
| `index(name).scan().toPromise()` | projection-aware records |
| `scan().toPromise()` | records |
| `createBatch(documents, options?)` | created records |
| `getBatch(keys, options?)` | records |
| `deleteBatch(keys, options?)` | `void` |

### Read modifiers

| Modifier | Purpose |
| --- | --- |
| `sortKey().eq/gt/gte/lt/lte(value)` | compare a declared sort key |
| `sortKey().between(lower, upper)` | inclusive sort-key range |
| `sortKey().beginsWith(prefix)` | string or binary sort-key prefix |
| `where(field)...` | add a filter |
| `whereAny(callback)` / `whereAll(callback)` / `whereNot(callback)` | add a scoped predicate group |
| `path(...segments)` / `ref(...segments)` | select a document path / stored operand |
| `select(...fields)` | project and type selected fields |
| `count().toPromise()` | count matches across pages |
| `limit(chunkSize, hardLimit?)` | configure all-page reads |
| `consistent()` | request a strongly consistent table or local-index read |
| `ascending()` / `descending()` | choose query sort-key order |
| `returnCapacity(mode?)` | include consumed capacity in `toResponse()` |
| `parallel(segment, totalSegments)` | configure one segment of a parallel scan |
| `page({limit?, cursor?})` | fetch one page |
| `pages({limit?, cursor?})` | lazily iterate pages |
| `items({limit?, cursor?})` | lazily iterate records |

### Update modifiers

| Modifier | Purpose |
| --- | --- |
| `with(partial)` | set several fields |
| `set(field).eq(value)` | set one field |
| `remove(field)` | remove one field |
| `add(field).eq(value)` | add a number or set members |
| `delete(field).eq(set)` | delete set members |
| `where(field)...` | add a write condition |
| `returningAllNew()` / `returningNone()` | choose update return data |

### Condition and filter comparisons

| Comparison | DynamoDB meaning |
| --- | --- |
| `eq(value)` | equal |
| `ne(value)` | not equal |
| `gt(value)` / `gte(value)` | greater than / greater than or equal |
| `lt(value)` / `lte(value)` | less than / less than or equal |
| `contains(value)` | string substring or collection member |
| `in(values)` | equal to any supplied value |
| `not()` | negate the following comparison |
| `exists()` / `not().exists()` | attribute exists / does not exist; write conditions only |

## Evidence and fidelity

| Behavior | Offline evidence | Real-service evidence |
| --- | --- | --- |
| Request construction, cancellation, cached terminals, retries/recovery | Fake SDK and type tests | Live verification pending |
| Structured updates, sparse returns, atomic reads, multi-key indexes, ordered base-query changed-record cursors | Shared memory contract | Shared AWS contract passed in eu-west-2 on 2026-10-02 |
| Changed-record index-query and table/index scan cursors, including parallel scans | Shared memory contract; deterministic ordering/validation and file/IndexedDB reopening regressions | Shared AWS contract passed all 105 tests in eu-west-2 on 2026-10-02, including deletion, index-key movement, sparse exit and segmented continuation |
| Durable values and index metadata | File and IndexedDB tests; packaged Chromium smoke | Not an AWS persistence model |
| Item/page/transaction/batch/expression byte limits | Not simulated in memory | AWS-only assertions passed in eu-west-2 on 2026-10-02; large fixture writes are paced |
| Throttling and transaction conflicts | Injected failures only | Observed 60 conflicts in 100 requests and 714 throttle responses in 1000 requests in eu-west-2 on 2026-10-02 |
| Eventual consistency | Memory is immediately consistent | GSI tests poll convergence; never require observing stale data |
| TTL | Configuration request/type tests; memory rejects it | Follow-up bounded probe passed in eu-west-2 on 2026-10-02: expired record deleted, future-expiry control retained |

The latest shared AWS contract run (`npm run test:integration`, `AWS_REGION=eu-west-2`, `ORM_AWS_PROBE` unset, `ORM_AWS_TIMEOUT_SECONDS=600`) passed all 105 tests with no failures or skips on 2026-10-02. This includes the new changed-record index-query and table/index scan cases, ascending/descending index-key movement, sparse exit, duplicate index values, and parallel-scan continuation. The earlier 103-test run on the same date preceded these additions. Live failures first identified and corrected memory differences in sparse list images, duplicate transaction reads, and empty transaction projections. These results establish evidence for the tested cases, not exhaustive service parity.

Dedicated stress probes on the same date observed 40 completed writes and 60 conflicts (100 requests), and 286 completed writes and 714 throttle responses (1000 requests), with concurrency <= 8 and SDK retries disabled. An initial 1000-request conflict attempt failed on an unexpected AWS HTTP 500 `InternalServerError`; the fresh 100-request run passed. These stress probes were not repeated in the latest cursor/TTL verification.

The initial TTL probe completed with a 600-second workload deadline and a maximum of 60 polls, but observed no deletion and was marked inconclusive (one skipped test, no failures). A follow-up on 2026-10-02 in eu-west-2 (`npm run test:integration`, `ORM_AWS_PROBE=ttl`, `ORM_AWS_TIMEOUT_SECONDS=600`, `ORM_AWS_MAX_REQUESTS=60`) passed: a strongly consistent read observed the expired numeric-seconds record absent while the future-expiry control remained present. The test, including cleanup, took approximately 445 seconds, with one pass and no failures or skips. Cleanup completed and a separate table listing found no tables remaining from the latest contract/TTL runs. This verifies an actual asynchronous TTL deletion, not a guaranteed expiry deadline; memory still does not simulate TTL, and a future probe without an observed deletion must remain inconclusive.

## Tests

From this package:

```powershell
npm test
```

The live DynamoDB integration suite creates and removes temporary tables in the selected AWS region. It uses the standard AWS SDK credential provider chain and defaults to `eu-west-2` when `AWS_REGION` is unset:

```powershell
$env:AWS_PROFILE = 'your-profile'; $env:AWS_REGION = 'us-east-1'; npm run test:integration
```

The default AWS workload deadline is 600 seconds (`ORM_AWS_TIMEOUT_SECONDS`, range 30-3600). Credential/`ListTables` preflight is mandatory; no memory suite substitutes for it. Permissions must cover temporary table create/describe/delete, data operations, and the operations selected by a probe. Cleanup uses a separate 120-second signal and reports possible orphan resources; interrupted processes can still leave resources requiring manual cleanup.

Opt-in probes use the same command with `ORM_AWS_PROBE=conflicts`, `throttling`, or `ttl`. Stress probes cap concurrency at eight, disable SDK retries, and default to 100 workload requests (`ORM_AWS_MAX_REQUESTS`, maximum 1000), plus setup/cleanup calls. Throttling uses a 1-read/1-write provisioned table. A probe with no observed target event is explicitly skipped as **INCONCLUSIVE**, not service-parity evidence. Unexpected failures fail the test.

TTL probes default to 60 polls, spaced ten seconds apart. Their deadline may be increased to 259200 seconds (three days), with at most 25920 polls; longer runs incur charges. They verify deletion of an expired numeric-seconds record while retaining a future-expiry control. Configure both the time and request budgets deliberately. No AWS account, role, or environment is provisioned by these scripts.
