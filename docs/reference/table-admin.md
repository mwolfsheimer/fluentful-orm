# Table administration

Storage definitions describe table/index keys and projections, not a complete infrastructure deployment. Fragments assume a configured `dynamoDB` client; see [AWS setup](../getting-started/aws.md). Creating and deleting cloud resources can incur charges.

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

## Operational administration

All existing administration helpers accept an optional final options object with `signal`. `listTablePage(db, {limit, cursor, signal})` returns `{names, cursor}`, with a limit from 1 to 100. `listTables()` still follows all pages. `waitForTable(name, db, options)` and `waitForTableDeleted(...)` are abortable; `maxWaitTime`, `minDelay`, and `maxDelay` are seconds. Table readiness alone does not establish GSI backfill/convergence; inspect index status and poll expected results.

`createTable(definition, db, options)` defaults to on-demand billing. To provision capacity, pass `{billingMode: 'PROVISIONED', throughput: {read: 5, write: 5}, indexThroughput: {indexName: {read: 5, write: 5}}}`. Every GSI needs capacity in provisioned mode. On-demand mode rejects throughput settings.

`updateTable(name, db, options)` supports `billingMode`, table `throughput`, per-index `indexThroughput`, one `createIndex: {name, definition, attributes, throughput?}`, or one `deleteIndex: name`. Index creation and deletion cannot be combined in a request. Existing key definitions and key attribute types are immutable. Describe/update operations are separate requests; concurrent administration can still race at the service.

`configureTimeToLive(name, attribute, enabled, db, {signal})` and `describeTimeToLive(name, db, {signal})` expose TTL configuration/status. Typed bound tables also expose these methods and restrict configuration to numeric fields. Store Unix epoch **seconds**, not milliseconds. Expired records remain readable until the service deletes them; the ORM never filters them automatically. Memory explicitly rejects TTL and throughput simulation. Backups/PITR, global tables, streams, IAM, autoscaling, tags, encryption changes, and a complete SDK facade are outside this API.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
