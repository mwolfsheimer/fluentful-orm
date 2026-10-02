# Use timestamps, logging, and response metadata

Inspect execution without confusing the returned record with service metadata. Never log credentials, secrets, or sensitive records.

**Examples on this page are independent fragments, not a script to concatenate.** Start with the [shared task setup](../getting-started/task-setup.md). It defines `tasks`, `tasksTable`, `taskSchema`, `dynamoDB`, `key`, `newTask`, `newTasks`, and `taskKeys`. Other table names and callbacks are explained where introduced; supply application-specific data where indicated.



## Automatic timestamps

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

## Logging

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

## Response metadata

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

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
