# Update a record

Change only the fields you need. An update can create a missing item, so add an existence condition when that would be unsafe.

**Examples on this page are independent fragments, not a script to concatenate.** Start with the [shared task setup](../getting-started/task-setup.md). It defines `tasks`, `tasksTable`, `taskSchema`, `dynamoDB`, `key`, `newTask`, `newTasks`, and `taskKeys`. Other table names and callbacks are explained where introduced; supply application-specific data where indicated.



Updates return the complete new record by default, or `null` if DynamoDB returns no attributes.

## Set several fields

```ts
const updated = await tasks.update(key).with({
    status: 'doing',
    title: 'Write and review the guide'
}).toPromise();
```

## Fluent update actions

Actions can be chained into one atomic item update:

```ts
const updated = await tasks.update(key)
    .set('status').eq('doing')
    .set('priority').eq(20)
    .remove('notes')
    .add('tags').eq(new Set(['documentation']))
    .delete('tags').eq(new Set(['draft']))
    .toPromise();
```

The actions map directly to DynamoDB update expression groups:

| Method | Purpose |
| --- | --- |
| `.with({...})` | `SET` every defined, non-key property in a partial document |
| `.set(field).eq(value)` | Set or replace a value |
| `.remove(field)` | Remove an attribute |
| `.add(field).eq(number)` | Increment or decrement a number |
| `.add(field).eq(set)` | Add members to a DynamoDB set |
| `.delete(field).eq(set)` | Remove members from a DynamoDB set |

When the same attribute receives several update actions, the last action wins.

## Prevent accidental upserts

DynamoDB `UpdateItem` creates an item when its key does not exist. Add an existence condition when the operation must only affect an existing item:

```ts
await tasks.update(key)
    .add('priority').eq(-1)
    .where('projectId').exists()
    .toPromise();
```

## Skip returned attributes

Use `.returningNone()` when the updated record is not needed. The inferred result is `Promise<void>` and DynamoDB does not return `ALL_NEW` attributes.

```ts
await tasks.update(key)
    .set('status').eq('done')
    .where('projectId').exists()
    .returningNone()
    .toPromise();
```

Updates support `returningAllNew()`, which is the default, or `returningNone()`. `returningAllNew()` returns the complete item after a successful update, including when an assigned value is unchanged.

## Structured SET assignments

Use `assign()` for stored-field copies and update functions; `.with()` and `.set().eq()` remain literal APIs.

```ts
import {defineTable, ifNotExists, listAppend, plus} from '@fluentful/orm';

const counters = defineTable({
    name: 'counters', key: {partition: 'id'},
    schema: z.object({id: z.string(), count: z.number(), previous: z.number(), labels: z.array(z.string())})
}).using(dynamoDB);

await counters.update({id: 'one'})
    .assign('previous', fields => fields.ref('count'))
    .assign('count', fields => plus(ifNotExists(fields.ref('count'), 0), 1))
    .assign('labels', fields => listAppend(ifNotExists(fields.ref('labels'), []), ['new']))
    .toPromise();
```

`literal(value)`, `ifNotExists(reference, fallback)`, `listAppend(left, right)`, `plus(left, right)`, and `minus(left, right)` produce isolated operand descriptors. Right-hand references read the pre-update record, even when that source field is updated in the same request. Arithmetic is one binary `+` or `-`, not arbitrary or nested arithmetic. Missing references, invalid operand types, and missing parent containers fail. `ifNotExists` distinguishes absent attributes from stored `null`.

The typed callback validates reference schema shapes and supplied literals. Numeric deltas and appended elements are validated without imposing whole-field minimums on fragments. Stored values and refinements cannot be fully checked before reading them; output-schema parsing can still fail after a successful write. Low-level `ref()` has an unknown value type; annotate `AttributeReference<number>` or `AttributeReference<string[]>` when using typed numeric/list helpers without a table schema. Primary keys and overlapping paths remain protected. The last action for an identical path wins, and explicit `modifiedAt` actions take precedence over automatic timestamps.

## Sparse update images

`returningUpdatedNew()` requests only changed-attribute fragments after an update; `returningUpdatedOld()` requests their previous values. Typed results use `PartialProjection<T> | null`, preserving scalar, binary and set leaves while making nested records partial and list fragments compact. Missing attributes are omitted, schema defaults are not inserted, and an absent image returns `null`. These modes follow update actions, not a deep diff: assigning an unchanged value can still return that attribute. Successful transaction writes do not return per-item images. Conditional-failure `returningAllOld()` remains independent and parses the full previous record.

List removals shift positions before `UPDATED_NEW` projects the affected paths. For example, setting `items[2]` and removing `items[0]` from a three-element list returns the final value at `items[0]`, not the assigned value now at `items[1]`. Removing a list element can therefore return the value shifted into its position; removing the last element produces no fragment for that path.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
