# Write return modes and conditional results

Choose successful write data and conditional-failure data independently. For a first example, use the [typed conditional recipe](../guides/recipes.md#complete-a-task-only-if-it-is-in-progress).

## Successful write modes

| Mode | Supported writes | Result |
| --- | --- | --- |
| Default | create / update / delete | Submitted create record / complete new update record / deleted record, with nullable service images where applicable |
| `returningNone()` | update / delete | No successful payload (`void`) |
| `returningAllNew()` | update | Complete new record, or null if no image |
| `returningAllOld()` | create / update / delete | Previous record, or null if absent |
| `returningUpdatedNew()` / `returningUpdatedOld()` | update | Changed-attribute fragment (`PartialProjection<T> \| null` on typed chains) |

Sparse images are not complete schema records. See [sparse update images](../guides/updates.md#sparse-update-images). Suppressing successful attributes does not suppress a conditional error.

## Reading the following examples

The code blocks below are independent reference fragments. `dynamoDB` means a configured client as in [AWS setup](../getting-started/aws.md). The `cache` examples require a separately created table with a string `key` partition key and seeded counter fields; they are not part of the task fixture. Import `QueryBuilder`, `QuerySerializer`, and `defineTable` from `@fluentful/orm`, `z` from `zod`, and `ConditionalCheckFailedException` from the AWS SDK where used.

## Conditional failure payloads

For single-item writes through `QueryBuilder`, call `onConditionFailure().returningAllOld()` after the write actions and conditions, before `toPromise()`, to receive the existing item when a condition fails:

```ts
try {
    await new QueryBuilder('cache', dynamoDB)
        .update({key: 'counter'})
        .add('count').eq(1)
        .where('count').lt(10)
        .onConditionFailure().returningAllOld()
        .toPromise();
} catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
    }
    const previous = error.Item === undefined ? null : QuerySerializer.parseItem(error.Item);
}
```

Import `ConditionalCheckFailedException` from `@aws-sdk/client-dynamodb` and `QuerySerializer` from `@fluentful/orm`. The methods support create, update, delete, and condition-check operations; reads and batches reject them. `onConditionFailure().returningNone()` explicitly disables the failure payload. The SDK exception is preserved, and its `Item` contains raw DynamoDB attributes, not a schema-validated document; no item is returned when the key is missing. Successful write results are unchanged. Use `toPromise()` rather than `toPromiseOrNull()` when the failure snapshot is needed. Transaction item options override the builder setting when supplied; transaction failures still use cancellation reasons rather than `ConditionalCheckFailedException.Item`.

`onConditionFailure()` exposes only `returningAllOld()` and `returningNone()`. Choosing either option returns the original write chain. Success and failure return options are independent, so `.returningNone().onConditionFailure().returningAllOld().toPromise()` suppresses the success payload while retaining the old item on conditional failure. This configures the error payload; it does not catch or suppress the failure.

## Independent and combined return options

These examples use the untyped `QueryBuilder` API. Each operation can succeed or reject depending on its condition; handle conditional failures as shown above.

**Success only:** suppress the successful update payload. Conditional failures still reject without an old-item payload because no failure-return option was selected.

```ts
await new QueryBuilder('cache', dynamoDB)
    .update({key: 'counter'})
    .add('count').eq(1)
    .where('count').lt(10)
    .returningNone()
    .toPromise();
```

**Failure only:** include the previous item on conditional failure. Successful updates still return the complete updated item through the default `returningAllNew()` behaviour.

```ts
const updated = await new QueryBuilder('cache', dynamoDB)
    .update({key: 'counter'})
    .add('count').eq(1)
    .where('count').lt(10)
    .onConditionFailure().returningAllOld()
    .toPromise<{key: string; count: number}>();
```

**Together:** suppress the success payload while including the previous item on conditional failure.

```ts
await new QueryBuilder('cache', dynamoDB)
    .update({key: 'counter'})
    .add('count').eq(1)
    .where('count').lt(10)
    .returningNone()
    .onConditionFailure().returningAllOld()
    .toPromise();
```

The reverse order, `.onConditionFailure().returningAllOld().returningNone()`, has the same effect: the first return option configures the failure payload and returns the write chain, so the second configures the success payload.

| Write-chain success option | Failure option | Successful update | Successful delete | Conditional failure |
| --- | --- | --- | --- | --- |
| Omitted | Omitted | Updated item | Deleted item | Rejects without `Item` |
| `returningNone()` | Omitted | `undefined` | `undefined` | Rejects without `Item` |
| Omitted | `onConditionFailure().returningAllOld()` | Updated item | Deleted item | Rejects with old `Item` when present |
| `returningNone()` | `onConditionFailure().returningAllOld()` | `undefined` | `undefined` | Rejects with old `Item` when present |
| Omitted | `onConditionFailure().returningNone()` | Updated item | Deleted item | Rejects without `Item` |
| `returningNone()` | `onConditionFailure().returningNone()` | `undefined` | `undefined` | Rejects without `Item` |

For successful updates, `returningAllNew()` explicitly selects the default full payload; for successful deletes, use `returningAllOld()`. `create()` also supports `returningAllOld()` to return the item it overwrote. These success methods remain independent of either failure option. A successful delete without an existing item returns `null` by default. Condition-check chains support only failure-return options. The failure configuration does not offer `returningAllNew()`: no updated item exists when a condition rejects the write.

`onConditionFailure()` alone is a configuration step, not an executable write chain. Select `returningAllOld()` or `returningNone()` to resume the chain. `toPromiseOrNull()` on an update still discards a conditional failure's payload and resolves to `null`, even when old-item return is enabled; use `toPromise()` and catch the SDK error when the snapshot is needed.

The shared contract tests cover updates and deletes with defaults, success-only options, failure-only options, combined options, and both configuration orders. They assert successful return values, conditional failure payloads, and persisted records. Run `npm run test:memory` offline or `npm run test:integration` against the configured real DynamoDB test backend.

## Conditional write results

Use `toResult<T, TPrevious = T>()` on untyped `QueryBuilder` create, update, or delete chains when a failed condition is an expected outcome that should not require `try/catch`. It returns the exported `ConditionalWriteResult` union:

```ts
type ConditionalWriteResult<T, TPrevious = T> =
    | {applied: true; value: T}
    | {applied: false; previous: TPrevious | null};
```

Configure the failure payload separately, using the same two-step API:

```ts
type Counter = {key: string; count: number; resetAt: number; ttl: number};

const result = await new QueryBuilder('cache', dynamoDB)
    .update({key: 'counter'})
    .add('count').eq(1)
    .where('resetAt').gt(Date.now())
    .where('count').lt(10)
    .onConditionFailure().returningAllOld()
    .toResult<Counter>();

if (result.applied) {
    const updated = result.value;
} else {
    const previous = result.previous;
}
```

| Terminal method | Successful write | Conditional failure |
| --- | --- | --- |
| `toPromise<T>()` | Resolves to the existing write value | Rejects with the SDK error |
| `toPromiseOrNull<T>()` (updates only) | Resolves to the existing write value | Resolves to `null`, discarding failure details |
| `toResult<T, TPrevious>()` | Resolves to `{applied: true, value}` | Resolves to `{applied: false, previous}` |

`toResult()` catches only `ConditionalCheckFailedException`. Network errors, access-denied errors, invalid requests, parsing failures, and other errors still reject. It does not make another DynamoDB request or enable old-item returns automatically. `previous: null` means no failure item was returned: the item may be missing, or failure payloads may be disabled. Request `onConditionFailure().returningAllOld()` when that distinction matters, as in a conditional counter update.

The old item is deserialised with `QuerySerializer.parseItem()`. `TPrevious` defaults to `T` but may describe a different legacy shape. This generic is a caller-supplied type, not runtime schema validation; validate untrusted or legacy fields before using them. `ConditionalWriteResult` can be imported from `@fluentful/orm`.

Success values match `toPromise()`: create returns the submitted document, update returns the updated item by default, and delete returns the deleted item or `null` when absent. Payload-free update/delete writes resolve to `{applied: true, value: undefined}`. For example:

```ts
const result = await new QueryBuilder('cache', dynamoDB)
    .update({key: 'counter'})
    .add('count').eq(1)
    .where('count').lt(10)
    .returningNone()
    .onConditionFailure().returningAllOld()
    .toResult<void, Counter>();
```

Repeated `toResult()` calls on the same chain return the cached result promise. Calling `toPromise()` or `toPromiseOrNull()` on that same chain shares the original execution without another write, while retaining each method's success/failure semantics. A new builder is needed to retry a conditional write. Reads, batches, standalone condition checks, and transaction builders do not expose `toResult()`; transaction cancellation reasons are not converted into single-item conditional results. Typed table writes support the inferred, schema-validated variant below.

The shared backend contracts cover create/update/delete results, missing and suppressed failure payloads, and payload-free successes. Unit tests cover deserialisation, result type narrowing, execution caching, terminal-method compatibility, and infrastructure-error propagation. Run `npm test` offline; the shared contracts also run under `npm run test:integration`.

## Typed conditional write results

Typed table create, update, and delete chains support the same two-step failure-return options and `toResult()`, without caller-supplied generics. The table schema determines both the successful record type and the previous-record type:

```ts
const counters = defineTable({
    name: 'cache',
    schema: z.object({
        key: z.string(),
        count: z.number().int().nonnegative(),
        resetAt: z.number().int(),
        ttl: z.number().int()
    }).strict(),
    key: {partition: 'key'}
}).using(dynamoDB);

const result = await counters.update({key: 'counter'})
    .add('count').eq(1)
    .where('resetAt').gt(Date.now())
    .where('count').lt(10)
    .onConditionFailure().returningAllOld()
    .toResult();

if (result.applied) {
    const updated = result.value;
} else {
    const previous = result.previous;
}
```

Successful values retain the existing typed API contracts: create returns the schema record, while update and delete return the schema record or `null`. Failure results contain a schema-validated record or `null` when no old item was returned. Malformed old records reject with `ZodError` rather than being exposed under an incorrect inferred type. Unlike the untyped `toResult<T, TPrevious>()`, the typed method does not allow a generic assertion to bypass validation for a legacy record; use a schema that explicitly supports the stored data or use the untyped API with appropriate validation.

Success and failure return options remain independent and can be ordered either way. After `returningNone()`, the successful result's `value` is inferred as `void`, but `previous` remains the schema record or `null`:

```ts
const result = await counters.update({key: 'counter'})
    .add('count').eq(1)
    .where('count').lt(10)
    .returningNone()
    .onConditionFailure().returningAllOld()
    .toResult();
```

Calling `returningAllNew()` on updates or `returningAllOld()` on deletes restores the full success type. Failure configuration returns the original typed chain, so subsequent conditions and update actions retain field/value validation. `TypedCreateChain` and `TypedWriteFinal` are exported for consumers that need to name these interfaces.

Typed result promises are cached across fluent wrappers for the same underlying write. Previous-item validation runs once for that result, including schemas with transforms. `toPromise()` and `toPromiseOrNull()` share the write execution but keep their original behaviour: conditional errors from `toPromise()` remain raw SDK errors, and `toPromiseOrNull()` discards conditional failure details. Infrastructure errors and schema-validation failures are not converted into conditional results.

Typed condition checks and transaction callbacks may configure `onConditionFailure().returningAllOld()` or `.returningNone()`. Per-item transaction options still override that configuration. Execute transactions through their transaction builder's `toPromise()`; calling `toResult()` inside a typed transaction callback throws before sending a request. Standalone condition checks do not expose `toResult()` because they execute through DynamoDB transactions, which return cancellation reasons rather than single-item condition errors.

Offline `npm test` covers inferred types, void/full success options, schema validation, shared execution, and transaction configuration. The common backend contract also tests real typed conditional writes and is included in `npm run test:integration`.



[Execution contracts](./execution.md) · [Conditional-write guide](../guides/conditions.md)
