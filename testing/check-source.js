'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'vslink-copilot');
assert.equal(manifest.version, '1.1.0');
assert.equal(manifest.main, './src/extension.js');
assert.equal(manifest.__metadata, undefined);
assert.equal(manifest.engines.vscode, '^1.137.0');
assert.equal(manifest.pricing, 'Free');
assert.match(manifest.description, /Paid VSLink subscription required; no free trial/);
assert.equal(manifest.repository.url, 'https://github.com/vslink-dev/vslink');
assert.equal(manifest.bugs.url, 'https://github.com/vslink-dev/vslink/issues');
assert.deepEqual(manifest.dependencies, { ws: '8.21.3' });
for (const asset of [manifest.main, manifest.icon, manifest.readme, 'LICENSE.txt',
    ...manifest.contributes.viewsContainers.activitybar.map(view => view.icon)]) {
    const absolute = path.resolve(root, asset);
    assert.ok(absolute.startsWith(root + path.sep), 'Asset must be inside this project: ' + asset);
    assert.ok(fs.statSync(absolute).isFile(), 'Missing required file: ' + asset);
}
for (const folder of ['src', 'testing']) {
    for (const name of fs.readdirSync(path.join(root, folder))) {
        assert.ok(name.endsWith('.js'), 'Unexpected source file: ' + name);
        const file = path.join(root, folder, name);
        execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
        if (folder === 'src') {
            const source = fs.readFileSync(file, 'utf8');
            assert.doesNotMatch(source, /__importStar|__importDefault|sourceMappingURL/);
            for (const [, dependency] of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
                const imported = path.resolve(path.dirname(file), dependency + '.js');
                assert.ok(imported.startsWith(path.join(root, 'src') + path.sep));
                assert.ok(fs.statSync(imported).isFile(), 'Missing module: ' + dependency);
            }
        }
    }
}
console.log('PASS source project: syntax, manifest, icons, local modules, no compiler helpers or missing source maps');
