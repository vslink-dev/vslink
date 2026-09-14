'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
const start = source.indexOf('async function connectCurrentWorkspace(context) {');
const end = source.indexOf('\nfunction disconnect(', start);
assert.ok(start >= 0 && end > start);

async function main() {
    for (const choice of [undefined, 'Cancel', 'Connect']) {
        const events = [];
        const runtime = vm.createContext({
            client: undefined, reader: undefined,
            TOKEN_SECRET_KEY: 'token', PAIRED_RELAY_KEY: 'relay',
            resolveWorkspace: () => ({ identity: { name: 'Sample workspace', hash: 'sample' } }),
            updateWorkspaceState() {}, log() {},
            vscode: { window: {
                showInformationMessage: async (title, options, action) => {
                    assert.equal(title, 'Connect to VSLink?');
                    assert.equal(options.modal, true);
                    assert.equal(options.detail, 'View your Copilot chats from “Sample workspace” in VSLink. You can disconnect whenever you like.');
                    assert.equal(action, 'Connect');
                    events.push('confirmation');
                    return choice;
                },
                showWarningMessage() { throw new Error('Connect must not use warning styling'); }
            } },
            chatHistory_1: { ChatHistoryReader: class { start() { events.push('read'); } } },
            cloudClient_1: { CloudClient: class { start() { events.push('connect'); } } },
            require: name => { assert.equal(name, './newChat'); return { NativeChatStarter: class {} }; }
        });
        vm.runInContext(source.slice(start, end), runtime);
        await runtime.connectCurrentWorkspace({ secrets: { get: async () => 'fixture-token' }, globalState: { get: () => 'wss://fixture.invalid' } });
        assert.deepEqual(events, choice === 'Connect' ? ['confirmation', 'read', 'connect'] : ['confirmation']);
    }
    console.log('PASS connect dialog: informational styling, friendly wording, explicit Connect required; Cancel/dismiss do not read or connect');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
