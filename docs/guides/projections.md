# Select fields, document paths, and counts

Return the fields your application needs. Projection changes the returned shape; it is not a general way to reduce read capacity.

**Examples on this page are independent fragments, not a script to concatenate.** Start with the [shared task setup](../getting-started/task-setup.md). It defines `tasks`, `tasksTable`, `taskSchema`, `dynamoDB`, `key`, `newTask`, `newTasks`, and `taskKeys`. Other table names and callbacks are explained where introduced; supply application-specific data where indicated.



## Select fields

`select()` requests only named attributes and narrows the inferred result type:

```ts
const summaries = await tasks
    .query({projectId: 'project-1'})
    .select('taskId', 'title', 'status')
    .toPromise();

// Inferred as Array<Pick<Task, 'taskId' | 'title' | 'status'>>.
```

Projected records are validated with a projection schema. At least one field is required, and duplicate fields are removed.

## Document paths and references

These examples use the `dynamoDB` client from the quick start and assume a `records` table already exists with `id` as its string partition key.

```ts
const records = defineTable({
    name: 'records',
    key: {partition: 'id'},
    schema: z.object({
        id: z.string(), used: z.number(), quota: z.number(),
        profile: z.object({
            address: z.object({city: z.string(), country: z.string().default('GB')}),
            nickname: z.string().optional()
        }),
        labels: z.array(z.string())
    })
}).using(dynamoDB);

const recordKey = {id: 'record-1'};
await records.create({
    ...recordKey,
    used: 2,
    quota: 5,
    profile: {address: {city: 'London', country: 'GB'}},
    labels: ['review', 'urgent', 'draft']
}).toPromise();

const city = records.path('profile', 'address', 'city');
const secondLabel = records.path('labels', 1);
const nickname = records.path('profile', 'nickname');
const summary = await records.get(recordKey).consistent()
    .select('id', city, secondLabel, nickname).toPromise();
```

`summary` is:

```json
{
    "id": "record-1",
    "profile": {"address": {"city": "London"}},
    "labels": ["urgent"]
}
```

The original `labels[1]` becomes the only element of the returned list, at position `0`. The absent `nickname` is omitted. The unselected `country` is also omitted, even though its schema has a default; projection parsing does not fill it in.

Reuse the same paths in batch reads, filters, and conditional updates:

```ts
const summaries = await records.getBatch([recordKey], {
    consistentRead: true,
    select: ['id', city, secondLabel, nickname]
});

const withinQuota = await records.scan()
    .where(city).eq('London')
    .where('used').lte(records.ref('quota'))
    .toPromise();

const updated = await records.update(recordKey)
    .set(city).eq('Manchester')
    .remove(secondLabel)
    .where('used').lt(records.ref('quota'))
    .toPromiseOrNull();
```

For the seeded record, `summaries` is `[summary]`, and the filter includes the record because its stored `used` value is 2 and `quota` is 5. The conditional update returns:

```json
{
    "id": "record-1",
    "used": 2,
    "quota": 5,
    "profile": {"address": {"city": "Manchester", "country": "GB"}},
    "labels": ["review", "draft"]
}
```

The update preserves unmodified fields and removes the element at the original list position `1`. If the stored `used` value is no longer below `quota`, it returns `null` without applying either change.

Both table definitions and bound tables expose schema-aware `path()` and `ref()` helpers. The low-level equivalents are named exports: `import {path, ref} from '@fluentful/orm'`. Descriptors and their segments are immutable. String segments identify map fields, numeric segments identify non-negative integer list positions, and paths allow at most 32 dereferences. Ordinary strings remain literal attribute names: `'profile.address.city'` is one field, not a nested path.

For example, these low-level filters address different attributes:

```ts
import {path, QueryBuilder} from '@fluentful/orm';

const literalMatches = await new QueryBuilder('records', dynamoDB).scan()
    .where('profile.address.city').eq('Manchester').toPromise();
const nestedMatches = await new QueryBuilder('records', dynamoDB).scan()
    .where(path('profile', 'address', 'city')).eq('Manchester').toPromise();
```

For the seeded record after the update, only the nested filter matches: the record has no literal top-level attribute named `profile.address.city`.

Paths work in filters, conditions, projections (including `getBatch(..., {select: [...]})`), SET, and REMOVE. ADD and DELETE remain top-level only. Invalid segments, primary-key mutations, and overlapping parent/child updates or projections fail before sending. Nested SET requires existing parent containers and does not create missing maps. Multiple list updates/removals address original list positions. See [AWS update expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.UpdateExpressions.html).

Projected maps retain their nested shape. Selected list elements form compacted lists, in original list order, without holes or objects keyed by original indices. Missing selections are omitted, including parent containers with no selected descendants. Nested projection types use partial fields and arrays; parsing validates only returned branches and does not materialize absent fields from defaults. Whole top-level string selections retain the existing `Pick` result types.

References are explicit stored-field operands for EQ/NE, ordered comparisons, BETWEEN bounds, and IN candidates. They are resolved against the consuming table/index schema, never serialized as supplied values. In comparisons, the left path must differ from any referenced right operand. Ordinary strings and objects remain literal values. `ref('pricing', 'regular')` addresses a nested field, while `ref('pricing.regular')` addresses one literal name. Predicate-function arguments do not accept references; structured SET assignments use the separate `assign()` API described above.

## Count matches

```ts
const openCount = await tasks
    .query({projectId: 'project-1'})
    .where('status').ne('done')
    .count()
    .toPromise();
```

Counts continue across all DynamoDB pages and include only records that pass filters. `select()` and `count()` cannot be combined on one operation.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
