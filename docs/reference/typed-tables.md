# Define and validate typed tables

Declare a table once, then bind it to a client. This defines application validation, not the storage table. Examples are fragments using the [shared task setup](../getting-started/task-setup.md).

Call `defineTable()` once and reuse the resulting definition. Call `.using(client)` where an operation needs to be performed. The typed factory is also available as `QueryBuilder.defineTable()`.

```ts
const tasksTable = defineTable({
    name: 'tasks',
    schema: taskSchema,
    key: {partition: 'projectId', sort: 'taskId'},
    indexes: {
        'status-index': {kind: 'global', partition: 'status', sort: 'priority'}
    },
    timestamps: true
});

const tasks = tasksTable.using(dynamoDB);
```

## Keys

A key definition has a required partition field and an optional sort field:

```ts
key: {partition: 'id'}
key: {partition: 'accountId', sort: 'createdAt'}
```

Key fields must be required schema fields whose output type is `string`, `number`, or `Uint8Array`. Exact operations such as `get`, `update`, and `delete` require the complete key and no extra properties. A `query` accepts only the partition key because sort-key restrictions are added through `.sortKey()`. Local indexes require a composite table key, the table's partition key, and an index sort key.

Indexes use the same key shape, plus a required `kind: 'global'` or `kind: 'local'`. Their names and key fields are inferred:

```ts
indexes: {
    'status-index': {kind: 'global', partition: 'status', sort: 'priority'},
    'owner-index': {kind: 'global', partition: 'ownerId'}
}
```

## Zod input and output types

`create()` and `createBatch()` accept the schema input type and store its parsed output. Schemas with transforms must provide an `outputSchema` for writes. This object schema validates stored values on reads, projections, and returned writes without running input transforms again; it must not itself contain transforms. Read-only definitions may still use a transforming `schema` without an `outputSchema`.

```ts
const measurements = defineTable({
    name: 'measurements',
    key: {partition: 'id'},
    schema: z.object({id: z.string(), value: z.string().transform(Number)}),
    outputSchema: z.object({id: z.string(), value: z.number()})
}).using(dynamoDB);
await measurements.create({id: 'one', value: '3'}).toPromise();
// Reads return {id: 'one', value: 3}, not a second transformation.
```

Partial `.with()` updates parse only supplied, defined fields; omitted defaults do not overwrite existing attributes. Numeric `ADD` validates a delta, and set `ADD`/`DELETE` validate member subsets, independently of whole-field bounds. Use conditions to protect stored invariants; returned records are still schema-validated. `create().returningAllOld()` returns a nullable record because a first insertion has no old item.

Use a strict object schema when records should not contain undeclared fields. If `timestamps: true` is enabled, declare optional numeric `createdAt` and `modifiedAt` fields in a strict schema as shown above.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
