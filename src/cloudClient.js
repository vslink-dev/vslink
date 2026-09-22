"use strict";
const WebSocket = require("ws");
const { validateRelayUrl } = require('./linking');
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
    constructor(log, workspace, token, callbacks, relayUrl) {
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
        this.relayUrl = validateRelayUrl(this.relayUrl);
        if (typeof this.token !== 'string' || !/^[a-fA-F0-9]{64}$/.test(this.token))
            throw new Error('Saved VSLink credential is invalid. Unpair this editor and pair again.');
        this.active = true;
        this.reconnectAttempt = 0;
        this.open(false);
    }
    stop() {
        this.active = false;
        this.clearReconnect();
        this.stopHeartbeat();
        this.clearRegistration();
        const socket = this.socket;
        this.socket = undefined;
        if (socket && socket.readyState !== WebSocket.CLOSED) {
            if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
            else socket.close(1000, 'manual disconnect');
        }
        this.setState('disconnected');
    }
    get connected() {
        return this.state === 'connected';
    }
    sendInboxUpdate(inbox = this.callbacks.getInbox()) {
        if (!this.connected)
            return;
        try { this.send({ type: 'inbox_update', data: inbox, timestamp: Date.now() }); }
        catch (error) { this.fail(error); }
    }
    open(reconnecting) {
        if (!this.active)
            return;
        this.clearReconnect();
        this.setState(reconnecting ? 'reconnecting' : 'connecting');
        let socket;
        try {
            const url = new URL(this.relayUrl);
            // Credentials never go in URLs. Production workers must accept this
            // header before deploying this extension; rejection is not retried via a URL token.
            socket = new WebSocket(url, {
                headers: { Authorization: `Bearer ${this.token}` },
                handshakeTimeout: 15000,
                maxPayload: MAX_INCOMING_BYTES,
                perMessageDeflate: false,
                rejectUnauthorized: true
            });
        }
        catch (error) {
            this.fail(new Error('Connection setup failed. Check the saved relay address.', { cause: error }));
            return;
        }
        this.socket = socket;
        this.registrationSent = false;
        this.registrationPending = false;
        socket.on('open', () => {
            if (!this.active || this.socket !== socket) {
                socket.close(1000, 'inactive');
                return;
            }
            this.registrationTimer = setTimeout(() => {
                if (this.socket === socket) this.fail(new Error('Relay registration timed out. Check server authentication and pair again.'));
            }, 15000);
            this.registrationTimer.unref?.();
        });
        socket.on('message', (data, isBinary) => {
            if (!this.active || this.socket !== socket) return;
            if (isBinary) {
                this.fail(new Error('Relay sent an unsupported binary message.'));
                return;
            }
            const buffer = rawDataBuffer(data);
            if (buffer.length > MAX_INCOMING_BYTES) {
                this.fail(new Error('Relay message exceeds the size limit.'));
                return;
            }
            void this.handleMessage(buffer.toString('utf8'), socket).catch(error => {
                if (this.socket === socket) this.fail(error);
            });
        });
        socket.on('unexpected-response', (_request, response) => {
            response.resume();
            if (this.socket === socket) this.fail(new Error(`Relay rejected the connection (HTTP ${response.statusCode}). Check pairing and ensure the worker accepts Authorization headers; URL-token authentication is not used.`));
        });
        socket.on('error', error => {
            if (!this.active || this.socket !== socket) return;
            this.lastError = error;
            if (/CERT|TLS|SSL|WS_ERR/.test(String(error.code))) {
                this.fail(new Error(`Relay security or protocol check failed (${error.code}). Fix the certificate or protocol before reconnecting.`, { cause: error }));
                return;
            }
            this.log(`Relay connection error: ${safeError(error)}`);
        });
        socket.on('close', code => {
            if (this.socket !== socket) return;
            this.socket = undefined;
            this.stopHeartbeat();
            this.clearRegistration();
            if (!this.active) {
                this.setState('disconnected');
                return;
            }
            if (![1000, 1001, 1006, 1011, 1012, 1013].includes(code)) {
                this.fail(new Error(`Relay closed the connection with code ${code}. Check the connection log and server before reconnecting.`));
                return;
            }
            this.log(`Relay connection closed (code ${code}); reconnecting within the manually approved session.`);
            this.scheduleReconnect();
        });
    }
    async handleMessage(raw, socket = this.socket) {
        let message;
        try {
            message = JSON.parse(raw);
        }
        catch (cause) {
            throw new Error('Relay sent malformed JSON.', { cause });
        }
        if (!message || typeof message.type !== 'string')
            throw new Error('Relay message has no type.');
        if (!this.connected && !['request_registration', 'registration_confirmed', 'registration_denied', 'ping', 'pong'].includes(message.type))
            throw new Error('Relay attempted to access chat before registration completed.');
        switch (message.type) {
            case 'request_registration':
                if (this.registrationSent) throw new Error('Relay requested duplicate registration.');
                this.sendRegistration();
                return;
            case 'registration_confirmed':
                if (!this.registrationSent || this.connected || this.registrationPending) throw new Error('Unexpected relay registration confirmation.');
                this.registrationPending = true;
                await this.callbacks.onAccountInfo(safeOptionalString(message.userName), safeOptionalString(message.userEmail));
                if (!this.active || this.socket !== socket) return;
                this.clearRegistration();
                this.reconnectAttempt = 0;
                this.setState('connected');
                this.startHeartbeat();
                this.log(new URL(this.relayUrl).protocol === 'wss:' ? 'Connected to the VSLink relay using TLS.' : 'Connected to the local VSLink server (unencrypted loopback connection).');
                this.sendInboxUpdate();
                return;
            case 'registration_denied':
                throw new Error('Relay denied this pairing. Unpair this editor, check your account, and pair again.');
            case 'request_inbox':
                this.sendInboxUpdate();
                return;
            case 'ping':
                this.send({ type: 'pong', timestamp: Date.now() });
                return;
            case 'pong':
            case 'heartbeat_ack':
                return;
            case 'execute_command':
                await this.handleCommand(message);
                return;
            default:
                throw new Error(`Unsupported relay message type: ${safeLogValue(message.type)}. Use the request/response chat protocol.`);
        }
    }
    async handleCommand(message) {
        const command = typeof message.command === 'string' ? message.command : '';
        const requestId = validRequestId(message.requestId);
        if (requestId === undefined) throw new Error('Remote command requires a valid numeric request ID. No command was executed.');
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
                    throw new Error('Remote model selection is not supported. Choose the model in VS Code Copilot Chat.');
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
        const socket = this.socket;
        let result;
        try {
            result = await action();
        }
        catch (error) {
            const detail = safeError(error);
            this.log(`Chat request failed: ${detail}`);
            result = { error: detail, ...(error.delivery === 'not_submitted' ? { delivery: 'not_submitted' } : {}) };
        }
        if (this.socket !== socket) {
            this.log('Connection changed during a chat request; its result was not sent to a different connection. Check VS Code before retrying.');
            return;
        }
        this.respond(requestId, result);
    }
    respond(requestId, data) {
        if (requestId === undefined)
            return;
        this.send({ type: 'proxy_response', requestId, data, timestamp: Date.now() });
    }
    sendRegistration() {
        this.registrationSent = true;
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
            throw new Error('Relay is not open; the message was not sent.');
        const socket = this.socket;
        const encoded = JSON.stringify(payload);
        if (Buffer.byteLength(encoded) > MAX_OUTGOING_BYTES) {
            throw new Error('Outbound relay message exceeds the size limit; it was not sent.');
        }
        socket.send(encoded, error => {
            if (error && this.socket === socket) this.fail(new Error('Relay send failed. Check the connection before retrying.', { cause: error }));
        });
        return true;
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeat = setInterval(() => {
            try { this.send({ type: 'heartbeat', timestamp: Date.now() }); }
            catch (error) { this.fail(error); }
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeat.unref?.();
    }
    stopHeartbeat() {
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.heartbeat = undefined;
    }
    clearRegistration() {
        clearTimeout(this.registrationTimer);
        this.registrationTimer = undefined;
    }
    fail(error) {
        this.lastError = error;
        this.log(`VSLink connection stopped: ${safeError(error)}`);
        this.stop();
        this.callbacks.onFailure?.(error);
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
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value < 5000 || value > 180000)
        throw new Error('Reply wait must be an integer between 5000 and 180000 milliseconds.');
    return value;
}
function safeOptionalString(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > 200) throw new Error('Relay returned invalid account information.');
    return value.trim() || null;
}
function safeLogValue(value) {
    return value.replace(/[a-fA-F0-9]{64}/g, '[credential redacted]').replace(/[\r\n\t]/g, ' ').slice(0, 240);
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
