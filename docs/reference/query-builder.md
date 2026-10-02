# Lower-level QueryBuilder

Use this API for dynamic tables, tooling, or incremental migration. Generic result types are assertions, not Zod runtime validation. Examples are fragments; configure `dynamoDB` as shown in [AWS setup](../getting-started/aws.md).

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

## Lower-level transactions

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

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
