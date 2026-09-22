'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
const token = 'b'.repeat(64);
const workspace = { identity: { name: 'Fixture', hash: 'workspace123', storageRoot: '/fixture' } };
function setup({ response = { token, userName: 'Person', userEmail: 'person@example.test' }, failMetadata = false, changeWorkspace = false } = {}) {
    const events = [], errors = [];
    let requests = 0;
    const transport = { request: (endpoint, options, onResponse) => {
        assert.equal(endpoint.origin, 'http://localhost:8080');
        assert.equal(options.method, 'POST');
        const request = new EventEmitter();
        request.end = body => {
            assert.equal(JSON.parse(body).workspacePath, '');
            requests++;
            setImmediate(() => {
                if (changeWorkspace) runtime.resolveWorkspace = () => ({ identity: { ...workspace.identity, hash: 'changed' } });
                const result = new EventEmitter(); result.statusCode = 200;
                onResponse(result);
                result.emit('data', Buffer.from(typeof response === 'string' ? response : JSON.stringify(response)));
                result.emit('end');
            });
        };
        return request;
    } };
    const runtime = vm.createContext({ exports: {}, URL, URLSearchParams, Buffer, Error,
        require: name => {
            if (['http', 'https'].includes(name)) return transport;
            if (name === 'vscode') return { window: { showInformationMessage: async (_message, _options, action) => action === 'Pair' ? 'Pair' : undefined, showErrorMessage: async message => errors.push(message) } };
            if (name === './linking') return require('../src/linking');
            if (name.startsWith('./')) return {};
            return require(name);
        }
    });
    vm.runInContext(source, runtime);
    runtime.resolveWorkspace = () => workspace;
    const state = new Map();
    const context = {
        secrets: { delete: async () => events.push('delete-token'), store: async (_key, value) => { assert.equal(value, token); events.push('store-token'); } },
        globalState: { update: async (key, value) => {
            events.push(key);
            if (failMetadata && key === 'vslink.pairedRelayUrl') throw new Error('metadata storage failure');
            state.set(key, value);
        } }
    };
    const uri = { path: '/link', query: new URLSearchParams({ code: 'ABC123', backend: 'http://localhost:8080', server: 'ws://localhost:8080/extension' }).toString() };
    return { runtime, context, uri, events, errors, state, requests: () => requests };
}
async function main() {
    const success = setup();
    await success.runtime.handleUri(success.context, success.uri);
    assert.equal(success.errors.length, 0);
    assert.equal(success.events.at(-1), 'store-token', 'credential becomes usable only after all pairing metadata is saved');
    assert.equal(success.state.get('vslink.pairedRelayUrl'), 'ws://localhost:8080/extension');
    const failure = setup({ failMetadata: true });
    await failure.runtime.handleUri(failure.context, failure.uri);
    assert.match(failure.errors[0], /metadata storage failure/);
    assert.equal(failure.events.includes('store-token'), false);
    const changed = setup({ changeWorkspace: true });
    await changed.runtime.handleUri(changed.context, changed.uri);
    assert.match(changed.errors[0], /Workspace changed/);
    assert.deepEqual(changed.events, [], 'workspace change during exchange never saves a credential');
    for (const response of ['not JSON', { token, userName: { invalid: true } }, { token: 'invalid' }]) {
        const bad = setup({ response });
        await bad.runtime.handleUri(bad.context, bad.uri);
        assert.equal(bad.errors.length, 1);
        assert.equal(bad.events.includes('store-token'), false);
    }
    const url = setup(); url.uri.query = 'code=ABC123&backend=bad&server=bad';
    await url.runtime.handleUri(url.context, url.uri);
    assert.equal(url.requests(), 0, 'invalid endpoint never exchanges code with another server');
    assert.equal(url.errors.length, 1);
    console.log('PASS pairing flow: credential-last writes, invalid server responses, workspace changes, explicit endpoint errors');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
