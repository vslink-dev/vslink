'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const sockets = [];
class FakeSocket extends EventEmitter {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    constructor(url, options) { super(); Object.assign(this, { url, options, readyState: 0, sent: [] }); sockets.push(this); }
    send(raw, callback) { this.sent.push(JSON.parse(raw)); callback?.(this.sendError); }
    close() { this.readyState = 3; this.emit('close', 1000); }
    terminate() { this.readyState = 3; this.emit('close', 1006); }
    open() { this.readyState = 1; this.emit('open'); }
    message(data) { this.emit('message', Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)), false); }
}
const runtime = { exports: {}, URL, Buffer, Error, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'ws' ? FakeSocket : require(name === './linking' ? '../src/linking' : name) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/cloudClient.js'), 'utf8'), runtime);
const { CloudClient } = runtime.exports;
const token = 'a'.repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(url = 'ws://localhost:8080/extension') {
    const events = [], logs = [], failures = [];
    const client = new CloudClient(line => logs.push(line), { hash: 'workspace', name: 'Fixture' }, token, {
        getInbox: () => ({ sessions: [] }), onAccountInfo: async () => events.push('account'),
        onStateChange: state => events.push(state), onFailure: error => failures.push(error),
        sendChat: async () => { events.push('send'); return { success: true }; }
    }, url);
    return { client, events, logs, failures };
}
async function registered(target) {
    target.client.start();
    const socket = sockets.at(-1);
    socket.open();
    assert.equal(target.client.connected, false, 'open transport is not authenticated registration');
    socket.message({ type: 'request_registration' });
    assert.equal(socket.sent[0].type, 'register_extension');
    assert.equal(socket.sent[0].linkToken, token, 'credential remains in the registration body for local protocol compatibility');
    socket.message({ type: 'registration_confirmed', userName: 'Fixture' });
    await tick();
    assert.equal(target.client.connected, true);
    return socket;
}
async function main() {
    const good = setup();
    const socket = await registered(good);
    assert.equal(socket.url.search, '');
    assert.equal(socket.options.headers.Authorization, `Bearer ${token}`);
    assert.equal(socket.options.rejectUnauthorized, true);
    assert.match(good.logs.join('\n'), /unencrypted loopback/);
    assert.doesNotMatch(good.logs.join('\n'), new RegExp(token));
    assert.equal(socket.sent[1].type, 'inbox_update');
    socket.message({ type: 'execute_command', requestId: 1, command: 'send_chat', data: { message: 'Hello' } });
    await tick();
    assert.equal(good.events.filter(event => event === 'send').length, 1);
    socket.message({ type: 'execute_command', requestId: 2, command: 'get_chat_models' });
    await tick();
    assert.match(socket.sent.at(-1).data.error, /not supported/);
    good.client.stop();
    assert.equal(good.client.connected, false);
    assert.equal(good.client.registrationTimer, undefined);
    const preauth = setup();
    preauth.client.start(); sockets.at(-1).open();
    sockets.at(-1).message({ type: 'execute_command', requestId: 1, command: 'send_chat', data: { message: 'Do not run' } });
    await tick();
    assert.equal(preauth.events.includes('send'), false);
    assert.match(preauth.failures[0].message, /before registration/);
    assert.equal(preauth.client.active, false);
    const denied = setup();
    denied.client.start(); sockets.at(-1).open(); sockets.at(-1).message({ type: 'registration_denied' });
    await tick();
    assert.match(denied.failures[0].message, /denied/);
    assert.equal(denied.client.reconnectTimer, undefined);
    const malformed = setup();
    malformed.client.start(); sockets.at(-1).open(); sockets.at(-1).message('{bad json');
    await tick();
    assert.match(malformed.failures[0].message, /malformed JSON/);
    assert.ok(malformed.failures[0].cause, 'parse cause is preserved');
    const rejected = setup('wss://vscode-relay.tahiraziztaran.workers.dev/extension');
    rejected.client.start();
    const count = sockets.length;
    sockets.at(-1).emit('unexpected-response', {}, { statusCode: 401, resume() {} });
    assert.match(rejected.failures[0].message, /Authorization headers/);
    assert.equal(rejected.client.active, false);
    assert.equal(rejected.client.reconnectTimer, undefined);
    assert.equal(sockets.length, count, 'no URL-token retry');
    const badConfig = setup('wss://untrusted.example/extension');
    assert.throws(() => badConfig.client.start(), /Relay must/);
    assert.equal(badConfig.client.active, false);
    assert.equal(sockets.length, count);
    const tls = setup(); tls.client.start();
    const tlsCause = Object.assign(new Error('bad certificate'), { code: 'CERT_HAS_EXPIRED' });
    sockets.at(-1).emit('error', tlsCause);
    assert.equal(tls.failures[0].cause, tlsCause);
    assert.equal(tls.client.active, false);
    assert.equal(tls.client.reconnectTimer, undefined, 'invalid TLS never downgrades or retries authentication');
    const sendFailure = setup();
    const broken = await registered(sendFailure);
    const cause = new Error('send failed'); broken.sendError = cause;
    sendFailure.client.sendInboxUpdate();
    assert.equal(sendFailure.failures[0].cause, cause);
    assert.equal(sendFailure.client.active, false);
    const oversized = setup(); await registered(oversized);
    assert.throws(() => oversized.client.send({ body: 'x'.repeat(5 * 1024 * 1024) }), /size limit/);
    oversized.client.stop();
    assert.throws(() => oversized.client.send({}), /not open/);
    const dropped = setup(); const first = await registered(dropped);
    first.emit('close', 1006);
    assert.equal(dropped.client.state, 'reconnecting');
    assert.ok(dropped.client.reconnectTimer, 'transport reconnect only within active manual session');
    dropped.client.stop();
    assert.equal(dropped.client.reconnectTimer, undefined);
    console.log('PASS relay: header-only auth, no pre-registration data/actions, rejection/JSON/send failures, no auth fallback, manual-session reconnect');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
