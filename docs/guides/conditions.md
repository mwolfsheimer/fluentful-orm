# Write only when a condition holds

Protect a change using the record's current state. Begin with the [conditional-write recipe](./recipes.md#complete-a-task-only-if-it-is-in-progress).

**These examples are independent fragments.** Use the [shared task setup](../getting-started/task-setup.md) for `tasks` and `key`; do not concatenate the fragments into one operation.

Conditions are available on `create`, `update`, `delete`, and `conditionCheck`. Multiple `.where()` calls are combined with `AND`.

```ts
await tasks.update(key)
    .set('status').eq('done')
    .where('status').eq('doing')
    .where('priority').gte(5)
    .toPromise();
```

Supported comparisons are:

```ts
.where('priority').eq(10)
.where('priority').ne(10)
.where('priority').gt(10)
.where('priority').gte(10)
.where('priority').lt(10)
.where('priority').lte(10)
.where('title').contains('guide')
.where('status').in(['todo', 'doing'])
.where('notes').exists()
.where('notes').not().exists()
.where('status').not().eq('done')
.where('title').beginsWith('Draft')
.where('priority').between(3, 10)
.where('tags').attributeType('SS')
.where('tags').size().gte(2)
```

`.in([])` is invalid; `IN` accepts at most 100 candidates. The same helpers work in read filters and write conditions. The typed API validates supplied comparison values against the selected field. For a set or array field, `.contains(value)` validates the member type rather than the collection type. String/binary prefixes validate partial operands rather than requiring a complete stored value.

`attributeType()` accepts the separate `ExpressionAttributeType` union: `S`, `N`, `B`, `BOOL`, `NULL`, `M`, `L`, `SS`, `NS`, `BS`. Table/key definitions still accept only `S`, `N`, and `B`. `size()` exposes numeric comparisons, `between()`, `in()`, and `not()`. Thresholds are finite numbers, including negative and fractional numbers. Size uses UTF-16 code units for strings, bytes for binary, and member counts for lists, maps, and sets; missing or unsupported stored operand types do not match positive size comparisons.

## Scoped groups

```ts
const matches = await tasks.scan()
    .whereAny(group => group
        .where('status').eq('doing')
        .whereAll(all => all
            .where('priority').gte(3)
            .where('title').beginsWith('Draft')))
    .whereNot(group => group.where('status').eq('done'))
    .toPromise();
```

The filter is equivalent to:

```text
(status = 'doing' OR (priority >= 3 AND begins_with(title, 'Draft')))
AND NOT (status = 'done')
```

`whereAny`, `whereAll`, and `whereNot` create explicit parenthesized OR, AND, and NOT groups. A NOT group negates the conjunction of its predicates. These callbacks expose predicates only, including nested groups, and also work on conditional writes and transaction conditions. Empty, incomplete, asynchronous, and throwing callbacks fail without committing any of their predicates. Keep callbacks synchronous and do not retain their scoped builders after they return. Repeated ordinary `.where()` calls remain AND.

Use a group to allow alternative states in a conditional write:

```ts
const completed = await tasks.update(key)
    .set('status').eq('done')
    .where('projectId').exists()
    .whereAny(group => group
        .where('status').eq('doing')
        .whereAll(all => all
            .where('status').eq('todo')
            .where('priority').gte(3)))
    .toPromiseOrNull();
```

This updates an existing task only if its stored status is `doing`, or its stored status is `todo` and priority is at least 3. Conditions inspect the item before the update, not the new `done` value. `completed` is the updated task on success or `null` when the condition fails; other service failures still reject.

See [AWS expression rules](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.OperatorsAndFunctions.html) for function and operator semantics.

Failed conditions reject with the AWS SDK error, normally `ConditionalCheckFailedException`. For an update where a failed condition is an expected not-found or no-op outcome, use `.toPromiseOrNull()` to return `null` for that error while continuing to propagate other DynamoDB failures:

```ts
const updated = await tasks.update(key)
    .set('status').eq('done')
    .where('projectId').exists()
    .toPromiseOrNull();
```

## Choose how to handle a condition that does not match

- `toPromise()` rejects with the SDK conditional error.
- `toPromiseOrNull()` on updates returns null for a conditional failure, while propagating other errors.
- `toResult()` on single writes returns an `applied` result; request a previous record separately if you need it.

See [write return modes](../reference/return-modes.md) for the exact typed/untyped payload contracts. A null previous image does not by itself prove the record was missing.

## Standalone condition checks

`conditionCheck()` is primarily useful inside transactions:

```ts
typedTransaction(dynamoDB)
    .add(tasksTable, (tasks) => tasks
        .conditionCheck(key)
        .where('status').eq('doing'))
    // Add writes that depend on the checked state.
    .toPromise();
```

A condition check must contain at least one condition.

[Documentation home](../index.md)
