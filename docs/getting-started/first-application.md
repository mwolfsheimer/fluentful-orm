# Run your first application

Create and retrieve a task without AWS credentials, a cloud bill, or a local DynamoDB server.

## Before you begin

Use Node.js 20 or later. These examples are TypeScript, using the package's CommonJS build. Install the package and its required peers:

```sh
npm install @fluentful/orm @aws-sdk/client-dynamodb@^3.1037.0 zod@^4.3.6
```

In an existing TypeScript application, use its normal runner. For a standalone example in a new directory:

```sh
npm install --save-dev typescript@^6 ts-node@^10 @types/node@^22
```

For a new CommonJS project, save this configuration as `tsconfig.json`:

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "Node16",
        "moduleResolution": "Node16",
        "strict": true,
        "types": ["node"]
    }
}
```

Save the following as `quick-start.ts`. This is a complete script; it creates its own temporary in-memory table and closes the engine.

## Create and read one task

<!-- example: examples/docs/quick-start.ts -->
```ts
import {createEngine, defineTable, QueryBuilder} from '@fluentful/orm';
import {z} from 'zod';

async function main() {
    const engine = createEngine.memory();
    try {
        // This creates storage; defineTable below only describes validation.
        await QueryBuilder.createTable('tasks', 'id', engine.db);
        const tasks = defineTable({
            name: 'tasks',
            key: {partition: 'id'},
            schema: z.object({
                id: z.string(),
                title: z.string(),
                status: z.enum(['todo', 'doing', 'done'])
            }).strict()
        }).using(engine.db);

        await tasks.create({
            id: 'task-1', title: 'Write the guide', status: 'todo'
        }).toPromise();
        const task = await tasks.get({id: 'task-1'}).toPromise();
        console.log(JSON.stringify(task));
    } finally {
        await engine.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```
<!-- /example -->

Expected output:

```json
{"id":"task-1","title":"Write the guide","status":"todo"}
```

Run it in a CommonJS project:

```sh
npx ts-node quick-start.ts
```

If your project uses ESM, use its configured TypeScript runner instead of the standalone CommonJS command.

## What happened?

1. `createEngine.memory()` provides a process-local backend. It makes no AWS requests.
2. `QueryBuilder.createTable()` creates the storage table with a string key named `id`.
3. `defineTable()` describes your application's data and key fields. It does **not** create storage.
4. `.using(engine.db)` binds that definition to the backend.
5. `create(...).toPromise()` writes the task; `get(...).toPromise()` reads it.
6. `close()` releases the client. Memory data does not survive another process.

Zod validates records at runtime, not only in the editor. A missing task returns `null`; invalid data can throw a Zod validation error. By default, creating at an existing key replaces its record. Learn the [create-only condition](../guides/read-write.md#create) before using application-controlled keys.

## Next steps

- [Read a fluent chain](../concepts/fluent-api.md).
- [Add projects and query their tasks](./task-setup.md).
- [Connect the same typed API to AWS](./aws.md).
