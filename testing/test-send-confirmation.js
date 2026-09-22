'use strict';
const assert = require('node:assert/strict');
const { NativeChatStarter, OPEN_CHAT_COMMAND } = require('../src/newChat');
const user = (text, id) => ({ role: 'user', text, requestId: id, timestamp: 1, status: 'complete' });
const answer = (text, id, status = 'complete') => ({ role: 'assistant', text, requestId: id, status });
function setup(execute) {
    const inbox = { sessions: [{ sessionId: 'current', storageFormat: 'jsonl', messages: [user('Hello', 'old'), answer('Old answer', 'old')] }] };
    const history = { refresh() {}, current: () => inbox, sessionFiles: () => inbox.sessions.map(session => ({ name: `${session.sessionId}.jsonl` })) };
    let calls = 0;
    const vscode = { version: '1.137.0', extensions: { getExtension: () => ({ isActive: true }) }, commands: {
        getCommands: async () => [OPEN_CHAT_COMMAND], executeCommand: async (command, options) => {
            assert.equal(command, OPEN_CHAT_COMMAND);
            assert.deepEqual(options, { query: 'Hello', isPartialQuery: false });
            calls++;
            await execute(inbox);
        }
    } };
    const starter = new NativeChatStarter(vscode, history, () => true, () => {}, 60, 2);
    return { inbox, history, starter, calls: () => calls };
}
async function main() {
    const none = setup(async () => {});
    await assert.rejects(none.starter.send('Hello'), /did not confirm/);
    assert.equal(none.calls(), 1, 'void command completion and old identical prompt are not delivery confirmation');
    const delayed = setup(async inbox => { setTimeout(() => inbox.sessions[0].messages.push(user('Hello', 'new')), 15); });
    let settled = false;
    const pending = delayed.starter.send('Hello').then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(settled, false);
    await assert.rejects(delayed.starter.send('Hello'), error => error.delivery === 'not_submitted');
    assert.deepEqual(await pending, { success: true, submitted: true, sessionId: 'current', source: 'jsonl' });
    assert.equal(delayed.calls(), 1);
    const reply = setup(async inbox => {
        inbox.sessions.unshift({ sessionId: 'other', storageFormat: 'jsonl', messages: [user('Another prompt', 'other'), answer('WRONG ANSWER', 'other')] });
        inbox.sessions[1].messages.push(user('Hello', 'new'));
        setTimeout(() => inbox.sessions[1].messages.push(answer('Right answer', 'new')), 10);
    });
    const replying = reply.starter.sendAndWait('Hello', 5000);
    await assert.rejects(reply.starter.start('Hello'), /already/);
    assert.equal((await replying).assistantReply, 'Right answer', 'reply is correlated to the confirmed session/request, not newest file');
    const wrong = setup(async inbox => inbox.sessions[0].messages.push(user('Hello', 'new'), answer('Wrong', 'old')));
    await assert.rejects(wrong.starter.sendAndWait('Hello', 5000), /does not match/);
    for (const status of ['error', 'canceled']) {
        const failed = setup(async inbox => inbox.sessions[0].messages.push(user('Hello', 'new'), answer('Stopped', 'new', status)));
        await assert.rejects(failed.starter.sendAndWait('Hello', 5000), new RegExp(status));
    }
    const changed = setup(async inbox => { inbox.sessions[0].messages.push(user('Hello', 'new')); setTimeout(() => inbox.sessions[0].messages.push(user('Later', 'later')), 5); });
    await assert.rejects(changed.starter.sendAndWait('Hello', 5000), /conversation changed/);
    for (const responseStatus of ['error', 'canceled', 'complete']) {
        const empty = setup(async inbox => inbox.sessions[0].messages.push({ ...user('Hello', 'new'), responseStatus }));
        await assert.rejects(empty.starter.sendAndWait('Hello', 5000), new RegExp(responseStatus === 'complete' ? 'without a visible text answer' : responseStatus));
    }
    const ambiguous = setup(async inbox => {
        inbox.sessions[0].messages.push(user('Hello', 'new'));
        inbox.sessions.push({ sessionId: 'other', storageFormat: 'jsonl', messages: [user('Hello', 'new2')] });
    });
    await assert.rejects(ambiguous.starter.send('Hello'), /ambiguous/);
    const readError = setup(async () => {});
    readError.inbox.error = 'Storage failure';
    readError.history.lastError = new Error('Storage failure', { cause: new Error('original read error') });
    await assert.rejects(readError.starter.send('Hello'), error => error === readError.history.lastError && error.delivery === 'not_submitted');
    assert.equal(readError.calls(), 0);
    const reconnect = setup(async () => { reconnect.starter.isConnected = () => ({ different: true }); });
    await assert.rejects(reconnect.starter.send('Hello'), /connection changed/);
    const invalid = setup(async () => {});
    await assert.rejects(invalid.starter.sendAndWait('Hello', '5000'), error => /Reply wait/.test(error.message) && error.delivery === 'not_submitted');
    assert.equal(invalid.calls(), 0);
    console.log('PASS Send: delayed receipt, no stale success/replay, shared busy guard, reply correlation, canceled/error/ambiguous delivery and storage errors');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
