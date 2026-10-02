# @fluentful/orm

Read and write DynamoDB records using chainable TypeScript methods instead of assembling AWS SDK requests and expressions yourself. The typed API uses Zod to validate data and infer result types.

## Why use it?

- Define a schema once and get typed keys, updates, projections, and results.
- Build readable queries and conditional writes without managing expression placeholders.
- Fetch pages, stream records, process batches, and compose transactions.
- Run locally with memory, file, or IndexedDB storage.

The library simplifies working with DynamoDB; it does not choose your access patterns, manage credentials, or remove DynamoDB's key, index, consistency, and capacity rules. Use `defineTable()` for application code; the lower-level `QueryBuilder` is available for dynamic tables and tooling.

## Install

```sh
npm install @fluentful/orm @aws-sdk/client-dynamodb@^3.1037.0 zod@^4.3.6
```

Node.js 20+ is supported. Install the peer dependencies alongside the package. The examples use TypeScript 6.

The package is CommonJS and can be consumed by browser bundlers; it does not provide a dedicated native browser ESM export. Memory is browser-safe, IndexedDB storage is browser-oriented, and file storage is Node-only.

## Quick start

This complete TypeScript script uses memory: no AWS account, credentials, or cloud resources are needed. See the [first-application tutorial](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/getting-started/first-application.md) for TypeScript setup and the run command.

<!-- example: examples/docs/quick-start.ts -->
```ts
import {createEngine, defineTable, QueryBuilder} from '@fluentful/orm';
import {z} from 'zod';

async function main() {
    const engine = createEngine.memory();
    try {
        // This creates storage; defineTable below only describes validation.
        await QueryBuilder.createTable('tasks', 'id', engine.db);
        const tasks = defineTable({
            name: 'tasks',
            key: {partition: 'id'},
            schema: z.object({
                id: z.string(),
                title: z.string(),
                status: z.enum(['todo', 'doing', 'done'])
            }).strict()
        }).using(engine.db);

        await tasks.create({
            id: 'task-1', title: 'Write the guide', status: 'todo'
        }).toPromise();
        const task = await tasks.get({id: 'task-1'}).toPromise();
        console.log(JSON.stringify(task));
    } finally {
        await engine.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```
<!-- /example -->

Expected output:

```json
{"id":"task-1","title":"Write the guide","status":"todo"}
```

`defineTable()` describes validation; it does **not** create storage. The example creates the table separately. A missing record returns `null`. A create replaces an existing record unless you add a condition.

## Documentation

| You want to... | Start here |
| --- | --- |
| Understand what the library does | [Documentation home](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/index.md) |
| Get your first working example | [First application](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/getting-started/first-application.md) |
| Understand chainable methods | [Fluent API lifecycle](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/concepts/fluent-api.md) |
| Learn the DynamoDB concepts you need | [Concepts](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/concepts/index.md) |
| Copy a worked example | [Task recipes](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/recipes.md) |
| Connect to real DynamoDB | [AWS setup](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/getting-started/aws.md) |
| Look up a method or result | [API reference](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/reference/api.md) |
| Diagnose an unexpected result | [Troubleshooting](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/troubleshooting.md) |

The linked repository documentation may include unreleased changes. Use the matching release tag for an installed package. Maintainers can publish a searchable documentation site using the included [GitHub Pages setup](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/maintainers/documentation.md#publish-the-documentation-site).

## Important behaviour

- Reuse table definitions, but create a fresh operation for independent work. Terminal execution is cached.
- Query filters run after items are evaluated; they do not reduce already-incurred read work.
- Batches can partially succeed. Do not retry uncertain writes blindly.
- Memory is a test stub, not a complete simulation of production DynamoDB.
- AWS service failures propagate; conditional-failure helpers handle only their explicit conditional case.

## Project sponsors

Thank you to our project sponsors.

### Happy Tree Cards

[Happy Tree Cards](http://happytreecards.com/)

### Risk Llama

[Risk Llama](https://www.riskllama.com/)

## License and contributions

Apache-2.0. See [LICENSE](LICENSE), [contribution guidance](CONTRIBUTING.md), and [DCO sign-off requirements](DCO.md).

Report problems through [GitHub issues](https://github.com/mwolfsheimer/fluentful-orm/issues), removing credentials and personal data from examples and logs.

## Contents

The following short links retain the README's previous section anchors. Detailed documentation now lives on focused pages.

## Define a table

[Define a table guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/reference/typed-tables.md).

## Create and read records

[Create and read records guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/read-write.md).

## Update records

[Update records guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/updates.md).

## Delete records

[Delete records guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/read-write.md).

## Conditions

[Conditions guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/conditions.md).

## Queries and indexes

[Queries and indexes guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/queries.md).

## Scans and filters

[Scans and filters guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/scans.md).

## Projections and counts

[Projections and counts guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/projections.md).

## Pagination and streaming

[Pagination and streaming guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/pagination.md).

## Batch operations

[Batch operations guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/batches.md).

## Transactions

[Transactions guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/transactions.md).

## Timestamps and logging

[Timestamps and logging guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/observability.md).

## Comparison and access rules

[Comparison and access rules guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/reference/comparisons.md).

## Values and serialization

[Values and serialization guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/reference/values.md).

## Lower-level QueryBuilder

[Lower-level QueryBuilder guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/reference/query-builder.md).

## Table administration

[Table administration guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/reference/table-admin.md).

## In-memory backend

[In-memory backend guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/guides/local-storage.md).

## Errors and operational rules

[Errors and operational rules guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/reference/errors.md).

## API reference

[API reference guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/reference/api.md).

## Evidence and fidelity

[Evidence and fidelity guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/maintainers/evidence.md).

## Tests

[Tests guide](https://github.com/mwolfsheimer/fluentful-orm/blob/main/docs/maintainers/testing.md).
