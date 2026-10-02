const assert = require('node:assert/strict');
const {existsSync, readFileSync, readdirSync, statSync} = require('node:fs');
const path = require('node:path');
const MarkdownIt = require('markdown-it');

function markdownFiles(directory) {
    return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
        if (entry.name.startsWith('.')) return [];
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : [];
    });
}

async function checkDocs(root) {
    const {default: GithubSlugger} = await import('github-slugger');
    const markdown = new MarkdownIt({html: true});
    const files = [
        ...['README.md', 'CONTRIBUTING.md'].map(file => path.join(root, file)).filter(existsSync),
        ...markdownFiles(path.join(root, 'docs'))
    ];
    const expected = JSON.parse(readFileSync(path.join(root, 'examples', 'docs', 'expected-output.json'), 'utf8'));
    const seenExamples = new Set();
    const documents = new Map();
    function document(file) {
        if (documents.has(file)) return documents.get(file);
        const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        const tokens = markdown.parse(source, {});
        const slugger = new GithubSlugger();
        const anchors = new Set();
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].type === 'heading_open') {
                const text = (tokens[i + 1].children || [])
                    .filter(token => ['text', 'code_inline'].includes(token.type))
                    .map(token => token.content).join('');
                anchors.add(slugger.slug(text));
            }
            if (['html_block', 'html_inline'].includes(tokens[i].type)) {
                for (const match of tokens[i].content.matchAll(/\bid=["']([^"']+)["']/g)) {
                    anchors.add(match[1]);
                }
            }
        }
        const result = {source, tokens, anchors};
        documents.set(file, result);
        return result;
    }
    let links = 0;
    for (const file of files) {
        const {source, tokens} = document(file);
        for (const token of tokens.flatMap(token => [token, ...(token.children || [])])) {
            if (!['link_open', 'image'].includes(token.type)) continue;
            let href = token.attrGet(token.type === 'image' ? 'src' : 'href');
            const ownRepo = 'https://github.com/mwolfsheimer/fluentful-orm/';
            if (href.startsWith(ownRepo + 'blob/main/') || href.startsWith(ownRepo + 'tree/main/')) {
                href = '/' + href.slice(ownRepo.length).replace(/^(blob|tree)\/main\//, '');
            } else if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
                continue;
            }
            const [target, hash] = href.split('#');
            const filename = decodeURIComponent(target.split('?')[0]);
            const destination = filename ? path.resolve(filename.startsWith('/') ? root : path.dirname(file), filename.replace(/^\//, '')) : file;
            assert.ok(existsSync(destination), `${path.relative(root, file)}: missing link target ${href}`);
            if (hash && statSync(destination).isFile() && destination.endsWith('.md')) {
                assert.ok(document(destination).anchors.has(decodeURIComponent(hash)),
                    `${path.relative(root, file)}: missing anchor ${href}`);
            }
            links++;
        }
        const lines = source.split('\n');
        const offsets = [];
        let offset = 0;
        for (const line of lines) {
            offsets.push(offset);
            offset += line.length + 1;
        }
        const markers = new Set(tokens.filter(token => token.type === 'html_block' && token.content.startsWith('<!-- example:'))
            .map(token => offsets[token.map[0]]));
        const examples = [...source.matchAll(/<!-- example: ([^\n]+) -->\n```ts\n([\s\S]*?)\n```\n<!-- \/example -->/g)]
            .filter(match => markers.has(match.index));
        assert.equal(examples.length, markers.size,
            `${path.relative(root, file)}: malformed example marker`);
        for (const match of examples) {
            const examplePath = path.resolve(root, match[1]);
            assert.ok(existsSync(examplePath), `Missing example ${match[1]}`);
            assert.equal(match[2], readFileSync(examplePath, 'utf8').replace(/\r\n/g, '\n').trimEnd(),
                `${path.relative(root, file)}: example drift in ${match[1]}`);
            const name = path.basename(examplePath);
            seenExamples.add(name);
            if (expected[name]) {
                const rest = source.slice(match.index + match[0].length);
                const output = rest.match(/^\s*Expected output:\s*```json\n([\s\S]*?)\n```/);
                assert.ok(output, `${path.relative(root, file)}: missing expected output for ${name}`);
                assert.deepEqual(JSON.parse(output[1]), expected[name],
                    `${path.relative(root, file)}: output drift in ${name}`);
            }
        }
    }
    const exampleDirectory = path.join(root, 'examples', 'docs');
    for (const file of readdirSync(exampleDirectory).filter(file => file.endsWith('.ts'))) {
        assert.ok(seenExamples.has(file), `Example ${file} is not displayed in documentation`);
        assert.ok(['task-setup.ts', 'aws.ts'].includes(file) || expected[file],
            `Local script ${file} needs expected output and an execution test`);
    }
    const {version} = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.ok(document(path.join(root, 'docs', 'index.md')).source.includes(`package version **${version}**`),
        'Update the documentation version when changing package.json');
    return {files: files.length, links, examples: seenExamples.size};
}

module.exports = {checkDocs};
if (require.main === module) {
    checkDocs(path.resolve(__dirname, '..')).then(result => {
        console.log(`Documentation passed: ${result.files} pages, ${result.links} local links, ${result.examples} displayed examples.`);
    }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
