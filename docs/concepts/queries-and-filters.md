# Queries, scans, and filters

A query and a scan can return similar records while doing very different amounts of work.

## Choose the operation

| You know... | Start with... |
| --- | --- |
| The complete primary key | `get()` |
| A partition-key value | `query()` |
| A suitable secondary-index partition key | `index(name).query()` |
| No usable table/index key | Consider a scan or redesign the access pattern |

A query requires partition-key equality. A scan evaluates records across the selected table or index; it is useful for deliberate bulk work but can be expensive.

## Understand where filtering happens

For a query, the simplified order is:

**Key selection → evaluate items → filter evaluated items → return matches.**

A filter can discard results, but does not undo the read work already done. Projecting fewer fields also does not generally reduce the read capacity charged for the underlying items.

For example, this fragment reads within a project, then keeps its todo tasks:

```ts
const todoTasks = await tasks.query({projectId: 'project-1'})
    .where('status').eq('todo')
    .toPromise();
```

Use the [shared task setup](../getting-started/task-setup.md). If you repeatedly retrieve a small subset of a large group, consider whether an index key should model that access pattern.

## A page limit is not a guaranteed number of matches

DynamoDB's page limit counts evaluated items before filtering. A page can return no matches and still have more work available through its cursor.

A null cursor means no further pages. An empty `items` array alone does not.

The library's all-page `toPromise()` follows continuation automatically. `page()` returns one resumable page. `limit(chunkSize, hardLimit)` separates per-request evaluated work from the maximum returned results across requests.

Try the [empty-page recipe](../guides/recipes.md#continue-through-an-empty-page), then read [pagination contracts](../guides/pagination.md).

## Counts also require read work

Counting matches is not a free table-size lookup. Filters still apply after evaluation, and a full matching count can require multiple pages.

See AWS's [query filter documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.FilterExpression.html) and the library's [projection/count guide](../guides/projections.md).
