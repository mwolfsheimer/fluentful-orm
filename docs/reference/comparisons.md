# Comparison and access rules

Use this technical reference after reading [queries and filters](../concepts/queries-and-filters.md). It describes exact matching and key restrictions.

- `.eq(['val'])` matches the entire list, not membership. Lists compare positionally, including length and duplicates; maps ignore property insertion order; DynamoDB sets ignore member order. Equality is type-sensitive (for example, a number is not its string representation, and a set is not a list). Missing attributes are distinct from stored `null`.
- `.contains(value)` tests a substring or one list/set member. `.in(values)` compares the complete attribute against 1-100 candidates, including serializable complex values. Negation follows DynamoDB expression semantics; `.ne(value)` matches a missing attribute, including when the operand is `null`. `.eq(null)` only matches a stored null, not an absent attribute. For conditional writes that require a present value that differs, also add `.where(field).exists()`.
- Attribute strings, including names containing dots, spaces or hyphens, are literal top-level names. Safe aliases are allocated for conditions, updates, query keys and projections (including batch reads); these strings do not select nested paths.
- Queries require partition-key equality. Scalar sort keys accept at most one sort-key predicate; multi-attribute GSI sort keys use an ordered contiguous prefix as described in the [query guide](../guides/queries.md#multi-attribute-gsis). Key operands must be non-empty strings/binaries or finite DynamoDB-range numbers; key byte limits are enforced. Sort-key `BETWEEN` requires matching types and ordered bounds, and `beginsWith` requires string/binary operands. Typed query filters reject the active table/index keys; use key conditions instead. Base-table keys may be filtered when they are not keys of the selected index.
- Present secondary-index keys must match their declared scalar types and cannot be null or empty; missing components keep an item out of a sparse index. Typed writes validate present key operands using their definitions before sending; memory validates the resulting items for puts, updates, batches and transactions before mutation. Index cursors contain both table and index keys. Ordering between items with equal index sort keys is unspecified.
- Parallel scan `totalSegments` is an integer from 1 to 1,000,000, with `0 <= segment < totalSegments`. `usingIndex()` supports queries and scans and rejects unsupported operations instead of silently ignoring the selection. The typed equivalent is `index(name).query(...)` or `index(name).scan()`.
- Scan result order is not guaranteed by DynamoDB; the memory backend's deterministic key order is not a portable ordering contract.

The shared contract covers complex `IN`, missing-versus-null comparisons, nested paths and projections, scoped AND/OR/NOT groups, condition/filter functions, stored-field references, conditional writes and transactions, and secondary-index scans. Run `npm run test:integration` with AWS credentials to verify these cases against live DynamoDB; passing the offline suite alone does not establish AWS parity.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
