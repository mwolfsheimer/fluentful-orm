# Contributing

## Project governance

`@fluentful/orm` is a maintainer-led project maintained by Marco Wolfsheimer. Pull requests and proposals are welcome, but submitting one does not create an obligation to review, accept, merge, or release it. The maintainer has final authority over project direction, scope, releases, and merges.

For substantial changes, open an issue or design discussion first. Small, focused pull requests are preferred. Contributions should include relevant tests and documentation, and must not introduce unrelated changes.

## Documentation contributions

Follow the [documentation writing and maintenance rules](docs/maintainers/documentation.md). Keep tutorials, task guides, explanations, and reference separate. API changes should update their documentation and checked examples in the same pull request.

Run `npm run test:docs` for runnable examples, link/anchor checks and snippet drift, and `npm run docs:build` for the static site. Use `npm run docs:preview` to inspect the built site at `http://localhost:4173/fluentful-orm/`. The documentation CI job runs these checks without AWS credentials. Publishing is release-aligned and requires maintainer setup; see the [Pages instructions](docs/maintainers/documentation.md#publish-the-documentation-site).

## Developer Certificate of Origin

All commits must include a DCO sign-off. By signing off, you certify that you have the right to submit the contribution under the Apache-2.0 license. See [DCO.md](DCO.md) for the certificate text.

Add the sign-off automatically with:

```bash
git commit -s -m "Describe the change"
```

If you are contributing on behalf of an employer, confirm that you are authorized to submit the work. A pull request may be closed without being merged if its provenance, licensing, scope, quality, or fit with the project cannot be established.

## Development

Use Node.js 20.17+ for development (the runtime package still supports Node.js 20+). Install dependencies and run the offline checks:

```bash
npm install
npm test
```

The package uses Node's built-in test runner and the in-memory DynamoDB backend, so the default test command does not need AWS credentials or a local DynamoDB process.

Useful commands:

- `npm run format` formats TypeScript source, tests, examples and the documentation site configuration.
- `npm run format:check` checks the same files without changing them; CI runs this check.
- `npm run typecheck` checks source and offline test types.
- `npm run build` emits CommonJS JavaScript and declaration files to `dist/`.
- `npm run test:memory` runs the shared behavioural contract against the in-memory backend.
- `npm run test:integration` runs the same contract against real DynamoDB using the standard AWS credential chain. It creates and deletes temporary tables.
- `npm run pack:check` verifies the files that would be published to npm.

Add application-visible query behaviour to `test/query-builder.contract.ts` so both backends exercise the same contract. Keep request-shape and serializer tests in their focused unit-test files.

## Formatting and commit hook

Prettier owns mechanical TypeScript formatting: four spaces, single quotes, semicolons, no trailing commas, a 120-column wrapping target and LF line endings. Generated output, dependencies and caches are excluded. Markdown prose and other file types are not reformatted by these commands.

`npm install` (or `npm ci`) installs the local Husky hook through the `prepare` script. Run `npm run prepare` to reinstall it in an existing checkout. The hook requires Git and the development dependencies; it is not part of the published runtime API. If you already use a custom `core.hooksPath`, integrate the hook with that setup before running installation, because Husky configures this Git setting.

Before each commit, the hook runs `npm run format:staged`. lint-staged formats only staged `.ts`, `.mts` and `.cts` files and stages its formatting changes. It keeps its default backup and partially-staged-file protection enabled; do not disable these safeguards or replace them with `git add .`. Formatting applies to the staged version of a file, not only to the individual changed lines. If formatting and unstaged edits conflict, resolve the conflict and stage the intended changes again.

Review the staged diff before committing. The hook does not run tests or judge readability, so run the relevant checks separately. CI also checks formatting because local hooks can be skipped.

When formatting a checked example under `examples/docs`, update its marked Markdown copies in the same change and run `npm run test:docs`. The formatter does not synchronize those copies automatically.

## Readability and comments

These conventions require judgement and review; Prettier does not enforce declaration placement, meaningful spacing or comment quality.

- Separate validation, setup, execution and result handling with a single blank line where it helps readers see the phases. Keep closely related statements together rather than inserting a blank line after every statement. Prettier removes blank lines immediately inside function bodies; do not fight it with ignore directives.
- After guard clauses, group related setup variables near the beginning of the function or block when their values are available. Prefer `const` and the narrowest useful scope. Keep dependent or asynchronous initializations where they belong: never move them across validation, side effects or `await` merely to collect declarations at the top.
- Use names that explain the domain and purpose. Prefer an explicit branch or a well-named intermediate value to nested ternaries and dense expressions. Extract a helper when it names a cohesive operation, not just to shorten a function.
- Add comments for intent, constraints, ownership boundaries, ordering dependencies and surprising behaviour. Explain why in-flight work must settle, why a value is cloned, or why an AWS restriction matters; do not narrate obvious assignments, loops or returns.
- Use JSDoc on public APIs when callers need to understand subtle behaviour, including caching, mutation, conditional failures or partial results. Keep comments accurate when code changes; remove stale or redundant ones rather than adding a comment quota.
- Keep readability-only changes separate from behaviour changes where practical. Never move declarations or rewrite control flow without preserving evaluation order, error identity and cleanup.
