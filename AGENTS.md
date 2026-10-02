# AGENTS.md

## Project Summary

`@fluentful/orm` is a TypeScript fluent wrapper around the AWS SDK v3 DynamoDB client. It exposes a low-level untyped `QueryBuilder`, a schema-aware Zod API built with `defineTable()`, table administration helpers, transactions, and an in-memory DynamoDB-compatible backend for tests and local workflows.

The package currently builds to CommonJS JavaScript and declaration files in `dist/`. The normal runtime code is suitable for browser bundlers, but `createEngine.file()` is Node-only and the published package does not currently provide a dedicated ESM or `browser` export. Browser storage is exposed as `createEngine.browser()`.

## Repository Layout

### Source (`src/`)

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Public barrel. Re-exports the low-level builder, typed table factory/types, serializer, value utilities, transaction builder, table-admin types, and `createEngine`. Add every intended public API here. |
| `src/types.ts` | Shared runtime-facing TypeScript contracts: serialized AttributeValue shapes, document/key types, pagination and response types, batch options, return modes, and fluent chain interfaces. Update this when a chain or public result contract changes. |
| `src/query-builder.ts` | Mutable low-level fluent builder. Starts CRUD, query, scan, batch, condition-check, table-admin, and transaction operations; applies fluent modifiers; owns execution-once and promise caching; converts an operation to a transaction item. |
| `src/typed-table.ts` | Zod-backed typed API. Defines `TypedTable`, `TypedTableQuery`, `defineTable()`, typed chain interfaces, key/index/projection validation, schema parsing, typed batches, and typed transactions. It delegates request assembly to `QueryBuilder`. |
| `src/fluent-query.ts` | Factory functions and interfaces for comparison and conditional fluent subchains used by the low-level builder. |
| `src/expression-builder.ts` | Collects expression names, values, conditions, filters, key conditions, and update actions, then writes the compiled expressions onto an AWS request input. |
| `src/query-request-state.ts` | Owns the discriminated current operation and validates request modifiers such as consistency, projections, limits, return modes, indexes, and parallel scans. |
| `src/query-operation.ts` | Discriminated union of supported AWS command inputs, including the custom optional-expression condition-check shape. |
| `src/query-executor.ts` | Sends assembled AWS SDK commands, parses results, follows query/scan pages, applies hard limits, streams pages/items, retries unprocessed batch work, logs requests/results, and builds response metadata. |
| `src/execution-options.ts` | Binds execution cancellation once and implements abortable retry delays. Keep signals outside cloned request data. |
| `src/update-expression.ts` | Isolated structured SET operand descriptors and restricted expression compilation for assignments, fallbacks, list append, and binary arithmetic. |
| `src/query-serializer.ts` | Converts JavaScript values/documents to and from DynamoDB AttributeValue maps. Handles numbers, strings, booleans, nulls, maps, lists, sets, and `Uint8Array` binary values. |
| `src/value-utils.ts` | Platform-neutral deep clone/equality/diff implementation. Preserves supported built-ins, cycles, shared references, enumerable metadata, typed arrays, ArrayBuffers, maps, sets, and errors. Used to isolate caller, backend, and response values. |
| `src/batch-runner.ts` | Splits arrays into chunks and runs chunk workers with bounded concurrency while preserving result order and stopping new work after failure. |
| `src/transaction-write-builder.ts` | Mutable low-level `TransactWriteItems` builder. Collects up to 100 transaction items, applies request options/idempotency/logging, and caches execution. |
| `src/transaction-read-builder.ts` | Ordered atomic `TransactGetItems` builder with projections, nullable tuple positions, cancellation, and cached execution. |
| `src/query-table-admin.ts` | Low-level create, delete, list, describe, and definition-discovery helpers. Validates portable table/key/index/projection definitions and converts them to/from AWS command inputs. |
| `src/in-memory-dynamodb.ts` | In-memory implementation of the AWS command subset used by this library. Supports tables, CRUD, query/scan/filter/projection, batches, transactions, validation failures, cloning, reset/close, file persistence, and IndexedDB persistence. `createEngine` is the public factory; the backend class and persistence classes are internal. |
| `src/quewe.ts` | Small serial async work queue with pause/resume. It is a standalone utility used by tests and queue-oriented workflows. |

### Tests (`test/`)

| File | Responsibility |
| --- | --- |
| `test/fake-dynamodb.ts` | Test double that records AWS command inputs and returns configurable responses/failures. Use it for request-shape and executor behavior tests. |
| `test/unit.test.ts` | Node test-runner aggregator for the focused builder, batch, serializer, transaction, typed-table, and value-utils suites. |
| `test/query-builder.test.ts` | Low-level request construction and fluent lifecycle: modifiers, expressions, projections, return modes, timestamps, promise/result caching, table-admin delegation, and validation before sending. |
| `test/query-batch.test.ts` | Pagination, lazy page/item iteration, hard limits, count behavior, batch chunking/concurrency, unprocessed retries, duplicate-key handling, and `Quewe`. |
| `test/query-serializer.test.ts` | AttributeValue round trips, nested values, sets, binary data, undefined/invalid values, number precision, and parsing helpers. |
| `test/query-transaction.test.ts` | Low-level transaction item construction, condition checks, idempotent execution, option precedence, transaction limits, and service failures. |
| `test/typed-table.test.ts` | Typed chain inference, Zod validation, typed keys/indexes/projections, typed result caching, typed batches, typed transactions, and compile-time API assertions. |
| `test/value-utils.test.ts` | Deep clone/equality/diff semantics for cycles, references, built-ins, typed arrays, maps, sets, and enumerable metadata. |
| `test/query-builder.contract.ts` | Shared application-visible behavior contract. Add behavior changes here when both the memory backend and real DynamoDB should obey the same semantics. |
| `test/query-builder.memory.test.ts` | Runs the shared contract against `createEngine.memory()` and closes the backend. |
| `test/query-builder.integration.test.ts` | AWS-only credential preflight, bounded shared contract and opt-in conflict/throttling/TTL probes, resource tracking, independent cleanup, and orphan reporting. Included in offline typecheck but executed only explicitly. |
| `test/in-memory-dynamodb-lifecycle.test.ts` | Memory-backend-specific isolation, reset/close behavior, unsupported operations, index projections, metadata, point projections, and parallel scans. |
| `test/persistence.test.ts` | File persistence and IndexedDB persistence across engine instances, binary values, durable mutation/reset behavior, and rollback. Uses `fake-indexeddb` for Node. |
| `test/memory.test.ts` | Node test-runner aggregator for lifecycle, persistence, and memory contract tests. |

### Consumer/browser fixture (`test/consumer/`)

| File | Responsibility |
| --- | --- |
| `test/consumer/src/consumer.ts` | Consumer-side TypeScript smoke code. Imports AWS SDK, Zod, and the published package; exercises memory and IndexedDB persistence and marks the browser document as passed/failed. |
| `test/consumer/browser.html` | Minimal page that loads the generated `dist/consumer.js`. It is a manual/browser-run smoke page, not an automated browser test. |
| `test/consumer/webpack.config.cjs` | Webpack production bundle configuration for the consumer. It transpiles TypeScript and resolves the package through normal bundler rules. |
| `test/consumer/run.cjs` | Packs the repository, installs the tarball plus peer dependencies into the fixture, runs fixture typecheck and Webpack, checks CommonJS and ESM Node imports, and rejects published declarations containing `Buffer` types. It does not launch a real browser. |
| `test/consumer/require.cjs` | Verifies the CommonJS package entry exposes the public API. |
| `test/consumer/import.mjs` | Verifies the default import path exposes the public API under Node's ESM loader. |
| `test/consumer/package.json` | Private fixture dependencies and versions used by the consumer matrix. |
| `test/consumer/tsconfig.json` | Strict NodeNext typecheck configuration for consumer code. |
| `test/consumer/.gitignore` | Ignores fixture-installed dependencies, generated bundle, and artifacts. |
| `test/consumer/.artifacts/` | Generated tarballs from `test:consumer`; never hand-edit. |
| `test/consumer/dist/` | Generated consumer bundle; never hand-edit. |
| `test/consumer/node_modules/` | Fixture-local installed dependencies; never hand-edit or include in changes. |

### Root and repository metadata

| File/directory | Responsibility |
| --- | --- |
| `package.json` | Package identity, CommonJS entry/exports, peer/dev dependencies, publish files, Node engine metadata, and all supported scripts. |
| `package-lock.json` | npm dependency lockfile. Keep it synchronized with intentional dependency changes. |
| `README.md` | User-facing API documentation, examples, environment notes, in-memory backend contract, limitations, and test commands. Update it when public behavior or supported usage changes. |
| `tsconfig.json` | Strict source/test typecheck configuration. Targets ES2022, includes DOM and Node typings, and uses CommonJS. The Node typings are needed for tests and type declarations; they do not by themselves make every runtime path Node-only. |
| `tsconfig.build.json` | Build-only extension of `tsconfig.json`; emits JavaScript, declarations, source maps, and inline sources to `dist/`. |
| `CONTRIBUTING.md` | Governance, DCO requirement, development commands, and test-placement guidance. |
| `DCO.md` | Developer Certificate of Origin text and sign-off instructions. |
| `LICENSE` | Apache-2.0 license. |
| `AGENTS.md` | This coding-agent map and local engineering guidance. |
| `.gitignore` | Ignores dependencies, build/test output, IDE files, environment files, logs, and local tarballs. |
| `.npmignore` | Excludes source, tests, configs, and repository metadata from the npm package; the published package is driven by `package.json.files` plus this file. |
| `.github/workflows/ci.yml` | CI: `npm test` on Node 20, 22, and 24; consumer packaging checks across two Zod versions and baseline/latest AWS SDK versions. |
| `.github/CODEOWNERS` | Routes all changes to `@mwolfsheimer`. |
| `.github/FUNDING.yml` | GitHub funding configuration. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Pull request summary and test/documentation/DCO checklist. |
| `dist/` | Generated package output from `npm run build`; do not hand-edit. It is ignored by Git and included in npm publication. |
| `node_modules/` | Installed dependencies; never edit or include in changes. |
| `.idea/` | Local JetBrains IDE metadata; do not use it as application configuration. |

## Documentation and examples

- `docs/` contains local-first tutorials, task guides, conceptual explanations, API reference, and maintainer instructions. Keep these reader needs separate and follow `docs/maintainers/documentation.md`.
- `docs/.vitepress/config.mts` owns site navigation, local search, and the GitHub Pages base path. Markdown must remain readable on GitHub.
- `examples/docs/` contains checked public-package examples and expected JSON output. Marked Markdown copies must exactly match their source; AWS examples are typechecked but not executed offline.
- `scripts/check-docs.cjs` validates local links/anchors, marked examples/output, and the documented package version. `scripts/test-docs-*.cjs` tests the checker and executes local examples.
- `tsconfig.docs.json` typechecks examples against source. Runtime checks use the built public package.
- `.github/workflows/docs.yml` deploys the latest stable release only after npm/GitHub versions match. Main/PR CI checks and builds docs without deploying. Pages enablement and repository visibility remain maintainer decisions.

## Architecture and Data Flow

For a normal operation, follow this path:

1. Application code calls `defineTable(...).using(client)` for the typed API, or constructs `new QueryBuilder(table, client)` for the low-level API.
2. `QueryBuilder` or `TypedTableQuery` starts an operation and exposes a chain from the interfaces in `types.ts` or `typed-table.ts`.
3. Typed operations validate input/keys/fields with Zod, then delegate to `QueryBuilder` with a parser for returned documents.
4. `QueryRequestState` records the AWS command kind and validates operation-specific modifiers.
5. `ExpressionBuilder` compiles conditions, filters, key conditions, projections, and updates into placeholders and expressions.
6. `QuerySerializer` converts JavaScript values to DynamoDB AttributeValues. `ValueUtils` clones data at ownership boundaries.
7. `QueryBuilder.createExecutor()` creates `QueryExecutor`, which sends AWS SDK commands and parses, retries, paginates, or streams results.
8. A real `DynamoDBClient` sends to AWS; `createEngine.memory()`, `createEngine.browser()`, and `createEngine.file()` supply compatible clients for local/test use.

Keep these ownership boundaries intact. Request assembly belongs in the builder/state/expression layers, service execution belongs in `QueryExecutor`, value conversion belongs in `QuerySerializer`/`ValueUtils`, and storage semantics belong in `in-memory-dynamodb.ts`.

## Commands

Run commands from the repository root after installing dependencies.

| Command | Use |
| --- | --- |
| `npm install` | Install dependencies for local development. |
| `npm ci` | Reproducible clean install used by CI. |
| `npm run typecheck` | Strict typecheck of source and offline tests without emitting files. |
| `npm run build` | Emit CommonJS JavaScript, declarations, and source maps to `dist/`. |
| `npm test` | Build, then run `test/unit.test.ts` and `test/memory.test.ts`; no AWS service is required. |
| `npm run test:unit` | Focused command-construction, serializer, transaction, typed-table, batch, and value utility tests. |
| `npm run test:memory` | Shared contract plus memory lifecycle/persistence tests; no AWS service is required. |
| `npm run test:persistence` | File and IndexedDB persistence tests directly. |
| `npm run test:integration` | Shared contract against real DynamoDB. Requires AWS credentials, `AWS_REGION` if not using the default (`eu-west-2` in the runner), and permissions to create/delete temporary tables. |
| `npm run test:consumer` | Packs the package, installs it in the consumer fixture, typechecks, Webpacks, and checks Node CJS/ESM consumers. Set `ZOD_VERSION` or `AWS_SDK_VERSION` to override fixture versions. |
| `npm run test:docs` | Builds the package, checks example types/links/drift, and runs local documentation scripts without AWS. |
| `npm run docs:build` | Checks documentation and builds the searchable VitePress site. |
| `npm run docs:dev` | Serves documentation with live reload for authors. |
| `npm run docs:preview` | Serves the built site at `http://localhost:4173/fluentful-orm/`. |
| `npm run pack:check` | Shows the files that would be included in an npm package. |
| `npm run clean` | Removes generated root `dist/` using Node filesystem APIs. |

Use the narrowest relevant check first. After changing request construction, run the relevant focused unit test. After changing application-visible behavior, run the shared memory contract. After changing persistence, run `test:persistence`. After changing exports, declarations, dependencies, or browser compatibility, run `npm run build` and `npm run test:consumer`.

## Browser and Node Boundaries

- The package is built as CommonJS (`tsconfig.json` and `package.json`). Bundlers such as Webpack can consume it; direct native browser ESM/CDN use may need a bundler or a future ESM/browser export.
- `@aws-sdk/client-dynamodb` is a runtime dependency supplied by the consumer as a peer dependency. Browser applications must configure the AWS client and credentials for browser use according to their deployment/security model.
- `createEngine.memory()` is process-local and browser-safe.
- `createEngine.browser(name)` uses IndexedDB and is browser-oriented. In Node tests, `fake-indexeddb/auto` supplies the API.
- `createEngine.file(path)` dynamically loads `node:fs/promises` only in Node and must remain unavailable in browsers.
- Do not add static imports of Node-only modules to shared runtime files. Keep optional Node functionality behind guarded, bundler-safe loading.
- Use `Uint8Array` in public types and examples for binary values. Do not expose `Buffer` in declarations or require the Node global for normal operations; `test/consumer/run.cjs` checks this.
- `npm run test:consumer` checks packaging and bundling only. `npm run test:browser` additionally executes the IndexedDB/typed API fixture in Chromium at desktop and mobile viewport sizes. Do not claim browser execution from the consumer command alone.
- Recoverable batches preserve completed, explicitly unprocessed, never-submitted, and uncertain work separately. Only known-unprocessed and never-submitted inputs belong in safe resume payloads; do not retry uncertain writes automatically.
- Memory supports deterministic GSI lifecycle and key-based table/index query/scan continuation after cursor deletion or index-key changes. Memory scan order and index tie-breaking are deterministic, not AWS ordering guarantees. It does not simulate throughput, TTL expiry, byte limits, eventual consistency, or distributed conflicts. AWS probes with no observed target event are inconclusive, not parity evidence.

## API Design Rules

1. Prefer the typed API for application code. Define a table once with `defineTable({name, schema, key, indexes, timestamps})`, bind it with `.using(dynamoDB)`, and let Zod validate inputs and outputs.
2. Use `QueryBuilder` for dynamic tables, migration tooling, request construction, or behavior that intentionally does not have a schema. Do not duplicate typed validation in the low-level layer.
3. Preserve fluent terminal semantics. A builder is mutable and is intended to be configured once; execution is one-shot and terminal promises are cached. `toPromise()`, `toResponse()`, `toResult()`, and `toPromiseOrNull()` have intentionally different payload/failure semantics. Update both runtime chains and their TypeScript interfaces when changing them.
4. Keep success and conditional-failure payload modes separate. `returningAllNew`, `returningAllOld`, `returningNone`, and `onConditionFailure` map to distinct AWS fields and result types.
5. Preserve AWS limits and validation at the boundary: batch get uses chunks of 100, batch write uses chunks of 25, transactions allow at most 100 items, and invalid limits/concurrency/projections/keys should fail before an AWS request when possible.
6. Use the existing serializer for every DynamoDB value. Do not manually build AttributeValue maps in new feature code. Add serializer tests for each new value shape, especially binary, set, nested, undefined, and non-finite-number cases.
7. Clone caller input and returned/stored values at ownership boundaries. Do not expose mutable backend state or silently change `ValueUtils` graph semantics.
8. Keep typed keys exact and schema-aware. Validate table/index definitions, key field existence/types, projection fields, and returned records through `TypedTable` rather than weakening types with `any`.
9. Keep public additions deliberate. Add exports in `src/index.ts`, public interfaces/types in the appropriate contract file, README examples/limitations, focused runtime tests, and consumer checks when packaging is affected.
10. Keep table-admin definitions portable. Use `DynamoDBTableDefinition` and `QueryTableAdmin` conversion/validation instead of leaking AWS-only fields into the portable definition.
11. Preserve service error identity and conditional-write behavior. Do not turn infrastructure failures into `null`; only the explicit conditional failure helpers should alter that result path.
12. Keep the memory backend an honest test stub. Extend its command/expression subset only when the library generates that behavior, reject unsupported syntax explicitly, and add the same application-visible behavior to `query-builder.contract.ts` when appropriate.
13. Prefer additive, focused changes. Avoid broad formatting or renaming, preserve established public spellings such as `browser`, and do not modify generated output or dependencies by hand.
14. Use strict TypeScript and ASCII by default. Match surrounding indentation and quote style, add comments only for non-obvious logic, and keep public methods documented when their behavior is subtle.

## Where to Add Tests

- Generated AWS request input or fluent modifier validation: `test/query-builder.test.ts`.
- Pagination, lazy iteration, counts, batches, retries, or queue behavior: `test/query-batch.test.ts`.
- JavaScript/AttributeValue conversion: `test/query-serializer.test.ts`.
- Transaction lifecycle or transaction item options: `test/query-transaction.test.ts`.
- Zod parsing, inferred result types, typed keys/indexes/projections, or typed transactions: `test/typed-table.test.ts`.
- Clone/equality/reference behavior: `test/value-utils.test.ts`.
- Shared CRUD/query/write behavior: `test/query-builder.contract.ts`, then verify both memory and integration runners as available.
- Persistence/reset/close/unsupported-memory behavior: `test/in-memory-dynamodb-lifecycle.test.ts` or `test/persistence.test.ts`.
- Package exports, declaration portability, or browser bundling: `test/consumer/` and `npm run test:consumer`.

When a behavior is deliberately backend-specific, keep it in the backend-specific suite. When it is visible through the public query API, put it in the shared contract so the in-memory implementation cannot drift from real DynamoDB expectations.

## Change Checklist

Before finishing a change, check:

- The owning source module and public export boundary are clear.
- Runtime behavior, fluent interfaces, and typed interfaces agree.
- A focused test covers the changed behavior and the shared contract is updated when needed.
- `npm run typecheck` or the most relevant executable check passes.
- `npm test` passes for normal offline changes.
- `npm run test:consumer` passes for packaging/browser/declaration changes.
- `npm run test:integration` is run when real DynamoDB behavior is relevant and credentials are available.
- README/API documentation is updated for public behavior.
- Generated files, `node_modules`, local artifacts, and unrelated user changes are left untouched.
- No commit or branch is created unless explicitly requested.