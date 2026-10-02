# Indexes and consistency

An index is another key-based way to find records. It is not an arbitrary-field search engine.

## Find tasks by status

The [task setup](../getting-started/task-setup.md) declares `status-index`:

```ts
'status-index': {kind: 'global', partition: 'status', sort: 'priority'}
```

The corresponding query fragment is:

```ts
const todoTasks = await tasks.index('status-index')
    .query({status: 'todo'})
    .sortKey().gte(5)
    .toPromise();
```

Select the index before starting the typed query. The selected index determines the key document, allowed comparisons, and returned projected fields.

## Know which kind of index you use

- A **global secondary index (GSI)** can use a different partition key from the table. Reads are eventually consistent.
- A **local secondary index (LSI)** shares the table partition key and provides another sort key. It must be defined when the table is created and can support strongly consistent reads.

The library rejects `.consistent()` for a declared GSI before sending. It does not make GSIs strongly consistent through retries.

## Why a recent update might not appear

Eventually consistent reads can temporarily reflect an earlier state. A successful base-table write does not promise immediate visibility through a GSI.

If you know a record's complete base-table key and need a strongly consistent point read, use `get(key).consistent()`. If you must verify index convergence, poll with a deliberate timeout rather than assume a fixed sleep establishes correctness.

Memory reflects updates immediately. It does not demonstrate production propagation timing.

## Projections and sparse indexes

An index projection determines which fields are available from the index. A GSI cannot fetch unprojected fields from the table on your behalf; the typed API reflects the configured result shape.

An item missing required index-key fields is not included in that index. This is called a **sparse index**. A missing key is different from an invalid empty or null key.

See [query/index details](../guides/queries.md), [table definitions](../reference/table-admin.md), and AWS's [GSI documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html).
