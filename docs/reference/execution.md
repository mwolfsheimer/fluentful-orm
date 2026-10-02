# Execution and result contracts

A table binding is reusable; an operation is configured once and executed once. See the [fluent lifecycle](../concepts/fluent-api.md) for examples.

## Terminal methods

| Method | Result | Important distinction |
| --- | --- | --- |
| `toPromise()` | Operation value | A get can return null; query/scan follows all pages unless limited. |
| `toResponse()` | Value and service metadata | Request capacity/metrics explicitly when needed. |
| `toResult()` | Conditional-write discriminated union | Supported single writes only; non-conditional failures still reject. |
| `toPromiseOrNull()` | Successful update value, or null for conditional failure | Does not hide infrastructure failures. |
| `page(options)` | Items and continuation cursor | One page, potentially empty with a non-null cursor. |
| `pages(options)` | Async iterator of pages | Fetches lazily as iteration advances. |
| `items(options)` | Async iterator of records | Traverses page boundaries for you. |

Result types also depend on operation and return mode. See [API summary](./api.md) and [write return modes](./return-modes.md).

## Caching and snapshots

Execution snapshots request configuration and documents. Repeated calls to the same compatible terminal share cached execution, including failure identity. Compatible single-write terminal views can interpret that one execution differently; they do not resubmit it.

Do not switch an already-started operation between ordinary reads, single-page reads, and iterators. Transaction items are captured when added; a transaction also caches its execution.

## Cancellation

Pass `{signal}` to terminals, page/iterator options, batch options, transactions, or supported table-admin options.

The first execution binds the original signal. Later cached calls can omit it or reuse it, but cannot replace it. Pre-aborted signals avoid sending. Recoverable batches report never-submitted inputs; ordinary terminals reject.

Aborts stop new scheduling and retry delays. Already-running batch workers settle before an aggregate outcome is returned. A service-side write may still have happened; cancellation is not rollback.

See [batch cancellation](../guides/batches.md#cancellation) and [error rules](./errors.md).
