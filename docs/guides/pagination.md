# Fetch pages or stream results

Choose all results, one page, or a lazy iterator. An empty filtered page can still have a cursor: continue until the cursor is null.

**Examples on this page are independent fragments, not a script to concatenate.** Start with the [shared task setup](../getting-started/task-setup.md). It defines `tasks`, `tasksTable`, `taskSchema`, `dynamoDB`, `key`, `newTask`, `newTasks`, and `taskKeys`. Other table names and callbacks are explained where introduced; supply application-specific data where indicated.



There are four read execution styles. Create a fresh fluent operation for each style.

## Read every matching item

```ts
const all = await tasks.query({projectId: 'project-1'}).toPromise();
```

## Read one resumable page

```ts
const firstPage = await tasks
    .query({projectId: 'project-1'})
    .page({limit: 25});

const secondPage = firstPage.cursor === null
    ? null
    : await tasks
        .query({projectId: 'project-1'})
        .page({limit: 25, cursor: firstPage.cursor});
```

A page has this shape:

```ts
interface QueryPage<T> {
    items: T[];
    cursor: Record<string, string | number | Uint8Array> | null;
    count?: number;
    scannedCount?: number;
    consumedCapacity?: ConsumedCapacity;
}
```

The cursor is DynamoDB's deserialized `LastEvaluatedKey`. Treat it as opaque and return it unchanged. For a composite table or index it must contain the complete primary key required by DynamoDB. `null` means there are no more pages.

The page limit is DynamoDB's evaluated-item limit. A filtered page can contain fewer items than the requested limit, including zero items, while still returning a non-null cursor.

Metadata is page-local, not cumulative: `count` is the service count after filtering, `scannedCount` is evaluated work, and capacity is returned when requested with `returnCapacity()`. Absent metadata stays absent rather than being changed to zero. Capacity values are cloned.

## Iterate pages lazily

```ts
for await (const page of tasks
    .query({projectId: 'project-1'})
    .pages({limit: 25})) {
    await processPage(page.items);
}
```

Pass `cursor` alongside `limit` to resume the iterator.

## Iterate items lazily

```ts
for await (const task of tasks
    .query({projectId: 'project-1'})
    .items({limit: 25})) {
    await processTask(task);
}
```

Async iterators request pages only as iteration advances.

## Chunk size and hard limit

`limit(chunkSize, hardLimit)` configures all-page `toPromise()` reads:

```ts
const firstHundred = await tasks
    .scan()
    .limit(25, 100)
    .where('status').eq('todo')
    .toPromise();
```

- `chunkSize` is the DynamoDB `Limit` for each request.
- `hardLimit` is the maximum number of returned items across requests.
- use `null` for no hard result limit: `.limit(25, null)`.
- filtering can require several DynamoDB requests to reach the hard result limit.

Both limits must be positive when supplied. For externally controlled pagination, prefer `page()`.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
