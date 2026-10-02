# Reliability and partial outcomes

An operation can fail before submission, after the service applies a write, or while parsing the returned data. Those cases require different recovery decisions.

## Conditions protect the stored state

A conditional update checks the current record as part of the write. This is safer than a separate read followed by an unconditional write, because another caller could change the record between those requests.

Use `toResult()` when a condition not matching is an expected application outcome. Other failures still reject. See [the conditional recipe](../guides/recipes.md#complete-a-task-only-if-it-is-in-progress).

## Batches versus transactions

| Requirement | Choose |
| --- | --- |
| Efficient independent writes/reads, where partial completion is acceptable | Batch |
| All included writes must succeed or fail together | Write transaction |
| Ordered atomic reads of specific records | Read transaction |

Batch writes do not support per-item conditions and are not atomic. The library chunks them into service-sized requests; concurrency does not make those chunks one transaction.

Transactions have their own limits and costs. Do not target the same item twice within one transaction; combine a condition and update in one conditional write.

## Do not retry uncertain writes blindly

Recoverable batch methods distinguish:

- `completed`: confirmed work;
- `unprocessed`: explicitly not processed;
- `notSubmitted`: never sent;
- `unknown`: the outcome cannot be established.

Only known-unprocessed and never-submitted inputs appear in `resumable`. Reconcile unknown writes using application keys and idempotency before retrying. Retrying the entire batch can repeat confirmed or uncertain work.

See [batch outcomes](../guides/batches.md#recoverable-batch-outcomes).

## Cancellation does not undo a write

An abort stops scheduling and traversal and forwards the signal to the client. An in-flight request may already have reached DynamoDB. Cancellation and network failure are not rollback mechanisms.

The first execution binds its signal; cached calls cannot replace it with another signal. Start a fresh operation for a deliberate retry.

## Validation after a write

Typed reads and returned writes are parsed through Zod. A result-validation error does not prove the service rejected the write. Avoid assuming every thrown error means nothing changed.

Memory tests exercise supported semantics, not distributed conflicts, capacity, eventual consistency, or TTL expiry. See [backend limits](../guides/local-storage.md).
