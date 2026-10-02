# Troubleshoot unexpected results

Start with the symptom. Do not convert every failure into null: access-denied, network, and schema errors usually require action.

| Symptom | Check | Next step |
| --- | --- | --- |
| Table not found | Did you create storage, not only call `defineTable()`? Is the client in the correct region? | [AWS setup](../getting-started/aws.md) |
| Get returns null | Does the complete key identify a stored item? | [Keys](../concepts/keys-and-access-patterns.md) |
| Update created an incomplete record | DynamoDB updates can create missing items. | Add an [existence condition](./updates.md#prevent-accidental-upserts). |
| Create replaced an existing record | Create uses put semantics by default. | Add a [create-only condition](./read-write.md#create). |
| Filter returns little but consumes capacity | Filtering happens after evaluation. | Review the [access pattern](../concepts/queries-and-filters.md). |
| Empty page has a cursor | More evaluated items can remain after filtering. | [Continue pagination](./pagination.md#read-one-resumable-page). |
| New write is absent from a GSI | Index propagation is eventually consistent. | [Consistency](../concepts/indexes-and-consistency.md) |
| Second terminal call did not refresh data | The operation caches its execution. | Create a [fresh operation](../concepts/fluent-api.md#definitions-are-reusable-operation-chains-are-not-templates). |
| ZodError after a write | Returned data can fail validation after the service succeeds. | Check [input/output schemas](../reference/typed-tables.md#zod-input-and-output-types) and reconcile stored state. |
| Batch failed after some writes succeeded | Batches are not atomic. | Inspect [recoverable outcomes](./batches.md#recoverable-batch-outcomes). |
| Aborted write might exist | Cancellation is not rollback. | [Reconcile uncertainty](../concepts/reliability.md#cancellation-does-not-undo-a-write). |
| Local test passes but production behaviour differs | Memory does not simulate all service behaviour. | Read [backend limits](./local-storage.md) and [test evidence](../maintainers/evidence.md). |

## Reporting a problem

Include the installed package/peer versions, environment, minimal reproduction, error name, and whether it occurs against memory or AWS.

Remove credentials and personal data from logs. If possible, reproduce against a temporary local table before sharing an example. Use the [issue tracker](https://github.com/mwolfsheimer/fluentful-orm/issues).
