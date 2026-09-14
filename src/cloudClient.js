"use strict";
const WebSocket = require("ws");
exports.RELAY_URL = 'wss://vscode-relay.tahiraziztaran.workers.dev/extension';
const MAX_INCOMING_BYTES = 256 * 1024;
const MAX_OUTGOING_BYTES = 5 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 25000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 15000];
const ALLOWED_COMMANDS = new Set([
    'get_inbox',
    'get_latest_reply',
    'get_instance_metadata',
    'get_chat_models',
    'send_chat',
    'start_chat',
    'send_and_wait'
]);
class CloudClient {
    constructor(log, workspace, token, callbacks, relayUrl = exports.RELAY_URL) {
        this.log = log;
        this.workspace = workspace;
        this.token = token;
        this.callbacks = callbacks;
        this.relayUrl = relayUrl;
        this.reconnectAttempt = 0;
        this.active = false;
        this.state = 'disconnected';
    }
    start() {
        if (this.active)
            return;
        this.active = true;
        this.reconnectAttempt = 0;
        this.open(false);
    }
    stop() {
        this.active = false;
        this.clearReconnect();
        this.stopHeartbeat();
        const socket = this.socket;
        this.socket = undefined;
        if (socket && socket.readyState !== WebSocket.CLOSED) {
            try {
                socket.close(1000, 'manual disconnect');
            }
            catch {
                socket.terminate();
            }
        }
        this.setState('disconnected');
    }
    get connected() {
        return this.state === 'connected';
    }
    sendInboxUpdate(inbox = this.callbacks.getInbox()) {
        if (!this.connected)
            return;
        this.send({ type: 'inbox_update', data: inbox, timestamp: Date.now() });
    }
    open(reconnecting) {
        if (!this.active)
            return;
        this.clearReconnect();
        this.setState(reconnecting ? 'reconnecting' : 'connecting');
        let socket;
        try {
            const url = new URL(this.relayUrl);
            // The current relay requires this during the WebSocket upgrade. TLS
            // protects it in transit and this extension never logs the full URL.
            // Server work will replace it with short-lived header authentication.
            url.searchParams.set('token', this.token);
            socket = new WebSocket(url, {
                headers: { Authorization: `Bearer ${this.token}` },
                handshakeTimeout: 15000,
                maxPayload: MAX_INCOMING_BYTES,
                perMessageDeflate: false,
                rejectUnauthorized: true
            });
        }
        catch (error) {
            this.log(`Connection setup failed: ${safeError(error)}`);
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        socket.on('open', () => {
            if (!this.active || this.socket !== socket) {
                socket.close(1000, 'inactive');
                return;
            }
            this.reconnectAttempt = 0;
            this.setState('connected');
            this.startHeartbeat();
            this.log('Connected securely to the VSLink relay.');
        });
        socket.on('message', (data, isBinary) => {
            if (isBinary) {
                this.log('Ignored an unexpected binary relay message.');
                return;
            }
            const buffer = rawDataBuffer(data);
            if (buffer.length > MAX_INCOMING_BYTES) {
                this.log('Closed relay connection after an oversized message.');
                socket.close(1009, 'message too large');
                return;
            }
            void this.handleMessage(buffer.toString('utf8'));
        });
        socket.on('unexpected-response', (_request, response) => {
            this.log(`Relay rejected the connection (HTTP ${response.statusCode || 'unknown'}).`);
            response.resume();
        });
        socket.on('error', error => {
            this.log(`Relay connection error: ${safeError(error)}`);
        });
        socket.on('close', code => {
            if (this.socket === socket)
                this.socket = undefined;
            this.stopHeartbeat();
            if (!this.active) {
                this.setState('disconnected');
                return;
            }
            this.log(`Relay connection closed (code ${code || 1006}); retrying while this session remains connected.`);
            this.scheduleReconnect();
        });
    }
    async handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        }
        catch {
            this.log('Ignored malformed relay JSON.');
            return;
        }
        if (!message || typeof message.type !== 'string')
            return;
        switch (message.type) {
            case 'request_registration':
                this.sendRegistration();
                return;
            case 'registration_confirmed':
                this.callbacks.onAccountInfo(safeOptionalString(message.userName), safeOptionalString(message.userEmail));
                this.sendInboxUpdate();
                return;
            case 'request_inbox':
                this.sendInboxUpdate();
                return;
            case 'ping':
                this.send({ type: 'pong', timestamp: Date.now() });
                return;
            case 'pong':
            case 'heartbeat_ack':
                return;
            case 'send_message': {
                const prompt = validPrompt(message.message);
                if (!prompt) {
                    this.log('Rejected an empty or oversized remote chat prompt.');
                    return;
                }
                await this.runRequest(undefined, () => this.callbacks.sendChat(prompt));
                return;
            }
            case 'execute_command':
                await this.handleCommand(message);
                return;
            default:
                this.log(`Ignored unsupported relay message type: ${safeLogValue(message.type)}`);
        }
    }
    async handleCommand(message) {
        const command = typeof message.command === 'string' ? message.command : '';
        const requestId = validRequestId(message.requestId);
        if (!ALLOWED_COMMANDS.has(command)) {
            this.log(`Blocked unsupported remote command: ${safeLogValue(command || '(missing)')}`);
            this.respond(requestId, { error: 'This VSLink edition only allows Copilot chat.' });
            return;
        }
        await this.runRequest(requestId, async () => {
            switch (command) {
                case 'get_inbox':
                case 'get_latest_reply': {
                    const inbox = this.callbacks.getInbox();
                    if (command === 'get_inbox')
                        this.sendInboxUpdate(inbox);
                    return inbox;
                }
                case 'get_instance_metadata':
                    return {
                        success: true,
                        instance: this.instanceMetadata(),
                        instances: [this.instanceMetadata()]
                    };
                case 'get_chat_models':
                    return { success: true, models: [], note: 'VSLink uses the active model in VS Code Copilot Chat.' };
                case 'start_chat':
                case 'send_chat': {
                    const prompt = validPrompt(message.data?.message);
                    if (!prompt)
                        return { error: 'A chat message between 1 and 20000 characters is required.' };
                    return command === 'start_chat' ? this.callbacks.startChat(prompt) : this.callbacks.sendChat(prompt);
                }
                case 'send_and_wait': {
                    const prompt = validPrompt(message.data?.message);
                    if (!prompt)
                        return { error: 'A chat message between 1 and 20000 characters is required.' };
                    return this.callbacks.sendAndWait(prompt, safeWait(message.data?.maxWait));
                }
            }
            return { error: 'Unsupported command.' };
        });
    }
    async runRequest(requestId, action) {
        try {
            const result = await action();
            this.respond(requestId, result);
        }
        catch (error) {
            const detail = safeError(error);
            this.log(`Chat request failed: ${detail}`);
            this.respond(requestId, { error: detail, ...(error.delivery === 'not_submitted' ? { delivery: 'not_submitted' } : {}) });
        }
    }
    respond(requestId, data) {
        if (requestId === undefined)
            return;
        this.send({ type: 'proxy_response', requestId, data, timestamp: Date.now() });
    }
    sendRegistration() {
        this.send({
            type: 'register_extension',
            instanceId: this.workspace.hash,
            workspaceHash: this.workspace.hash,
            workspaceName: this.workspace.name,
            workspacePath: '',
            linkToken: this.token,
            alwaysConnected: false,
            timestamp: Date.now()
        });
    }
    instanceMetadata() {
        return {
            id: this.workspace.hash,
            instanceId: this.workspace.hash,
            workspaceHash: this.workspace.hash,
            workspaceName: this.workspace.name,
            workspacePath: '',
            connected: this.connected,
            alwaysConnected: false,
            recentProjects: []
        };
    }
    send(payload) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
            return false;
        try {
            const encoded = JSON.stringify(payload);
            if (Buffer.byteLength(encoded) > MAX_OUTGOING_BYTES) {
                this.log('Blocked an oversized outbound relay message.');
                return false;
            }
            this.socket.send(encoded);
            return true;
        }
        catch (error) {
            this.log(`Relay send failed: ${safeError(error)}`);
            return false;
        }
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeat = setInterval(() => {
            this.send({ type: 'heartbeat', timestamp: Date.now() });
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeat.unref?.();
    }
    stopHeartbeat() {
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.heartbeat = undefined;
    }
    scheduleReconnect() {
        if (!this.active || this.reconnectTimer)
            return;
        this.setState('reconnecting');
        const index = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
        const delay = RECONNECT_DELAYS_MS[index];
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.open(true);
        }, delay);
        this.reconnectTimer.unref?.();
    }
    clearReconnect() {
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
    }
    setState(state) {
        if (this.state === state)
            return;
        this.state = state;
        this.callbacks.onStateChange(state);
    }
}
exports.CloudClient = CloudClient;
function validPrompt(value) {
    if (typeof value !== 'string')
        return undefined;
    const prompt = value.trim();
    return prompt && prompt.length <= 20000 ? prompt : undefined;
}
function validRequestId(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function safeWait(value) {
    const wait = Number(value);
    if (!Number.isFinite(wait))
        return undefined;
    return Math.min(Math.max(Math.floor(wait), 5000), 180000);
}
function safeOptionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
}
function safeLogValue(value) {
    return value.replace(/[\r\n\t]/g, ' ').slice(0, 120);
}
function safeError(error) {
    return error instanceof Error ? safeLogValue(error.message) : safeLogValue(String(error));
}
function rawDataBuffer(data) {
    if (Array.isArray(data))
        return Buffer.concat(data);
    if (data instanceof ArrayBuffer)
        return Buffer.from(data);
    return Buffer.from(data);
}
