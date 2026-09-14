# Contributing

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
