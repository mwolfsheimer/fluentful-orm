# Task recipes

These scripts use the [shared task setup](../getting-started/task-setup.md). Save `task-setup.ts` and the chosen script in the **same directory**, then run the script with your configured TypeScript runner. Each recipe starts with fresh seeded memory data and closes its engine. It makes no AWS requests.

In a repository checkout, `npm run test:docs` executes these scripts and checks the expected output. Individual files live in [the examples directory](https://github.com/mwolfsheimer/fluentful-orm/tree/main/examples/docs). The examples assume the package and peer versions from [installation](../getting-started/first-application.md#before-you-begin).

## Find a project's tasks and query the status index

The first query uses the table key; the second uses an index key. Neither needs a post-read filter.

<!-- example: examples/docs/queries.ts -->
```ts
import {withTasks} from './task-setup';

withTasks(async ({tasks}) => {
    const projectTasks = await tasks.query({projectId: 'project-1'})
        .sortKey().beginsWith('task-')
        .toPromise();
    const todoTasks = await tasks.index('status-index')
        .query({status: 'todo'})
        .sortKey().gte(5)
        .toPromise();

    console.log(JSON.stringify({
        projectTitles: projectTasks.map(task => task.title),
        todoTitles: todoTasks.map(task => task.title)
    }));
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```
<!-- /example -->

Expected output:

```json
{"projectTitles":["Write the guide","Add examples"],"todoTitles":["Add examples"]}
```

[Detailed guide](./queries.md)

## Continue through an empty page

The first evaluated task is doing, so the first filtered page is empty. The iterator still follows the cursor to the todo task. The limit is evaluated work per request, not guaranteed matches.

<!-- example: examples/docs/pagination.ts -->
```ts
import {withTasks} from './task-setup';

withTasks(async ({tasks}) => {
    const pageSizes: number[] = [];
    const titles: string[] = [];
    for await (const page of tasks.query({projectId: 'project-1'})
        .where('status').eq('todo')
        .pages({limit: 1})) {
        pageSizes.push(page.items.length);
        titles.push(...page.items.map(task => task.title));
    }
    console.log(JSON.stringify({pageSizes, titles}));
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```
<!-- /example -->

Expected output:

```json
{"pageSizes":[0,1],"titles":["Add examples"]}
```

[Detailed guide](./pagination.md)

## Complete a task only if it is in progress

Each call creates a fresh conditional update. The first applies; the second does not, because the task is now done. Infrastructure and validation errors still reject.

<!-- example: examples/docs/conditions.ts -->
```ts
import {withTasks} from './task-setup';

withTasks(async ({tasks, key}) => {
    const complete = () => tasks.update(key)
        .set('status').eq('done')
        .where('status').eq('doing')
        .onConditionFailure().returningAllOld()
        .toResult();

    const first = await complete();
    const second = await complete();
    console.log(JSON.stringify({
        firstApplied: first.applied,
        secondApplied: second.applied,
        previousStatus: second.applied ? null : second.previous?.status
    }));
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```
<!-- /example -->

Expected output:

```json
{"firstApplied":true,"secondApplied":false,"previousStatus":"done"}
```

[Detailed guide](./conditions.md)

## Move two tasks to their next states together

Both conditions must hold. If either fails, neither write is applied. Distinct task keys satisfy the transaction rule against targeting an item twice.

<!-- example: examples/docs/transactions.ts -->
```ts
import {typedTransaction} from '@fluentful/orm';
import {withTasks} from './task-setup';

withTasks(async ({tasks, tasksTable, dynamoDB, key}) => {
    const secondKey = {...key, taskId: 'task-2'};
    await typedTransaction(dynamoDB)
        .add(tasksTable, table => table.update(key)
            .set('status').eq('done').where('status').eq('doing'))
        .add(tasksTable, table => table.update(secondKey)
            .set('status').eq('doing').where('status').eq('todo'))
        .toPromise();

    const first = await tasks.get(key).toPromise();
    const second = await tasks.get(secondKey).toPromise();
    console.log(JSON.stringify({firstStatus: first?.status, secondStatus: second?.status}));
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```
<!-- /example -->

Expected output:

```json
{"firstStatus":"done","secondStatus":"doing"}
```

[Detailed guide](./transactions.md)

## Inspect a batch outcome before considering retries

Memory completes these writes. In a service failure, use resumable only for explicitly unprocessed or never-submitted inputs; reconcile unknown writes separately. This example reports the outcome, it does not automatically retry unknown work.

<!-- example: examples/docs/batches.ts -->
```ts
import {withTasks} from './task-setup';

withTasks(async ({tasks, newTasks}) => {
    const outcome = await tasks.createBatchResult(newTasks, {concurrency: 2});
    console.log(JSON.stringify({
        completed: outcome.completed.length,
        resumable: outcome.resumable.length,
        unknown: outcome.unknown.length
    }));
    // Reconcile unknown writes before retrying; only resumable is safe to resubmit.
    if (outcome.errors.length > 0) {
        throw outcome.errors[0];
    }
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```
<!-- /example -->

Expected output:

```json
{"completed":2,"resumable":0,"unknown":0}
```

[Detailed guide](./batches.md)
