"use strict";
const fs = require("fs");
const path = require("path");
const sessionParser_1 = require("./sessionParser");
const POLL_INTERVAL_MS = 1500;
const MAX_SESSION_FILE_BYTES = 4 * 1024 * 1024;
const MAX_INBOX_BYTES = 4 * 1024 * 1024;
class ChatHistoryReader {
    constructor(workspace) {
        this.workspace = workspace;
        this.fingerprint = '';
        this.sessionsPath = path.join(workspace.storageRoot, workspace.hash, 'chatSessions');
        this.inbox = this.emptyInbox();
    }
    start(onChange) {
        this.stop();
        this.onChange = onChange;
        this.refresh(true);
        this.timer = setInterval(() => this.refresh(false), POLL_INTERVAL_MS);
        this.timer.unref?.();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        this.onChange = undefined;
        this.fingerprint = '';
        this.inbox = this.emptyInbox();
    }
    current() {
        return this.inbox;
    }
    emptyInbox() {
        return {
            workspaceHash: this.workspace.hash,
            workspacePath: '',
            sessions: [],
            totalMessages: 0,
            lastUpdated: Date.now(),
            pagination: {
                totalSessions: 0,
                loadedSessions: 0,
                requestedLimit: null,
                hasMore: false,
                loadedAll: true
            }
        };
    }
    sessionFiles() {
        let entries;
        try {
            entries = fs.readdirSync(this.sessionsPath, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === 'ENOENT') return []; // No chats have been saved in this workspace yet.
            throw error;
        }
        const files = [];
        for (const entry of entries) {
            if (!entry.isFile() || (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')))
                continue;
            const filePath = path.join(this.sessionsPath, entry.name);
            const stat = fs.statSync(filePath);
            files.push({ path: filePath, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size });
        }
        return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    }
    refresh(force) {
        try {
            this.refreshFromStorage(force);
        } catch (error) {
            this.fingerprint = '';
            this.inbox = { ...this.emptyInbox(), error: `Cannot read Copilot chat: ${error.message}` };
            this.onChange?.(this.inbox);
        }
    }
    refreshFromStorage(force) {
        const files = this.sessionFiles();
        const nextFingerprint = files.length
            ? files.map(file => `${file.name}:${file.mtimeMs}:${file.size}`).join('|')
            : 'empty';
        if (!force && nextFingerprint === this.fingerprint)
            return;
        if (!files.length) {
            this.fingerprint = nextFingerprint;
            this.inbox = this.emptyInbox();
            this.onChange?.(this.inbox);
            return;
        }
        const sessions = [];
        for (const file of files) {
            if (file.size <= 0 || file.size > MAX_SESSION_FILE_BYTES)
                throw new Error(`Copilot session "${file.name}" is empty or exceeds the 4 MB read limit.`);
            const content = fs.readFileSync(file.path, 'utf8');
            const extension = file.name.endsWith('.jsonl') ? '.jsonl' : '.json';
            const sessionId = file.name.replace(/\.(jsonl|json)$/i, '');
            const parsed = (0, sessionParser_1.parseSessionContent)(content, extension, sessionId);
            // Valid drafts with no visible messages are not conversations. Read/parse
            // errors must still stop the scan, never substitute an older conversation.
            if (!parsed) continue;
            sessions.push({ ...parsed, sessionId, storageFormat: extension === '.jsonl' ? 'jsonl' : 'json', filePath: '' });
        }
        const inbox = {
                workspaceHash: this.workspace.hash,
                workspacePath: '',
                sessions,
                totalMessages: sessions.reduce((total, session) => total + session.messageCount, 0),
                lastUpdated: Date.now(),
                pagination: {
                    totalSessions: sessions.length,
                    loadedSessions: sessions.length,
                    requestedLimit: null,
                    hasMore: false,
                    loadedAll: true
                }
            };
        if (Buffer.byteLength(JSON.stringify(inbox), 'utf8') > MAX_INBOX_BYTES)
            throw new Error('Copilot history exceeds the 4 MB relay history limit. VSLink needs paginated history support for this workspace; no partial history was sent.');
        this.fingerprint = nextFingerprint;
        this.inbox = inbox;
        this.onChange?.(this.inbox);
    }
}
exports.ChatHistoryReader = ChatHistoryReader;
