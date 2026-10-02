# Read or write atomically

Use a transaction when a group of operations must succeed or fail together. Transaction write callbacks describe work; do not execute individual writes inside them.

**Examples on this page are independent fragments, not a script to concatenate.** Start with the [shared task setup](../getting-started/task-setup.md). It defines `tasks`, `tasksTable`, `taskSchema`, `dynamoDB`, `key`, `newTask`, `newTasks`, and `taskKeys`. Other table names and callbacks are explained where introduced; supply application-specific data where indicated.



`typedTransaction()` composes up to 100 create, update, delete, or condition-check operations across typed tables.

This fragment also needs an `auditTable` typed definition with string `eventId` as its key and string `type` and `taskId` fields, plus the corresponding storage table. The [complete task-only recipe](./recipes.md#move-two-tasks-to-their-next-states-together) avoids that additional setup.

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

## Atomic read transactions

`typedReadTransaction(db).add(tableDefinition, key, optionalProjection)` infers a heterogeneous ordered tuple; `transactGet(db).add(tableName, key, optionalProjection)` is the low-level equivalent. Both expose `toPromise({signal})`, `toResponse({signal})`, `returnCapacity('TOTAL' | 'NONE')`, and `logger()`. Results are cached after the first execution. Missing items retain a `null` position; a projection selecting no existing attributes also returns `null`, so these cases cannot be distinguished from that response alone. Multiple reads of the same table/key in one transaction are rejected, even with different projections or when the item is missing.

The following fragment additionally assumes a separately provisioned `projectTable` typed definition and its complete `projectKey`; both records must already exist for a non-null result. The first result selects only the task title.

```ts
import {typedReadTransaction} from '@fluentful/orm';
const [task, project] = await typedReadTransaction(dynamoDB)
    .add(tasksTable, key, ['title'])
    .add(projectTable, projectKey)
    .toPromise();
```

This is one atomic `TransactGetItems` request, never chunked: 1-100 entries, base tables only, same account/region, and a service aggregate limit of 4 MB. Memory takes a deterministic serial snapshot but does not simulate distributed contention or byte limits. DynamoDB service failures are propagated unchanged.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
