# Errors and execution rules

Distinguish invalid input, an expected conditional failure, and an infrastructure failure. See [troubleshooting](../guides/troubleshooting.md) for symptoms and next steps.

- AWS service and condition errors are propagated to the caller.
- Typed operations can also throw `z.ZodError` before sending or while validating returned data.
- Every fluent operation is mutable and single-use. Build a fresh operation before using `toPromise()`, `page()`, `pages()`, or `items()`.
- Execution snapshots request configuration and submitted documents, including lazy iterators. Later mutations of a retained chain cannot change the in-flight request or its result interpretation. Transactions snapshot items when added.
- Repeated `toPromise()` calls on the same operation return the cached promise and do not send the request twice.
- Do not start one execution mode and then switch to another on the same operation.
- A query requires the exact partition-key document. Exact item operations require the complete primary key.
- Filters are post-read expressions and cannot replace key conditions.
- DynamoDB rejects filter expressions that reference table primary-key attributes in some query contexts; use key conditions for key fields.
- A global secondary index query must use eventual consistency.
- Empty result collections are returned as `[]`; missing single records are returned as `null`.
- Do not reuse a cursor with a different table, index, key condition, or scan.

---

[Documentation home](../index.md) · [Documentation map](../reference/api.md)
