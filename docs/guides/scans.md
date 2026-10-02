# Scan when a key-based query is not available

A scan evaluates records across a table or index. Treat it as deliberate bulk work, not the default way to serve requests.

**Examples on this page are independent fragments, not a script to concatenate.** Start with the [shared task setup](../getting-started/task-setup.md). It defines `tasks`, `tasksTable`, `taskSchema`, `dynamoDB`, `key`, `newTask`, `newTasks`, and `taskKeys`. Other table names and callbacks are explained where introduced; supply application-specific data where indicated.



A scan reads across the table and can use the same filter comparisons as a query:

```ts
const matching = await tasks
    .scan()
    .where('status').eq('doing')
    .where('title').contains('guide')
    .toPromise();
```

Call `.consistent()` for a strongly consistent scan:

```ts
const matching = await tasks.scan().consistent().where('status').eq('doing').toPromise();
```

Scans may consume substantial read capacity. Prefer a query for request paths and known access patterns.

## Index scans

```ts
await tasks.index('status-index').scan()
    .where('status').eq('doing')
    .limit(25)
    .toPromise();
```

A low-level scan can read one parallel segment:

```ts
const firstSegment = await new QueryBuilder('tasks', dynamoDB).scan()
    .usingIndex('status-index', 'global')
    .parallel(0, 4)
    .toPromise();
```

`firstSegment` contains only segment `0` of four, not the whole index. To read every segment, create an independent operation for each:

```ts
const segments = [0, 1, 2, 3];
const segmentResults = await Promise.all(segments.map(segment =>
    new QueryBuilder('tasks', dynamoDB).scan()
        .usingIndex('status-index', 'global')
        .parallel(segment, segments.length)
        .toPromise()
));
const indexedTasks = segmentResults.flat();
```

Each `toPromise()` follows all pages for its segment. This runs four segment reads concurrently; merging their results does not impose an order or provide a point-in-time snapshot of a changing index.

Index scans support projections, counts, pagination, lazy pages/items, hard limits, consumed-capacity metadata, and parallel segments. They have no ascending/descending controls. GSI consistent reads are rejected before sending in either modifier order. LSI scans support consistency and may explicitly select permitted non-projected table fields. GSI reads can return only projected fields; typed index filters and references also require projected fields. Low-level GSI scan filters see non-projected fields as absent. Query-key filter restrictions do not apply to scans.

Scan results are unordered. Pass continuation cursors unchanged, including table/index keys, and use each parallel-scan cursor only with its original segment. See the [AWS Scan API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Scan.html).

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
