# Create, read, and delete records

Use an exact key to work with one record. A create replaces the record at that key unless you add a condition.

**Examples on this page are independent fragments, not a script to concatenate.** Start with the [shared task setup](../getting-started/task-setup.md). It defines `tasks`, `tasksTable`, `taskSchema`, `dynamoDB`, `key`, `newTask`, `newTasks`, and `taskKeys`. Other table names and callbacks are explained where introduced; supply application-specific data where indicated.



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

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
