const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {mkdtempSync, readFileSync, writeFileSync, rmSync} = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');

const root = path.resolve(__dirname, '..');
const expected = JSON.parse(readFileSync(path.join(root, 'examples', 'docs', 'expected-output.json'), 'utf8'));

test('standalone first-application configuration and command', () => {
    const directory = mkdtempSync(path.join(root, '.docs-standalone-'));
    try {
        const tutorial = readFileSync(path.join(root, 'docs', 'getting-started', 'first-application.md'), 'utf8').replace(/\r\n/g, '\n');
        const configuration = tutorial.match(/```json\n([\s\S]*?)\n```/)[1];
        writeFileSync(path.join(directory, 'tsconfig.json'), configuration);
        writeFileSync(path.join(directory, 'quick-start.ts'), readFileSync(path.join(root, 'examples', 'docs', 'quick-start.ts')));
        const stdout = execFileSync(process.execPath, [
            require.resolve('ts-node/dist/bin.js'), 'quick-start.ts'
        ], {
            cwd: directory,
            env: {...process.env, TS_NODE_PROJECT: path.join(directory, 'tsconfig.json')},
            encoding: 'utf8',
            timeout: 30000
        });
        assert.deepEqual(JSON.parse(stdout.trim()), expected['quick-start.ts']);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

for (const [filename, output] of Object.entries(expected)) {
    test(`documentation example: ${filename}`, () => {
        const stdout = execFileSync(process.execPath, [
            '--require', require.resolve('ts-node/register'),
            path.join(root, 'examples', 'docs', filename)
        ], {
            cwd: root,
            env: {...process.env, TS_NODE_PROJECT: path.join(root, 'tsconfig.docs.json')},
            encoding: 'utf8',
            timeout: 30000
        });
        assert.deepEqual(JSON.parse(stdout.trim()), output);
    });
}
