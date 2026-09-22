'use strict';

// These native command contracts are verified against VS Code 1.137.0.
// Neither command returns a delivery receipt: wait for a newly stored prompt.
const OPEN_CHAT_COMMAND = 'workbench.action.chat.open';
const NEW_CHAT_COMMAND = 'workbench.action.chat.newLocalChat';
const users = session => session.messages.filter(message => message.role === 'user');
const marker = message => JSON.stringify([message.requestId, message.timestamp, message.text]);

class NativeChatStarter {
    constructor(vscode, history, isConnected, log, timeoutMs = 20000, pollMs = 500) {
        Object.assign(this, { vscode, history, isConnected, log, timeoutMs, pollMs });
        this.busy = false;
    }
    start(prompt) { return this.submit(prompt, true); }
    send(prompt) { return this.submit(prompt, false); }
    sendAndWait(prompt, maxWait = 60000) { return this.submit(prompt, false, maxWait); }
    read() {
        this.history.refresh(true);
        const inbox = this.history.current();
        if (inbox.error) throw this.history.lastError ?? new Error(inbox.error);
        return inbox;
    }
    async submit(prompt, newChat, maxWait) {
        if (this.busy) throw Object.assign(new Error('A Copilot request is already being created or confirmed. Wait before sending another prompt.'), { delivery: 'not_submitted' });
        this.busy = true;
        let requested = false;
        try {
            if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 20000) throw new Error('Enter a prompt between 1 and 20,000 characters.');
            if (maxWait !== undefined && (!Number.isSafeInteger(maxWait) || maxWait < 5000 || maxWait > 180000)) throw new Error('Reply wait must be an integer between 5000 and 180000 milliseconds.');
            const message = prompt.trim();
            const connection = this.isConnected();
            const checkConnection = () => {
                if (!connection || this.isConnected() !== connection) throw new Error('VSLink disconnected or its connection changed. Check Copilot Chat before retrying.');
            };
            checkConnection();
            const copilot = this.vscode.extensions.getExtension('GitHub.copilot-chat');
            if (!copilot) throw new Error('GitHub Copilot Chat is not installed.');
            if (!copilot.isActive) await copilot.activate();
            const commands = await this.vscode.commands.getCommands(true);
            for (const command of newChat ? [OPEN_CHAT_COMMAND, NEW_CHAT_COMMAND] : [OPEN_CHAT_COMMAND]) {
                if (!commands.includes(command)) throw new Error(`VS Code ${this.vscode.version}: required command "${command}" is unavailable. Open Copilot Chat and check that it is enabled.`);
            }
            const before = this.read();
            const previousUsers = new Map(before.sessions.map(session => [session.sessionId, users(session).map(marker)]));
            const existingIds = new Set(this.history.sessionFiles().map(file => file.name.replace(/\.(jsonl|json)$/i, '')));
            if (newChat) await this.vscode.commands.executeCommand(OPEN_CHAT_COMMAND); // Reveal only; no prompt in the old chat.
            checkConnection();
            requested = true;
            await this.vscode.commands.executeCommand(newChat ? NEW_CHAT_COMMAND : OPEN_CHAT_COMMAND,
                newChat ? { inputValue: message, isPartialQuery: false } : { query: message, isPartialQuery: false });
            this.log('Native Copilot request made; waiting for saved JSONL confirmation.');
            const deadline = Date.now() + this.timeoutMs;
            while (Date.now() < deadline) {
                checkConnection();
                const matches = [];
                for (const session of this.read().sessions) {
                    if (session.storageFormat !== 'jsonl' || (newChat && existingIds.has(session.sessionId))) continue;
                    const prompts = users(session);
                    const baseline = previousUsers.get(session.sessionId) ?? [];
                    if (newChat && prompts.length !== 1) continue;
                    if (!baseline.every((value, index) => prompts[index] && marker(prompts[index]) === value)) continue;
                    if (prompts.length === baseline.length + 1 && prompts.at(-1).text.trim() === message) {
                        matches.push({ session, user: prompts.at(-1), index: prompts.length - 1, prefix: prompts.map(marker) });
                    }
                }
                if (matches.length > 1) throw new Error('More than one Copilot session contains the new prompt. Delivery is ambiguous; check VS Code before retrying.');
                if (matches.length === 1) {
                    const receipt = matches[0];
                    this.log('Copilot prompt confirmed in workspace JSONL.');
                    if (maxWait !== undefined) return await this.waitForReply(receipt, maxWait, checkConnection);
                    return { success: true, submitted: true, sessionId: receipt.session.sessionId, source: 'jsonl' };
                }
                await new Promise(resolve => setTimeout(resolve, this.pollMs));
            }
            throw new Error(`VS Code did not confirm the ${newChat ? 'new chat' : 'prompt'} in JSONL within ${this.timeoutMs / 1000} seconds. Check Copilot Chat for sign-in or pending confirmation before retrying; the prompt was not sent again.`);
        } catch (error) {
            if (!requested) error.delivery = 'not_submitted';
            throw error;
        } finally {
            this.busy = false;
        }
    }
    async waitForReply(receipt, maxWait, checkConnection) {
        const deadline = Date.now() + maxWait;
        while (Date.now() < deadline) {
            checkConnection();
            const session = this.read().sessions.find(item => item.sessionId === receipt.session.sessionId);
            if (!session) throw new Error('The confirmed Copilot conversation is no longer available.');
            const prompts = users(session);
            if (prompts.length !== receipt.prefix.length || !receipt.prefix.every((value, index) => prompts[index] && marker(prompts[index]) === value)) {
                throw new Error('Copilot conversation changed while waiting. Check VS Code for the reply.');
            }
            const user = prompts[receipt.index];
            if (['error', 'canceled'].includes(user.responseStatus)) throw new Error(`Copilot response ${user.responseStatus}. Check Copilot Chat; the prompt was not sent again.`);
            const answer = session.messages[session.messages.indexOf(user) + 1];
            if (answer?.role === 'assistant') {
                if (answer.requestId !== user.requestId) throw new Error('Copilot reply does not match the submitted request.');
                if (answer.status !== 'complete') throw new Error(`Copilot response ${answer.status}. Check Copilot Chat; the prompt was not sent again.`);
                return { success: true, submitted: true, assistantReply: answer.text, sessionId: session.sessionId, status: answer.status };
            }
            if (user.responseStatus === 'complete') throw new Error('Copilot finished without a visible text answer. Check Copilot Chat for the result.');
            await new Promise(resolve => setTimeout(resolve, this.pollMs));
        }
        throw new Error('The prompt was confirmed, but Copilot did not finish within the reply timeout. Check VS Code before retrying.');
    }
}
module.exports = { NativeChatStarter, OPEN_CHAT_COMMAND, NEW_CHAT_COMMAND };
