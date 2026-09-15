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

Supported environments are Node.js 18 or later and TypeScript 6. Install the required peer dependencies alongside the package: `@aws-sdk/client-dynamodb` ^3.1037.0 and `zod` ^4.3.6. Bring your own configured `DynamoDBClient`, or use the dependency-free in-memory backend in tests and local workflows.

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
        'status-index': {partition: 'status', sort: 'priority'}
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

Applications can inject a dependency-free, process-local backend instead of an AWS client. No server, port, credentials lookup, filesystem storage, or npm dependency is needed. Each instance owns its own tables and records.

```ts
import {createInMemoryDynamoDB, defineTable, QueryBuilder} from '@fluentful/orm';
import {z} from 'zod';

const memory = createInMemoryDynamoDB();

try {
    await QueryBuilder.createTable('accounts', 'id', memory.db);

    const accounts = defineTable({
        name: 'accounts',
        key: {partition: 'id'},
        schema: z.object({id: z.string(), credits: z.number()})
    }).using(memory.db);

    await accounts.create({id: 'account-1', credits: 10}).toPromise();
    await accounts.update({id: 'account-1'})
        .add('credits').eq(-1)
        .where('credits').gte(1)
        .toPromise();

    const account = await accounts.get({id: 'account-1'}).toPromise();
    // account: {id: 'account-1', credits: 9}

    memory.reset();
} finally {
    await memory.close();
}
```

Pass `memory.db` into application constructors that already accept `DynamoDBClient`, or use it with the lower-level `new QueryBuilder(tableName, memory.db)`. Seed records through normal create/batch APIs. `reset()` clears records and transaction request tokens but retains table definitions; `close()` clears everything, destroys the client, and rejects later requests. Closing more than once is safe.

Tables must be declared before use. Supply QueryBuilder-owned `DynamoDBTableDefinition` values to `createInMemoryDynamoDB([definition, ...])` for synchronous initialisation, or use `await QueryBuilder.createTable(definition, memory.db)`. Both paths use the same validation and translation, supporting composite keys, attribute types, global/local indexes and optional index projections without AWS request fields. Existing SDK `CreateTableCommandInput` constructor inputs remain supported for compatibility. Typed `defineTable()` describes application validation and does not create storage tables. Index projections support `ALL`, `KEYS_ONLY` and `INCLUDE`; omission preserves the existing `ALL` default.

Supported QueryBuilder behaviour:

- Create, get, replace, update/upsert and delete; update/delete return modes; timestamps; batch operations.
- Scalar, binary, list, map and set values through the existing serializer, with cloned reads and writes to avoid shared references.
- Generated conditions and filters: comparisons, `IN`, `contains`, existence checks, negation and `AND`; generated sort-key comparisons, `BETWEEN` and `begins_with`.
- `SET`, `REMOVE`, numeric/set `ADD`, and set `DELETE` updates.
- Table/index queries, sparse index membership, sort ordering, scans, projections, counts, page cursors and iterators. Page limits apply before filters, including empty filtered pages with continuation cursors.
- Atomic cross-table write transactions and condition checks, rollback on failure, conditional failure diagnostics, duplicate-target rejection, and ten-minute transaction request-token idempotency. Typed tables and typed transactions use the same backend.
- Create, describe, list and delete table operations.

This is a test stub for the promise-based SDK commands and expression subset generated by QueryBuilder, not a general DynamoDB emulator. Unsupported commands and expression syntax throw rather than succeed silently. It does not reproduce every AWS request-validation rule, capacity/throttling, retries/unprocessed batches, TTL expiry, streams, IAM, eventual consistency, transaction conflicts, SDK middleware/callbacks, or item/response byte-size limits. Numbers follow QueryBuilder's JavaScript-number serialization. Reads are immediately consistent; scans use insertion order. Cursors require an existing matching record, so deleting or changing that record between pages is not supported. Raw SDK features outside the listed subset are not part of this contract.

### Shared backend tests

`test/query-builder.contract.ts` defines the behavioural tests once and accepts a backend client. The memory and real DynamoDB runners execute the same test bodies and assertions, including CRUD, conditions, pagination, batches, typed operations and transactions. Add application-visible query behaviour tests to this shared suite rather than creating a separate fake-only copy.

From this package:

- `npm test` builds the package and runs the command-construction/serialization unit tests, the shared contract against memory, and fake-specific lifecycle checks. No AWS access is required.
- `npm run test:memory` runs only the shared memory contract and fake-specific lifecycle checks.
- `npm run test:integration` runs every shared contract test against both memory and real DynamoDB. AWS credentials and permission to create/delete temporary test tables are required. Each run creates uniquely named tables and removes them during teardown.

Command-construction, mocked retry/failure, and type-validation unit tests remain separate because they inspect generated requests or deliberately inject SDK responses. Only backend-specific behaviours such as memory reset/close and unsupported-operation errors belong in the fake lifecycle suite. Real AWS execution remains necessary to catch differences the stub does not model.

## Define a table

Call `defineTable()` once and reuse the resulting definition. Call `.using(client)` where an operation needs to be performed. The typed factory is also available as `QueryBuilder.defineTable()`.

```ts
const tasksTable = defineTable({
    name: 'tasks',
    schema: taskSchema,
    key: {partition: 'projectId', sort: 'taskId'},
    indexes: {
        'status-index': {partition: 'status', sort: 'priority'}
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

Key fields must be required schema fields whose output type is `string`, `number`, or `Buffer`. Exact operations such as `get`, `update`, and `delete` require the complete key and no extra properties. A `query` accepts only the partition key because sort-key restrictions are added through `.sortKey()`.

Indexes use the same key shape. Their names and key fields are inferred:

```ts
indexes: {
    'status-index': {partition: 'status', sort: 'priority'},
    'owner-index': {partition: 'ownerId'}
}
```

### Zod input and output types

`create()` and `createBatch()` accept the schema input type. Returned values use the schema output type, so Zod transforms and defaults are respected.

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
```

`.in([])` is invalid. The typed API validates every comparison value against the selected field. For a set or array field, `.contains(value)` validates the member type rather than the collection type.

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
    cursor: Record<string, string | number | Buffer> | null;
}
```

The cursor is DynamoDB's deserialized `LastEvaluatedKey`. Treat it as opaque and return it unchanged. For a composite table or index it must contain the complete primary key required by DynamoDB. `null` means there are no more pages.

The page limit is DynamoDB's evaluated-item limit. A filtered page can contain fewer items than the requested limit, including zero items, while still returning a non-null cursor.

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

For legacy callers, a boolean second argument remains supported: `true` means serial chunks and `false` means unbounded concurrency. New code should use `{concurrency}`.

Batch operations are not atomic and do not support per-item conditions. Use a transaction when all writes must succeed or fail together.

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

For typed tables, express complex fields in the Zod schema, for example `z.array(z.string())`, `z.set(z.string())`, `z.object({owner: z.string()})`, and `z.instanceof(Buffer)`. Complete arrays and sets are validated on writes and reads. A typed `.contains(value)` comparison validates `value` against the element schema for both array and Set fields, rather than expecting the whole collection:

```ts
const taskSchema = z.object({
    id: z.string(),
    labels: z.array(z.string()),
    tags: z.set(z.string()),
    metadata: z.object({owner: z.string()}),
    payload: z.instanceof(Buffer)
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

Finite JavaScript numbers are serialized without deliberately rounding them, including safe-integer boundaries and scientific notation. `undefined` object properties are omitted from creates and `.with()` updates, but an `undefined` array member is invalid. Invalid values such as non-finite numbers, symbols, functions, and empty Sets throw before the request is sent.

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

`getTableDefinition()` returns `{name, key, attributes, indexes}`, validates key and projection metadata, and preserves non-`ALL` projections. Canonical `ALL` projections remain omitted for compatibility. You can reuse that definition to create the supported key/index structure under a different name. It is not a complete infrastructure-cloning API; use infrastructure tooling for billing settings, streams, TTL, encryption, tags, and other operational features.

Global secondary index queries can return and filter only projected attributes. Local secondary index queries return projected attributes by default but may explicitly select attributes from the base table. Typed index queries infer these result shapes and validate returned partial records against projection-specific schemas.

The normalised definition does not include a Zod schema because DynamoDB does not store application-level validation rules. Runtime strings returned by DynamoDB also cannot provide the literal-key inference of a statically declared `defineTable()` definition; use this helper for inspection, generation, or runtime schema verification. Previously hand-written `DynamoDBTableDefinition` values must now supply `attributes`.

## Errors and operational rules

- AWS service and condition errors are propagated to the caller.
- Typed operations can also throw `z.ZodError` before sending or while validating returned data.
- Every fluent operation is mutable and single-use. Build a fresh operation before using `toPromise()`, `page()`, `pages()`, or `items()`.
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
    key: {partition, sort?},
    indexes?: {name: {partition, sort?}},
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
| `index(name).query(partitionKey).toPromise()` | records |
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

## Tests

From this package:

```powershell
npm test
```

The live DynamoDB integration suite creates and removes temporary tables in the selected AWS region. It uses the standard AWS SDK credential provider chain and defaults to `eu-west-2` when `AWS_REGION` is unset:

```powershell
$env:AWS_PROFILE = 'your-profile'; $env:AWS_REGION = 'us-east-1'; npm run test:integration
```
