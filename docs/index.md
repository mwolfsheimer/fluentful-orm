# @fluentful/orm documentation

Build DynamoDB requests with readable TypeScript chains. Use Zod-backed tables to validate records and infer result types, without assembling SDK requests or expression placeholders yourself.

The library simplifies requests, not DynamoDB's data model. It does not choose your keys, manage credentials, or replace infrastructure tooling.

## Start here

1. [Run your first application](./getting-started/first-application.md) without an AWS account.
2. [Understand fluent chains](./concepts/fluent-api.md): configure an operation, then execute it.
3. [Learn keys and access patterns](./concepts/keys-and-access-patterns.md).
4. [Try the task recipes](./guides/recipes.md).
5. [Connect to AWS](./getting-started/aws.md).

## Find the right kind of help

| Your goal | Where to go |
| --- | --- |
| Learn by doing | [First application](./getting-started/first-application.md) |
| Copy a worked example | [Task recipes](./guides/recipes.md) and [shared setup](./getting-started/task-setup.md) |
| Understand why | [Concepts](./concepts/index.md) |
| Find an exact contract | [API reference](./reference/api.md) |
| Diagnose an unexpected result | [Troubleshooting](./guides/troubleshooting.md) |
| Choose a local backend | [Memory, files, and browser storage](./guides/local-storage.md) |
| Contribute documentation | [Writing and maintenance rules](./maintainers/documentation.md) |

## Task guides

- Records: [create/read/delete](./guides/read-write.md), [update](./guides/updates.md), [conditional writes](./guides/conditions.md).
- Reads: [queries and indexes](./guides/queries.md), [scans](./guides/scans.md), [selected fields and paths](./guides/projections.md), [pagination and streaming](./guides/pagination.md).
- Reliability: [batches](./guides/batches.md), [transactions](./guides/transactions.md), [cancellation](./reference/execution.md#cancellation).
- Operations: [timestamps/logging/metadata](./guides/observability.md), [table administration](./reference/table-admin.md).
- Advanced reference: [typed tables](./reference/typed-tables.md), [serialization](./reference/values.md), [comparison rules](./reference/comparisons.md), [low-level builder](./reference/query-builder.md).

## Project sponsors

Thank you to our project sponsors.

### Happy Tree Cards

[Happy Tree Cards](http://happytreecards.com/)

### Risk Llama

[Risk Llama](https://www.riskllama.com/)

## Environments and version

These documents accompany package version **1.1.0**. The default hosted site is deployed from a stable release tag; the repository's main branch may include unreleased changes. Check your installed version with `npm list @fluentful/orm`.

The package targets Node.js 20+ and is built as CommonJS. Browser bundlers can consume it; it has no dedicated native browser ESM export. Memory is browser-safe, IndexedDB storage is browser-oriented, and file storage is Node-only. See [environment and storage details](./guides/local-storage.md).

This is an Apache-2.0 project. See the [licence](https://github.com/mwolfsheimer/fluentful-orm/blob/main/LICENSE), [contribution process](https://github.com/mwolfsheimer/fluentful-orm/blob/main/CONTRIBUTING.md), and [issue tracker](https://github.com/mwolfsheimer/fluentful-orm/issues).
