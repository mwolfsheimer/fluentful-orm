# Find records with a query

Choose a table or index key that matches the question your application asks. Read [keys and access patterns](../concepts/keys-and-access-patterns.md) if partition and sort keys are new to you.

**Examples on this page are independent fragments, not a script to concatenate.** Start with the [shared task setup](../getting-started/task-setup.md). It defines `tasks`, `tasksTable`, `taskSchema`, `dynamoDB`, `key`, `newTask`, `newTasks`, and `taskKeys`. Other table names and callbacks are explained where introduced; supply application-specific data where indicated.



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

## Query an index

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
            projection: {type: 'INCLUDE', nonKeyAttributes: ['title']}
        }
    }
});
```

The selected index determines the required partition key and the type of `.sortKey()` comparisons. A consistent read requested from a declared global secondary index throws before sending the request. Local secondary indexes can use consistent reads when declared with `kind: 'local'`.

Untyped `QueryBuilder.usingIndex()` treats an omitted kind as `global`. Pass `.usingIndex('index-name', 'local')` only for a known local secondary index when requesting a consistent read.

## Multi-attribute GSIs

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

## Query filters

Additional `.where()` clauses on a query are DynamoDB filter expressions:

```ts
const importantOpenTasks = await tasks
    .query({projectId: 'project-1'})
    .where('status').ne('done')
    .where('priority').gte(10)
    .toPromise();
```

Filters are applied after DynamoDB evaluates items. They reduce returned items, not read capacity. Do not use a filter where a table or index key can model the access pattern.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
