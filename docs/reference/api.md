# API at a glance

This is a navigation-oriented summary, not a complete list of every overload. Detailed contracts are linked below. Signature sketches containing optional-property notation are not runnable TypeScript.

## Detailed contracts

- [Typed tables, keys, indexes, and input/output schemas](./typed-tables.md).
- [Execution, pagination terminals, caching, and cancellation](./execution.md).
- [Successful return modes and conditional results](./return-modes.md).
- [Comparison semantics and key restrictions](./comparisons.md).
- [Values and serialization](./values.md).
- [Lower-level QueryBuilder](./query-builder.md).
- [Table administration](./table-admin.md).
- [Errors and operational rules](./errors.md).

## Batches and transactions

| Operation | Result |
| --- | --- |
| `getBatchResult(keys, options?)` | Recoverable read outcome |
| `createBatchResult(documents, options?)` | Recoverable write outcome |
| `deleteBatchResult(keys, options?)` | Recoverable write outcome |
| `typedTransaction(client)...toPromise()` | Atomic write completion |
| `typedReadTransaction(client)...toPromise()` | Ordered tuple of nullable records |

See [batch contracts](../guides/batches.md) and [transactions](../guides/transactions.md).

## Typed table definition

```ts
defineTable({
    name,
    schema,
    outputSchema?: storedOutputObjectSchema,
    key: {partition, sort?},
    indexes?: {name: {kind: 'global' | 'local', partition, sort?, projection?}},
    timestamps?: boolean
})
```

## Typed operations

| Operation | Result |
| --- | --- |
| `create(document).toPromise()` | created record |
| `get(key).toPromise()` | record or `null` |
| `update(key)...toPromise()` | new record or `null` |
| `update(key)...returningNone().toPromise()` | `void` |
| `delete(key).toPromise()` | old record or `null` |
| `delete(key).returningNone().toPromise()` | `void` |
| `query(partitionKey).toPromise()` | records |
| `index(name).query(partitionKey).toPromise()` | projection-aware records |
| `index(name).scan().toPromise()` | projection-aware records |
| `scan().toPromise()` | records |
| `createBatch(documents, options?)` | created records |
| `getBatch(keys, options?)` | records |
| `deleteBatch(keys, options?)` | `void` |

## Read modifiers

| Modifier | Purpose |
| --- | --- |
| `sortKey().eq/gt/gte/lt/lte(value)` | compare a declared sort key |
| `sortKey().between(lower, upper)` | inclusive sort-key range |
| `sortKey().beginsWith(prefix)` | string or binary sort-key prefix |
| `where(field)...` | add a filter |
| `whereAny(callback)` / `whereAll(callback)` / `whereNot(callback)` | add a scoped predicate group |
| `path(...segments)` / `ref(...segments)` | select a document path / stored operand |
| `select(...fields)` | project and type selected fields |
| `count().toPromise()` | count matches across pages |
| `limit(chunkSize, hardLimit?)` | configure all-page reads |
| `consistent()` | request a strongly consistent table or local-index read |
| `ascending()` / `descending()` | choose query sort-key order |
| `returnCapacity(mode?)` | include consumed capacity in `toResponse()` |
| `parallel(segment, totalSegments)` | configure one segment of a parallel scan |
| `page({limit?, cursor?})` | fetch one page |
| `pages({limit?, cursor?})` | lazily iterate pages |
| `items({limit?, cursor?})` | lazily iterate records |

## Update modifiers

| Modifier | Purpose |
| --- | --- |
| `with(partial)` | set several fields |
| `set(field).eq(value)` | set one field |
| `remove(field)` | remove one field |
| `add(field).eq(value)` | add a number or set members |
| `delete(field).eq(set)` | delete set members |
| `where(field)...` | add a write condition |
| `returningAllNew()` / `returningNone()` | choose update return data |

## Condition and filter comparisons

| Comparison | DynamoDB meaning |
| --- | --- |
| `eq(value)` | equal |
| `ne(value)` | not equal |
| `gt(value)` / `gte(value)` | greater than / greater than or equal |
| `lt(value)` / `lte(value)` | less than / less than or equal |
| `contains(value)` | string substring or collection member |
| `in(values)` | equal to any supplied value |
| `not()` | negate the following comparison |
| `exists()` / `not().exists()` | attribute exists / does not exist; conditions and supported read filters |

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
