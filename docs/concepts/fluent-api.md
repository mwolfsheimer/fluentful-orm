# Read and build fluent chains

A fluent API lets you describe an operation through connected method calls. Each call configures the same operation or returns a smaller subchain for the next choice.

The usual lifecycle is:

**Choose an operation → configure it → execute it → inspect its result.**

## Read a chain line by line

This fragment uses the [shared task setup](../getting-started/task-setup.md):

```ts
const openTasks = await tasks
    .query({projectId: 'project-1'})
    .sortKey().beginsWith('task-')
    .where('status').ne('done')
    .toPromise();
```

| Step | Meaning |
| --- | --- |
| `query(...)` | Choose the project using partition-key equality. |
| `sortKey()` | Enter a comparison subchain for the declared sort key. |
| `beginsWith(...)` | Complete that comparison and return to the operation. |
| `where('status')` | Enter another comparison subchain. |
| `ne('done')` | Complete a post-read filter: status is not done. |
| `toPromise()` | Execute and return the matching records. |
| `await` | Wait for completion or propagate a rejected promise. |

Calling `where()` alone is incomplete. Autocomplete can help you find allowed next methods, but it cannot choose a suitable DynamoDB access pattern for you.

## The same spelling can have a different purpose

On a query or scan, `where()` filters items **after they are evaluated**. It does not replace key selection.

On a create, update, or delete, `where()` checks the stored record **before changing it**. A failed condition prevents that write.

On an update, `set('status').eq('done')` assigns a value. The `eq()` here completes an assignment, not a filter.

See [queries and filters](./queries-and-filters.md) and [conditional writes](../guides/conditions.md).

## Definitions are reusable; operation chains are not templates

Reuse your table definition and its bound `tasks` object. Create a fresh operation each time.

Avoid this if you intend two separate database reads:

```ts
const read = tasks.get(key);
const first = await read.toPromise();
const second = await read.toPromise(); // Cached execution, not a new read.
```

Instead:

```ts
const first = await tasks.get(key).toPromise();
const second = await tasks.get(key).toPromise();
```

Builders are mutable. Execution snapshots configuration, and later mutations cannot alter an in-flight request. Do not share a retained operation between concurrent callers or try to reconfigure it as a new request.

## Choose an execution style deliberately

- `toPromise()`: return the operation's value. Queries/scans follow pages.
- `toResponse()`: return the value with requested service metadata.
- `page()`: return one page and a continuation cursor.
- `pages()` / `items()`: request more data as iteration advances.
- `toResult()`: on supported single writes, represent a conditional failure as a result.
- `toPromiseOrNull()`: on supported updates, discard an expected conditional failure as null.

Do not switch between pagination/iteration and ordinary execution on an operation that has already started. Compatible write terminal views can share a cached execution; they do not send another write. See [execution contracts](../reference/execution.md).

## Let returned types guide you

Selecting fields changes the inferred returned record shape. Return modes can change a write result to `void`, a nullable record, or a partial image. A failure-image option changes conditional error data, not the successful result.

Use [return modes](../reference/return-modes.md) when you need these distinctions. Do not use a TypeScript assertion to bypass runtime validation.
