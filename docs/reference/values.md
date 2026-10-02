# Values and serialization

The library converts JavaScript values to DynamoDB attributes. You normally do not need to assemble AttributeValue maps yourself.

The serializer maps JavaScript values to DynamoDB `AttributeValue` shapes:

| JavaScript value | DynamoDB value | Deserialized value |
| --- | --- | --- |
| string, finite number, boolean, or `null` | `S`, `N`, `BOOL`, or `NULL` | the same scalar value |
| `Uint8Array` | `B` | a binary value, usually a `Uint8Array` from AWS |
| array | `L` | an array, preserving order and duplicates |
| plain object | `M` | a plain object |
| non-empty `Set<string>` | `SS` | `Set<string>` |
| non-empty `Set<number>` | `NS` | `Set<number>` |
| non-empty `Set<Uint8Array>` | `BS` | a set of binary values |

Node `Buffer` inputs are also accepted as binary values, including binary sets. Prefer `Uint8Array` in shared/browser code and public types; the package does not require the Node Buffer global for normal operations.

Maps in this table mean DynamoDB maps represented by plain JavaScript objects, for example `{owner: {id: 'account-1'}}`. They are not ECMAScript `Map` instances; convert a `Map` with `Object.fromEntries()` before writing it. Arrays are DynamoDB lists, so they may be empty and may contain different serializable value types. A Set is unordered and cannot be empty. Mixed-type, boolean, or object Sets are serialized as lists and deserialize as arrays, so use a homogeneous DynamoDB-compatible Set when set behaviour matters.

For typed tables, express complex fields in the Zod schema, for example `z.array(z.string())`, `z.set(z.string())`, `z.object({owner: z.string()})`, and `z.instanceof(Uint8Array)`. Complete arrays and sets are validated on writes and reads. A typed `.contains(value)` comparison validates `value` against the element schema for both array and Set fields, rather than expecting the whole collection. Collection size constraints do not restrict membership operands. Optional, nullable, default, readonly, catch, prefault, nonoptional and pipe wrappers are unwrapped for partial operands; union branches validate their respective operand schemas. Element validation/transforms remain active, but whole-field transforms and container refinements are not applied to partial operands. String substrings and sort-key prefixes validate their scalar type without requiring a complete value that satisfies the stored field's length/pattern constraints. Equality still validates the complete field schema:

This independent fragment uses a different schema from the task tutorial. Import `z` from `zod` and `defineTable` from `@fluentful/orm`, bind a configured `dynamoDB` client, and provision a table with a string `id` key before running it.

```ts
const taskSchema = z.object({
    id: z.string(),
    labels: z.array(z.string()),
    tags: z.set(z.string()),
    metadata: z.object({owner: z.string()}),
    payload: z.instanceof(Uint8Array)
});

const tasks = defineTable({
    name: 'tasks',
    schema: taskSchema,
    key: {partition: 'id'}
}).using(dynamoDB);

await tasks.scan()
    .where('labels').contains('urgent')
    .where('tags').contains('review')
    .toPromise();
```

Numbers must be finite and within DynamoDB's magnitude range: zero, or absolute value at least `1e-130` and below `1e126`. Decoding rejects numeric strings that do not round-trip through JavaScript's decimal number representation, rather than silently changing precise values or collapsing number-set members. This is not arbitrary-precision arithmetic: memory numeric updates still use JavaScript arithmetic. Store application values requiring more precision as strings, or use the raw AWS SDK with an appropriate number representation.

`undefined` object properties are omitted from creates and `.with()` updates, but an `undefined` array member is invalid. Non-finite/out-of-range numbers, symbols, functions, empty Sets, cycles, nesting beyond 32 levels, and unsupported object instances such as `Date` or `Map` are rejected. Convert these explicitly before writing. Only own enumerable document attributes are encoded, including literal `__proto__`, `constructor`, and `hasOwnProperty` names. Binary sets deduplicate equal bytes. Malformed known AttributeValue descriptors are rejected; unknown descriptor tags retain the existing `undefined` result.

Avoid relying on `undefined` to remove an existing attribute during an update. Use `.remove(field)`.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
