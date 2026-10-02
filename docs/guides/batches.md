# Process batches and recover partial work

Batches reduce request overhead, but are not atomic. Start with [batches versus transactions](../concepts/reliability.md#batches-versus-transactions).

**Examples on this page are independent fragments, not a script to concatenate.** Start with the [shared task setup](../getting-started/task-setup.md). It defines `tasks`, `tasksTable`, `taskSchema`, `dynamoDB`, `key`, `newTask`, `newTasks`, and `taskKeys`. Other table names and callbacks are explained where introduced; supply application-specific data where indicated.



DynamoDB limits batch writes to 25 items and batch gets to 100 keys. QueryBuilder chunks larger arrays, retries unprocessed items with jitter, and runs up to four chunks concurrently by default.

```ts
const created = await tasks.createBatch(newTasks);
const loaded = await tasks.getBatch(taskKeys);
await tasks.deleteBatch(taskKeys);
```

Set bounded concurrency explicitly when needed:

```ts
await tasks.createBatch(newTasks, {concurrency: 2});
await tasks.getBatch(taskKeys, {concurrency: 2, consistentRead: true});
await tasks.deleteBatch(taskKeys, {concurrency: 2});
```

`getBatch()` accepts `consistentRead` in its options object and removes duplicate keys before sending requests. DynamoDB does not guarantee that batch-get results have the same order as the input keys.

Empty input arrays complete without sending a DynamoDB request: creates and gets return `[]`, while deletes return `void`. Unprocessed reads and writes are retried up to eight times with jittered backoff; the operation rejects if DynamoDB still returns unprocessed items after the final retry. When one concurrent chunk fails, no new chunks are scheduled, but already-running chunks are allowed to settle before the batch rejects.

Retry exhaustion throws exported `BatchRetryError`. Its `operation`, raw SDK `unprocessedItems` map, and decoded `partialResults` describe the failing chunk only, not other concurrent chunks. For reads, the map contains `KeysAndAttributes`; for writes it contains write requests. Retry only unprocessed work, not the entire original write batch. Ordinary SDK failures preserve their original error identity and may leave an ambiguous partial outcome. Create batches validate all documents before scheduling chunks; service failures still make batches non-atomic. Binary-key deduplication compares bytes regardless of `Buffer`/`Uint8Array` representation. Duplicate write targets within one request are rejected by both AWS and memory.

For legacy callers, a boolean second argument remains supported: `true` means serial chunks and `false` means unbounded concurrency. New code should use `{concurrency}`.

Batch operations are not atomic and do not support per-item conditions. Use a transaction when all writes must succeed or fail together.

## Recoverable batch outcomes

`getBatchResult()`, `createBatchResult()`, and `deleteBatchResult()` are additive alternatives to the legacy batch methods. They settle active chunks and return a `BatchOutcome` with `completed`, `unprocessed`, `notSubmitted`, and `unknown` work. Each entry retains its original input index and an isolated input value. Missing read records count as completed work; duplicate read inputs retain their individual positions even though requests are deduplicated.

In this fragment, `signal` is an optional application-owned `AbortController().signal`; omit it when cancellation is not needed.

```ts
const outcome = await tasks.createBatchResult(newTasks, {concurrency: 2, signal});
console.log(outcome.errors, outcome.unknown);
// Only these inputs were explicitly unprocessed or never submitted:
const safeToResume = outcome.resumable;
```

`results` retains parsed read results (without promising input ordering) or confirmed prepared create documents. `errors` retains original failure objects, including cancellation reasons. Input validation still rejects before sending; service, parsing and cancellation outcomes are reported after execution starts. `resumable` never includes uncertain writes. It contains API inputs, so resubmission reapplies current validation, transforms and timestamp settings. Do not blindly retry `unknown` work: reconcile it using application keys/idempotency first. Batches remain non-atomic.

## Cancellation

Pass `{signal}` to terminals (`toPromise`, `toResponse`, `toResult`, `toPromiseOrNull`), pages/iterators, batches, transactions, and administrative options. The first execution binds the original signal outside cloned request data; later cached calls may omit it or reuse it, but cannot replace it. Aborts stop scheduling, page/item traversal, and retry delays, and are forwarded to AWS sends. In-flight batch workers settle before an aggregate result is returned. Memory rejects cancelled queued work before execution.

Cancellation is not rollback: a write may have reached DynamoDB before cancellation or a network failure. Waiter cancellation also does not undo table creation or deletion. Pre-aborted signals avoid sending: ordinary terminals reject, while recoverable batches report the reason and never-submitted inputs. Cached failures retain their original identity.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
