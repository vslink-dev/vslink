'use strict';
// Isolated UI fixture: never reads account state, connects to a relay, or runs VS Code commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const modulePath = path.join(__dirname, '../src/sidebar.js');
const events = [];
const mockVSCode = {
    EventEmitter: class { constructor() { this.event = () => {}; } fire(value) { events.push(value); } dispose() {} }
};
const moduleContext = vm.createContext({ exports: {}, require: name => {
    if (name === 'vscode') return mockVSCode;
    if (name === 'crypto') return require('node:crypto');
    throw new Error('Unexpected dependency: ' + name);
} });
vm.runInContext(fs.readFileSync(modulePath, 'utf8'), moduleContext);
const { SidebarProvider } = moduleContext.exports;
const fixture = { linked: true, accountName: 'Alex Morgan', accountEmail: null, connection: 'connected', eligible: true,
    eligibilityMessage: 'One trusted local workspace.', workspaceName: 'PRIVATE-WORKSPACE-NAME', version: '1.1.0' };
function htmlFor(state) { return new SidebarProvider(state).html(); }

function test() {
    const html = htmlFor(fixture);
    assert.ok(!html.includes(fixture.workspaceName), 'workspace identity is not included even in initial webview state');
    assert.doesNotMatch(html, /id="workspace"|class="card notice"|Show connection log/);
    assert.match(html, /<details class="options">/);
    assert.doesNotMatch(html, /<h1|<img|class="brand"|class="eyebrow"|img-src/);
    assert.match(html, /body \{ margin: 0; padding: 0;/, 'override VS Code webview default 20px body padding');
    assert.match(html, /padding: 10px 6px;/, 'one shared six-pixel inset covers headings, cards, disclosure and footer');
    assert.match(html, /id="accountHeading">Account/);
    assert.match(html, /id="connectionHeading">Connection/);
    assert.match(html, /<summary>What Connect shares<\/summary>/);
    const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
        textContent: '', dataset: {}, hidden: false, disabled: false, listeners: {},
        addEventListener(type, listener) { this.listeners[type] = listener; },
        toggleAttribute(name, value) { this[name] = value; }
    }]));
    let onState;
    const actions = [];
    const browser = vm.createContext({ acquireVsCodeApi: () => ({ postMessage: data => actions.push(data.action) }),
        document: { getElementById: id => { assert.ok(nodes.has(id), id); return nodes.get(id); } },
        window: { addEventListener: (type, listener) => { assert.equal(type, 'message'); onState = listener; } } });
    vm.runInContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], browser);
    assert.equal(nodes.get('statusText').textContent, 'Connected');
    assert.equal(nodes.get('primaryText').textContent, 'Disconnect');
    assert.equal(nodes.get('link').disabled, true);
    assert.equal(nodes.get('setupNote').hidden, true);
    assert.equal(nodes.get('accountName').textContent, fixture.accountName);
    assert.equal(nodes.get('accountDetail').textContent, 'Paired with this editor');
    assert.equal(nodes.get('version').textContent, 'v1.1.0');
    nodes.get('primary').listeners.click();
    assert.deepEqual(actions, ['disconnect']);
    onState({ data: { type: 'state', state: { ...fixture, connection: 'disconnected' } } });
    assert.equal(nodes.get('primaryText').textContent, 'Connect');
    assert.equal(nodes.get('link').disabled, false);
    nodes.get('primary').listeners.click();
    nodes.get('link').listeners.click();
    nodes.get('log').listeners.click();
    assert.deepEqual(actions, ['disconnect', 'connect', 'unlink', 'showLog']);
    onState({ data: { type: 'state', state: { ...fixture, connection: 'disconnected', linked: false } } });
    assert.equal(nodes.get('primaryText').textContent, 'Pair account');
    assert.equal(nodes.get('link').hidden, true);
    assert.equal(nodes.get('accountName').textContent, 'Not paired');
    nodes.get('primary').listeners.click();
    assert.equal(actions.at(-1), 'link');
    onState({ data: { type: 'state', state: { ...fixture, accountName: null } } });
    assert.equal(nodes.get('accountName').textContent, 'Account paired', 'an optional profile name is not required for pairing');
    onState({ data: { type: 'state', state: { ...fixture, accountName: '<img src=x onerror=alert(1)>' } } });
    assert.equal(nodes.get('accountName').textContent, '<img src=x onerror=alert(1)>', 'account names are displayed as text, never markup');
    onState({ data: { type: 'state', state: { ...fixture, connection: 'disconnected', eligible: false, eligibilityMessage: 'Trust this workspace before connecting.' } } });
    assert.equal(nodes.get('primary').disabled, true);
    assert.equal(nodes.get('setupNote').hidden, false);
    assert.match(nodes.get('setupNote').textContent, /Trust this workspace/);
    assert.throws(() => onState({ data: { type: 'state', state: { ...fixture, connection: 'invalid' } } }), /Unexpected VSLink connection state/);
    assert.equal(nodes.get('statusText').textContent, 'Connection unavailable');
    assert.equal(nodes.get('primary').disabled, true);
    const provider = new SidebarProvider(fixture);
    let receive;
    let posted;
    provider.resolveWebviewView({ webview: { onDidReceiveMessage: listener => { receive = listener; }, postMessage: data => { posted = data; } } });
    assert.equal(provider.view.webview.options.localResourceRoots.length, 0, 'sidebar needs no local assets');
    receive({ action: 'connect' }); receive({ action: 'unknown' });
    assert.deepEqual(events, ['connect']);
    provider.update({ workspaceName: 'ANOTHER-PRIVATE-NAME' });
    assert.ok(!JSON.stringify(posted).includes('PRIVATE-NAME'));
    assert.equal(posted.state.accountName, fixture.accountName);
    assert.ok(!Object.hasOwn(posted.state, 'accountEmail'));
    provider.update({ linked: false });
    assert.equal(posted.state.accountName, null);
    console.log('PASS sidebar: no workspace metadata, connection states/actions, conditional setup guidance, disclosure, safe unknown-state error');
}
test();
