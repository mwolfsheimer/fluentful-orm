# Contributing

## Project governance

feather-orm is a maintainer-led project. Pull requests and proposals are welcome, but submitting one does not create an obligation to review, accept, merge, or release it. The maintainer has final authority over project direction, scope, releases, and merges.

For substantial changes, open an issue or design discussion first. Small, focused pull requests are preferred. Contributions should include relevant tests and documentation, and must not introduce unrelated changes.

## Developer Certificate of Origin

All commits must include a DCO sign-off. By signing off, you certify that you have the right to submit the contribution under the Apache-2.0 license. See [DCO.md](DCO.md) for the certificate text.

Add the sign-off automatically with:

```bash
git commit -s -m "Describe the change"
```

If you are contributing on behalf of an employer, confirm that you are authorized to submit the work. A pull request may be closed without being merged if its provenance, licensing, scope, quality, or fit with the project cannot be established.

## Development

Install dependencies and run the offline checks:

```bash
npm install
npm test
```

The package uses Node's built-in test runner and the in-memory DynamoDB backend, so the default test command does not need AWS credentials or a local DynamoDB process.

Useful commands:

- `npm run typecheck` checks source and offline test types.
- `npm run build` emits CommonJS JavaScript and declaration files to `dist/`.
- `npm run test:memory` runs the shared behavioural contract against the in-memory backend.
- `npm run test:integration` runs the same contract against real DynamoDB using the standard AWS credential chain. It creates and deletes temporary tables.
- `npm run pack:check` verifies the files that would be published to npm.

Add application-visible query behaviour to `test/query-builder.contract.ts` so both backends exercise the same contract. Keep request-shape and serializer tests in their focused unit-test files.
