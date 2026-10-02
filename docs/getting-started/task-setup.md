# Shared task setup

The first tutorial identifies each task by `id`. The remaining guides use projects with multiple tasks, so each task has a two-part key: `projectId` and `taskId`.

This setup also declares a status index so we can find tasks across projects by status and priority. It is an example access pattern, not a recommended production key design for every task application.

## Fixture module

Save this complete helper module as `task-setup.ts` beside the recipe scripts. It does not run on import: `withTasks()` creates an isolated memory engine, seeds two tasks, runs your callback, and closes the engine.

<!-- example: examples/docs/task-setup.ts -->
```ts
import {createEngine, defineTable, QueryBuilder} from '@fluentful/orm';
import {z} from 'zod';

export const taskSchema = z.object({
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

export const tasksTable = defineTable({
    name: 'tasks',
    schema: taskSchema,
    key: {partition: 'projectId', sort: 'taskId'},
    indexes: {
        'status-index': {kind: 'global', partition: 'status', sort: 'priority'}
    }
});

const key = {projectId: 'project-1', taskId: 'task-1'};
const newTask = {
    projectId: 'project-1', taskId: 'task-3',
    status: 'todo' as const, title: 'Review the guide', priority: 3
};
const newTasks = [
    newTask,
    {...newTask, taskId: 'task-4', title: 'Publish the guide'}
];

type TaskContext = {
    tasks: ReturnType<typeof tasksTable.using>;
    tasksTable: typeof tasksTable;
    taskSchema: typeof taskSchema;
    dynamoDB: Parameters<typeof tasksTable.using>[0];
    key: typeof key;
    newTask: typeof newTask;
    newTasks: typeof newTasks;
    taskKeys: Array<typeof key>;
};

export async function withTasks(run: (context: TaskContext) => Promise<void>) {
    const engine = createEngine.memory();
    try {
        await QueryBuilder.createTable({
            name: 'tasks',
            key: {partition: 'projectId', sort: 'taskId'},
            attributes: {projectId: 'S', taskId: 'S', status: 'S', priority: 'N'},
            indexes: {
                'status-index': {kind: 'global', partition: 'status', sort: 'priority'}
            }
        }, engine.db);
        const tasks = tasksTable.using(engine.db);
        await tasks.createBatch([
            {...key, status: 'doing', title: 'Write the guide', priority: 10},
            {...key, taskId: 'task-2', status: 'todo', title: 'Add examples', priority: 5}
        ]);
        await run({
            tasks, tasksTable, taskSchema, dynamoDB: engine.db,
            key, newTask, newTasks,
            taskKeys: [key, {...key, taskId: 'task-2'}]
        });
    } finally {
        await engine.close();
    }
}
```
<!-- /example -->

The seed records are:

| Key | Title | Status | Priority |
| --- | --- | --- | --- |
| project-1 / task-1 | Write the guide | doing | 10 |
| project-1 / task-2 | Add examples | todo | 5 |

`newTask` and `newTasks` are additional sample records, not already stored records. `taskKeys` identifies the two seed tasks. Timestamps are off unless a particular example enables them.

## Run a guide fragment

A fragment is a small part of a program, not a complete file. Choose **one** example from a guide and place it inside this callback:

```ts
import {withTasks} from './task-setup';

withTasks(async ({tasks, tasksTable, taskSchema, dynamoDB, key, newTask, newTasks, taskKeys}) => {
    const task = await tasks.get(key).toPromise();
    console.log(task?.title); // Write the guide
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```

Some advanced fragments introduce a different table such as `counters`, `records`, or `auditTable`. Those require their own storage definition, schema, and seed records; they are not supplied by this fixture. Any named processing callback represents your application logic. Comparison and signature lists are syntax illustrations, not standalone programs.

## Run the repository's examples

From a repository checkout:

```sh
npm ci
npm run test:docs
```

This builds the package, typechecks the example files, checks displayed examples and links, and executes all local recipe scripts. No AWS credentials are used.

Next: [task recipes](../guides/recipes.md) or [keys and access patterns](../concepts/keys-and-access-patterns.md).
