const assert = require('node:assert/strict');
const {mkdtempSync, mkdirSync, writeFileSync, rmSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {checkDocs} = require('./check-docs.cjs');

test('documentation checker accepts valid links and rejects broken targets, anchors and example drift', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fluentful-docs-'));
    try {
        mkdirSync(path.join(root, 'docs'));
        mkdirSync(path.join(root, 'examples', 'docs'), {recursive: true});
        writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0"}');
        writeFileSync(path.join(root, 'examples', 'docs', 'expected-output.json'), '{"sample.ts":{"ok":true}}');
        writeFileSync(path.join(root, 'examples', 'docs', 'sample.ts'), 'console.log(JSON.stringify({ok: true}));\n');
        const example = '<!-- example: examples/docs/sample.ts -->\n```ts\nconsole.log(JSON.stringify({ok: true}));\n```\n<!-- /example -->\n\nExpected output:\n\n```json\n{"ok":true}\n```\n';
        const valid = '# Documentation\n\npackage version **1.0.0**\n\n[Jump](#a-heading)\n\n## A heading\n\n' + example
            + '\n```text\n<!-- example: illustrative-only.ts -->\n```\n';
        const index = path.join(root, 'docs', 'index.md');
        writeFileSync(index, valid);
        assert.equal((await checkDocs(root)).examples, 1);
        writeFileSync(index, valid.replace('(#a-heading)', '(missing.md)'));
        await assert.rejects(checkDocs(root), /missing link target/);
        writeFileSync(index, valid.replace('(#a-heading)', '(#missing-heading)'));
        await assert.rejects(checkDocs(root), /missing anchor/);
        writeFileSync(index, valid.replace('console.log(JSON.stringify({ok: true}));', 'console.log(false);'));
        await assert.rejects(checkDocs(root), /example drift/);
        writeFileSync(index, valid.replace('{"ok":true}', '{"ok":false}'));
        await assert.rejects(checkDocs(root), /output drift/);
        writeFileSync(index, valid.replace('version **1.0.0**', 'version **0.9.0**'));
        await assert.rejects(checkDocs(root), /documentation version/);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});
