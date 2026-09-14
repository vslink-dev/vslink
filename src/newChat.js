'use strict';

// Reveal Chat without a query, then let New Local Chat create AND submit together.
// Its inputValue/isPartialQuery contract is verified against VS Code 1.137.0.
// Commands return no receipt, so only workspace JSONL can confirm submission.
const OPEN_CHAT_COMMAND = 'workbench.action.chat.open';
const NEW_CHAT_COMMAND = 'workbench.action.chat.newLocalChat';
class NativeChatStarter {
    constructor(vscode, history, isConnected, log, timeoutMs = 20000, pollMs = 500) {
        this.vscode = vscode;
        this.history = history;
        this.isConnected = isConnected;
        this.log = log;
        this.timeoutMs = timeoutMs;
        this.pollMs = pollMs;
        this.busy = false;
    }
    async start(prompt) {
        if (this.busy) throw new Error('A new Copilot chat is already being created. Wait for JSONL confirmation.');
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 20000) {
            throw new Error('Enter a prompt between 1 and 20,000 characters.');
        }
        this.busy = true;
        let requested = false;
        try {
            if (!this.isConnected()) throw new Error('VSLink is disconnected.');
            const copilot = this.vscode.extensions.getExtension('GitHub.copilot-chat');
            if (!copilot) throw new Error('GitHub Copilot Chat is not installed.');
            if (!copilot.isActive) await copilot.activate();
            const commands = await this.vscode.commands.getCommands(true);
            for (const command of [OPEN_CHAT_COMMAND, NEW_CHAT_COMMAND]) {
                if (!commands.includes(command)) {
                    throw new Error(`VSLink cannot start a local Copilot chat in VS Code ${this.vscode.version}: required command "${command}" is unavailable. Open Copilot Chat and check that it is enabled.`);
                }
            }
            const existingIds = new Set(this.history.sessionFiles().map(file => file.name.replace(/\.(jsonl|json)$/i, '')));
            const message = prompt.trim();
            // New Local Chat needs an existing chat widget to consume inputValue.
            // Never pass the prompt to Open Chat: that would submit to the old chat.
            await this.vscode.commands.executeCommand(OPEN_CHAT_COMMAND);
            if (!this.isConnected()) throw new Error('VSLink disconnected before creating the chat.');
            this.log(`Starting native New Local Chat in VS Code ${this.vscode.version}; waiting for workspace JSONL confirmation.`);
            requested = true;
            await this.vscode.commands.executeCommand(NEW_CHAT_COMMAND, { inputValue: message, isPartialQuery: false });
            const deadline = Date.now() + this.timeoutMs;
            while (Date.now() < deadline) {
                if (!this.isConnected()) throw new Error('VSLink disconnected after requesting the new chat. Check VS Code before retrying.');
                this.history.refresh(true);
                const inbox = this.history.current();
                if (inbox.error) throw new Error(inbox.error);
                const session = inbox.sessions.find(candidate => candidate.storageFormat === 'jsonl' &&
                    !existingIds.has(candidate.sessionId) && candidate.messages.find(item => item.role === 'user')?.text.trim() === message);
                if (session) {
                    this.log('New Copilot chat confirmed in workspace JSONL.');
                    return { success: true, submitted: true, sessionId: session.sessionId, source: 'jsonl' };
                }
                await new Promise(resolve => setTimeout(resolve, this.pollMs));
            }
            throw new Error(`VS Code did not confirm the new chat in JSONL within ${this.timeoutMs / 1000} seconds. Check Copilot Chat for sign-in or pending confirmation before retrying; the prompt was not sent again.`);
        } catch (error) {
            if (!requested) error.delivery = 'not_submitted';
            throw error;
        } finally {
            this.busy = false;
        }
    }
}
module.exports = { NativeChatStarter, OPEN_CHAT_COMMAND, NEW_CHAT_COMMAND };
