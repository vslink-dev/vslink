'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeChatStarter, OPEN_CHAT_COMMAND, NEW_CHAT_COMMAND } = require('../src/newChat');
const { ChatHistoryReader } = require('../src/chatHistory');
const { parseSessionContent } = require('../src/sessionParser');
const { CloudClient } = require('../src/cloudClient');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vslink-new-chat-test-'));
const folder = path.join(root, 'workspace', 'chatSessions');
fs.mkdirSync(folder, { recursive: true });
function save(name, text, date) {
    const data = { creationDate: Date.now(), requests: [{ message: { text }, timestamp: Date.now() }] };
    const file = path.join(folder, name);
    fs.writeFileSync(file, JSON.stringify({ kind: 0, v: data }) + '\n');
    fs.utimesSync(file, date, date);
}
function saveDraft(name, date) {
    const file = path.join(folder, name);
    fs.writeFileSync(file, JSON.stringify({ kind: 0, v: { requests: [] } }) + '\n');
    fs.utimesSync(file, date, date);
}
async function main() {
    save('old.jsonl', 'Same prompt', new Date(Date.now() - 10000));
    const reader = new ChatHistoryReader({ storageRoot: root, hash: 'workspace' });
    reader.refresh(true);
    assert.equal(reader.current().sessions[0].sessionId, 'old');
    saveDraft('empty-draft.jsonl', new Date());
    reader.refresh(false);
    assert.equal(reader.current().error, undefined);
    assert.equal(reader.current().sessions[0]?.sessionId, 'old', 'a valid empty draft is not a conversation and must not hide the latest conversation');
    let calls = 0;
    let reveals = 0;
    assert.equal(NEW_CHAT_COMMAND, 'workbench.action.chat.newLocalChat');
    const vscode = {
        version: '1.137.0',
        extensions: { getExtension: () => ({ isActive: true }) },
        commands: { getCommands: async () => [OPEN_CHAT_COMMAND, NEW_CHAT_COMMAND], executeCommand: async (command, options) => {
            if (command === OPEN_CHAT_COMMAND) {
                assert.equal(options, undefined, 'reveal must never send into the existing conversation');
                reveals++;
                return;
            }
            assert.equal(command, NEW_CHAT_COMMAND);
            assert.deepEqual(options, { inputValue: 'Same prompt', isPartialQuery: false });
            assert.equal(reveals, 1, 'Chat is revealed before New Local Chat so its widget can consume the prompt');
            calls++;
            saveDraft('native-new.jsonl', new Date());
            reader.refresh(true);
            assert.equal(reader.current().sessions[0]?.sessionId, 'old', 'a newly created draft must wait for its first visible prompt');
            setTimeout(() => {
                save('native-new.jsonl', 'Same prompt', new Date());
                const newerDate = new Date(Date.now() + 500);
                fs.utimesSync(path.join(folder, 'old.jsonl'), newerDate, newerDate);
            }, 30);
        } }
    };
    const starter = new NativeChatStarter(vscode, reader, () => true, () => {}, 1000, 5);
    const request = starter.start('Same prompt');
    await assert.rejects(starter.start('Same prompt'), /already being created/);
    const result = await request;
    assert.deepEqual(result, { success: true, submitted: true, sessionId: 'native-new', source: 'jsonl' });
    assert.deepEqual(reader.current().sessions.map(session => session.sessionId), ['old', 'native-new'], 'new chat confirmation works even when an earlier conversation has a newer file timestamp');
    assert.equal(reader.current().totalMessages, 2, 'both conversations remain in the inbox');
    assert.equal(reader.current().pagination.totalSessions, 2);
    assert.equal(reader.current().sessions[0].messages[0].text, 'Same prompt', 'original messages remain intact');
    assert.equal(calls, 1);
    assert.equal(starter.busy, false);
    vscode.commands.executeCommand = async command => { if (command === NEW_CHAT_COMMAND) calls++; };
    starter.timeoutMs = 25;
    await assert.rejects(starter.start('Same prompt'), /did not confirm/);
    assert.equal(calls, 2, 'an existing identical prompt is not a new-session confirmation; no resend');
    vscode.commands.getCommands = async () => [];
    await assert.rejects(starter.start('Same prompt'), error => /required command.*unavailable/.test(error.message) && error.delivery === 'not_submitted');
    assert.equal(calls, 2, 'missing command does not fall back to current chat');
    vscode.commands.getCommands = async () => [OPEN_CHAT_COMMAND, NEW_CHAT_COMMAND];
    const revealCause = new Error('Chat view could not open');
    vscode.commands.executeCommand = async command => {
        assert.equal(command, OPEN_CHAT_COMMAND, 'failed reveal must prevent prompt submission');
        throw revealCause;
    };
    await assert.rejects(starter.start('Same prompt'), error => error === revealCause && error.delivery === 'not_submitted');
    const cause = new Error('Native action failed');
    vscode.commands.executeCommand = async command => { if (command === NEW_CHAT_COMMAND) throw cause; };
    await assert.rejects(starter.start('Same prompt'), error => error === cause && error.delivery === undefined);
    starter.isConnected = () => false;
    await assert.rejects(starter.start('Same prompt'), /disconnected/);
    assert.throws(() => parseSessionContent('{"kind":0,', '.jsonl', 'bad'), /incomplete/);
    fs.writeFileSync(path.join(folder, 'broken.jsonl'), '{"kind":0,');
    fs.utimesSync(path.join(folder, 'broken.jsonl'), new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    reader.refresh(true);
    assert.match(reader.current().error, /incomplete/);
    assert.equal(reader.current().sessions.length, 0, 'read failure never returns an older chat as success');
    fs.utimesSync(path.join(folder, 'broken.jsonl'), new Date(1000), new Date(1000));
    reader.refresh(true);
    assert.match(reader.current().error, /incomplete/);
    assert.equal(reader.current().sessions.length, 0, 'a broken older conversation is not silently omitted from history');
    fs.writeFileSync(path.join(folder, 'broken.jsonl'), '');
    reader.refresh(true);
    assert.match(reader.current().error, /empty/);
    assert.equal(reader.current().sessions.length, 0, 'a zero-byte file is a read error, not a valid empty draft');
    const draftRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vslink-empty-draft-test-'));
    const draftFolder = path.join(draftRoot, 'workspace', 'chatSessions');
    fs.mkdirSync(draftFolder, { recursive: true });
    fs.writeFileSync(path.join(draftFolder, 'empty.jsonl'), JSON.stringify({ kind: 0, v: { requests: [] } }) + '\n');
    const draftReader = new ChatHistoryReader({ storageRoot: draftRoot, hash: 'workspace' });
    draftReader.refresh(true);
    assert.equal(draftReader.current().error, undefined);
    assert.deepEqual(draftReader.current().sessions, [], 'only valid empty drafts means there are no conversations yet');
    const largeData = JSON.stringify({ kind: 0, v: { requests: Array.from({ length: 10 }, () => ({ message: { text: 'x'.repeat(90000) } })) } }) + '\n';
    for (let index = 0; index < 5; index++) fs.writeFileSync(path.join(draftFolder, 'large-' + index + '.jsonl'), largeData);
    draftReader.refresh(true);
    assert.match(draftReader.current().error, /exceeds the 4 MB relay history limit/);
    assert.equal(draftReader.current().sessions.length, 0, 'oversized history fails visibly without partial success');
    let starts = 0;
    const replies = [];
    const client = new CloudClient(() => {}, { hash: 'workspace', name: 'Fixture' }, 'fixture-token', {
        startChat: async prompt => { starts++; assert.equal(prompt, 'Hello'); return result; }
    });
    client.respond = (id, data) => replies.push({ id, data });
    await client.handleCommand({ command: 'start_chat', requestId: 7, data: { message: 'Hello' } });
    assert.equal(starts, 1);
    assert.deepEqual(replies[0], { id: 7, data: result });
    await client.handleCommand({ command: 'start_chat', requestId: 8, data: { message: '' } });
    assert.equal(starts, 1);
    assert.match(replies[1].data.error, /20000/);
    client.callbacks.startChat = async () => { throw revealCause; };
    await client.handleCommand({ command: 'start_chat', requestId: 9, data: { message: 'Hello' } });
    assert.deepEqual(replies[2], { id: 9, data: { error: revealCause.message, delivery: 'not_submitted' } });
    client.callbacks.startChat = async () => { throw cause; };
    await client.handleCommand({ command: 'start_chat', requestId: 10, data: { message: 'Hello' } });
    assert.deepEqual(replies[3], { id: 10, data: { error: cause.message } }, 'uncertain native failures must not claim non-delivery');
    console.log('PASS native New Chat: valid empty drafts, delayed JSONL, exact native ID, no stale success, duplicate prevention, command errors, disconnect, timeout, allowlist');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
