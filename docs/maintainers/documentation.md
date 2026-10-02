# Documentation writing and maintenance

Documentation is part of the API. A change is ready only when readers can understand and safely use it, and examples still match the supported package.

## Choose the right page

Follow the four reader needs described by [Diataxis](https://diataxis.fr/):

| Page type | Purpose | What to avoid |
| --- | --- | --- |
| Tutorial | Take a beginner to a working result | Exhaustive options or production operations before first success |
| How-to guide | Solve one task for a reader with prerequisites | An unexplained fragment or an unrelated conceptual detour |
| Explanation | Build a mental model and explain trade-offs | A method-by-method reference list |
| Reference | State exact inputs, outputs, defaults, restrictions and errors | Making readers infer contracts from examples |

The README is the front door, not the manual. Target roughly 150-250 lines; keep installation, a complete small example, limitations, help and links. Its final short topic links preserve previous section anchors.

## Writing rules

1. Start with the reader's outcome: "List tasks for a project", not "Query operation semantics".
2. Explain terms before relying on them. Introduce "global secondary index (GSI)" with a reason to use one.
3. Use plain language first, then the precise technical rule. Do not hide constraints to sound simple.
4. Avoid "just", "obviously" and "simply"; write direct instructions without judging difficulty.
5. Use short paragraphs, descriptive links and logical heading levels. Do not skip heading levels.
6. Give diagrams text alternatives, and never communicate a warning through colour alone.
7. Put essential warnings beside the relevant operation: scan cost, filter timing, replacement/upsert semantics, eventual consistency and uncertain writes.
8. Distinguish library behaviour, AWS service behaviour and local-backend behaviour.
9. Keep each exact fact in one authoritative reference page; link rather than duplicate long tables.
10. Use the same project/task story unless a specialised example needs another model.

## Code-example rules

- Prefer `defineTable()` for application examples. Explain when a low-level builder is needed.
- Complete examples include imports, setup, execution, expected output and cleanup.
- Fragments say they are fragments and link to prerequisites. Do not concatenate independent operations.
- Show one new idea at a time; keep advanced variants out of the first tutorial.
- State missing-record and failure behaviour as well as the successful result.
- Do not embed credentials, log sensitive values or run destructive operations on shared resources.
- Label AWS examples, required resources/permissions and potential charges.
- Do not imply local passing tests establish throughput, consistency, TTL or distributed-conflict parity.

## Checked example sources

Complete TypeScript examples live under `examples/docs`. They import the public package name. `tsconfig.docs.json` resolves that name to source for typechecking; execution uses the built package entry.

Place an exact copy in Markdown with these markers (the fenced block is illustrative, not an extra executable example):

````text
<!-- example: examples/docs/quick-start.ts -->
```ts
...exact contents of the source file...
```
<!-- /example -->
````

Keep the markers invisible to ordinary readers. The checker rejects code drift. For local scripts, put a JSON "Expected output" block immediately after the example and add that result to `examples/docs/expected-output.json`.

Every new local script needs an expected-output entry, which makes the test runner execute it. The shared fixture and read-only AWS script are the only non-executed modules; the AWS script is still typechecked. AWS service examples must not become implicit offline tests.

The link checker parses Markdown, verifies repository targets and heading anchors, and checks copies of the runnable examples and their output. It does not request external URLs. Review external official links and unmarked advanced fragments manually; passing the checker does not mean every reference fragment was executed.

## Local commands

From the repository root:

```sh
npm ci
npm run test:docs
npm run docs:build
npm run docs:preview
```

- `test:docs` builds the library, typechecks examples, checks links/example drift/version, tests the checker, and executes the six local scripts.
- `docs:build` checks Markdown and produces the static site; VitePress also rejects dead internal page links.
- `docs:preview` serves the built site. Open `http://localhost:4173/fluentful-orm/`.
- `docs:dev` runs the development server, normally at `http://localhost:5173/fluentful-orm/`.

The generated site and cache are ignored. Site dependencies are development-only and are not shipped in the npm tarball. VitePress 1.6.4's Vite dependency is overridden to patched Vite 6.4.3; the Vue plugin supports Vite 6. Keep this compatibility override covered by docs build/preview checks when upgrading.

## Publish the documentation site

The repository includes a GitHub Pages workflow, but adding it does not enable Pages, change visibility or publish a site automatically.

1. Decide whether to make this repository public. GitHub Free requires a public hosting repository. A separate public docs repository is an alternative but requires adapting checkout, links and workflows.
2. Review repository history and publication contents before changing visibility.
3. In repository Settings > Pages, select **GitHub Actions** as the source.
4. Publish the npm release first, then publish a matching stable GitHub release. Tag names must be `v<package-version>` or `<package-version>`.
5. The workflow builds/checks the release checkout, uploads the site and deploys it. The expected project URL is `https://mwolfsheimer.github.io/fluentful-orm/`.
6. If a workflow must be retried, use the manual dispatch with the latest stable release tag.

The workflow deliberately requires the latest stable GitHub release and the latest npm version to match the checked-out package. Draft/prerelease releases do not deploy. An older release or an npm/GitHub version mismatch fails before deployment; retry after publication is complete.

Do not push main-branch changes directly to the default site: they can describe APIs not yet published. CI builds main/PR documentation without deploying it. GitHub Pages is a public publication surface; a private source repository does not by itself make its site private.

See [GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site) and [VitePress deployment](https://vitepress.dev/guide/deploy).

## Release and link policy

- Update the package-version statement on the [documentation home](../index.md) when changing the package version; the checker enforces agreement.
- The hosted default is latest stable, not a multi-version selector. Older docs remain available through repository release tags.
- Repository README links point to main so the first documentation release does not introduce links to an undeployed site. After enabling Pages, maintainers can change npm-facing links to the verified stable site.
- Preserve old README top-level anchors as short destination links. If a page moves, retain a stub or update known inbound links.
- Use ordinary relative Markdown links within the docs. Root repository files are linked externally so the built site does not mistake them for pages.

## Documentation review checklist

- Does the page answer one reader need, with explicit prerequisites?
- Is the typed API the default and the code copied from checked source where applicable?
- Are expected output, important failure cases and cleanup explained?
- Are jargon and DynamoDB constraints introduced at the point of use?
- Do links, headings and examples pass `npm run test:docs`?
- Does `npm run docs:build` pass?
- For navigation/theme changes, check search, keyboard navigation and a narrow viewport in a browser.
- For API changes, update related reference, guide and checked example in the same pull request.
