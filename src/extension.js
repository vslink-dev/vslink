"use strict";
exports.activate = activate;
exports.deactivate = deactivate;
const http = require("http");
const https = require("https");
const path = require("path");
const vscode = require("vscode");
const chatHistory_1 = require("./chatHistory");
const cloudClient_1 = require("./cloudClient");
const linking_1 = require("./linking");
const sidebar_1 = require("./sidebar");
const TOKEN_SECRET_KEY = 'vslink.copilotPairingToken.v1';
const OLD_TOKEN_SECRET_KEY = 'vslink.accountLinkToken';
const ACCOUNT_NAME_KEY = 'vslink.accountName';
const ACCOUNT_EMAIL_KEY = 'vslink.accountEmail';
const PAIRED_BACKEND_KEY = 'vslink.pairedBackendOrigin';
const PAIRED_RELAY_KEY = 'vslink.pairedRelayUrl';
let output;
let sidebar;
let reader;
let client;
let extensionContext;
async function activate(context) {
    extensionContext = context;
    output = vscode.window.createOutputChannel('Vslink Copilot');
    context.subscriptions.push(output);
    const token = await context.secrets.get(TOKEN_SECRET_KEY);
    const workspace = resolveWorkspace(context);
    const initialState = {
        linked: Boolean(token),
        accountName: context.globalState.get(ACCOUNT_NAME_KEY) || null,
        accountEmail: context.globalState.get(ACCOUNT_EMAIL_KEY) || null,
        connection: 'disconnected',
        workspaceName: workspace.identity?.name || 'No supported workspace',
        eligible: Boolean(workspace.identity),
        eligibilityMessage: workspace.message,
        version: String(context.extension.packageJSON.version || '')
    };
    sidebar = new sidebar_1.SidebarProvider(initialState);
    context.subscriptions.push(sidebar, vscode.window.registerWebviewViewProvider('remoteChatControl.sidebar', sidebar), sidebar.onAction(action => {
        switch (action) {
            case 'connect':
                void connectCurrentWorkspace(context);
                break;
            case 'disconnect':
                disconnect('Disconnected by user.');
                break;
            case 'link':
                void openPairingPage(context);
                break;
            case 'unlink':
                void unlink(context);
                break;
            case 'showLog':
                output?.show(true);
                break;
        }
    }), vscode.commands.registerCommand('remoteChatControl.connectCloud', () => connectCurrentWorkspace(context)), vscode.commands.registerCommand('remoteChatControl.disconnectCloud', () => disconnect('Disconnected by user.')), vscode.commands.registerCommand('remoteChatControl.signIn', () => openPairingPage(context)), vscode.commands.registerCommand('remoteChatControl.logout', () => unlink(context)), vscode.commands.registerCommand('remoteChatControl.showOutput', () => output?.show(true)), vscode.window.registerUriHandler({ handleUri: uri => handleUri(context, uri) }), vscode.workspace.onDidChangeWorkspaceFolders(() => workspaceChanged(context)), vscode.workspace.onDidGrantWorkspaceTrust(() => workspaceChanged(context)), context.secrets.onDidChange(event => {
        if (event.key !== TOKEN_SECRET_KEY)
            return;
        void refreshLinkedState(context);
    }));
    log('VSLink activated in disconnected mode. No chat data is being read or transmitted.');
}
function deactivate() {
    disconnect('VSLink deactivated.');
    extensionContext = undefined;
    sidebar = undefined;
    output = undefined;
}
async function connectCurrentWorkspace(context) {
    if (client) {
        vscode.window.showInformationMessage('VSLink is already connected or reconnecting.');
        return;
    }
    const workspace = resolveWorkspace(context);
    updateWorkspaceState(workspace);
    if (!workspace.identity) {
        vscode.window.showErrorMessage(workspace.message);
        return;
    }
    const token = await context.secrets.get(TOKEN_SECRET_KEY);
    if (!token) {
        const choice = await vscode.window.showInformationMessage('Pair with VSLink before connecting.', 'Pair with VSLink');
        if (choice === 'Pair with VSLink')
            await openPairingPage(context);
        return;
    }
    const choice = await vscode.window.showInformationMessage('Connect to VSLink?', {
        modal: true,
        detail: `View your Copilot chats from “${workspace.identity.name}” in VSLink. You can disconnect whenever you like.`
    }, 'Connect');
    if (choice !== 'Connect')
        return;
    const history = new chatHistory_1.ChatHistoryReader(workspace.identity);
    const starter = new (require('./newChat').NativeChatStarter)(vscode, history, () => client === cloud && cloud.connected, log);
    reader = history;
    const relayUrl = context.globalState.get(PAIRED_RELAY_KEY) || linking_1.DEFAULT_RELAY_URL;
    const cloud = new cloudClient_1.CloudClient(log, workspace.identity, token, {
        getInbox: () => history.current(),
        sendChat: prompt => {
            if (starter.busy) throw new Error('Wait for the new Copilot chat to be confirmed before sending another prompt.');
            return sendToCopilot(prompt);
        },
        startChat: prompt => starter.start(prompt),
        sendAndWait: (prompt, maxWait) => {
            if (starter.busy) throw new Error('Wait for the new Copilot chat to be confirmed before sending another prompt.');
            return sendAndWait(history, prompt, maxWait);
        },
        onAccountInfo: (name, email) => void saveAccountInfo(context, name, email),
        onStateChange: state => sidebar?.update({ connection: state })
    }, relayUrl);
    client = cloud;
    history.start(inbox => cloud.sendInboxUpdate(inbox));
    cloud.start();
    log(`Manual connection approved for workspace “${workspace.identity.name}”.`);
}
function disconnect(message) {
    const activeClient = client;
    client = undefined;
    activeClient?.stop();
    reader?.stop();
    reader = undefined;
    sidebar?.update({ connection: 'disconnected' });
    log(message);
}
async function sendToCopilot(prompt) {
    if (!client)
        throw new Error('VSLink is disconnected.');
    const copilot = vscode.extensions.getExtension('GitHub.copilot-chat');
    if (!copilot)
        throw new Error('GitHub Copilot Chat is not installed.');
    if (!copilot.isActive)
        await copilot.activate();
    await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
        isPartialQuery: false
    });
    log('Submitted one remote prompt to the active VS Code Copilot Chat.');
    return { success: true, submitted: true };
}
async function sendAndWait(history, prompt, requestedWait) {
    const before = assistantMarker(history.current());
    await sendToCopilot(prompt);
    const maxWait = Math.min(Math.max(requestedWait || 60000, 5000), 180000);
    const deadline = Date.now() + maxWait;
    while (Date.now() < deadline) {
        if (!client)
            return { success: false, error: 'VSLink disconnected while waiting for Copilot.' };
        await delay(750);
        const inbox = history.current();
        const latest = latestAssistant(inbox);
        if (latest && latest.marker !== before && latest.message.status !== 'in-progress') {
            return {
                success: true,
                assistantReply: latest.message.text,
                sessionId: latest.sessionId,
                status: latest.message.status || 'complete'
            };
        }
    }
    return { success: false, error: 'Timed out waiting for Copilot Chat to finish.' };
}
async function handleUri(context, uri) {
    if (uri.path !== '/link')
        return;
    const code = new URLSearchParams(uri.query).get('code')?.trim().toUpperCase() || '';
    if (!/^[A-Z0-9]{6,12}$/.test(code)) {
        vscode.window.showErrorMessage('Invalid or missing VSLink pairing code.');
        return;
    }
    const workspace = resolveWorkspace(context);
    updateWorkspaceState(workspace);
    if (!workspace.identity) {
        vscode.window.showErrorMessage(workspace.message);
        return;
    }
    const targets = (0, linking_1.resolvePairingTargets)(uri.query);
    const choice = await vscode.window.showInformationMessage(`Pair VSLink with “${workspace.identity.name}”?`, {
        modal: true,
        detail: 'This pairs your VSLink account with VS Code. You can connect this workspace after pairing.'
    }, 'Pair');
    if (choice !== 'Pair')
        return;
    try {
        const linked = await exchangeLinkCode(code, workspace.identity, targets.exchangeUrl);
        await context.secrets.store(TOKEN_SECRET_KEY, linked.token);
        await Promise.all([
            context.globalState.update(PAIRED_BACKEND_KEY, targets.backendOrigin),
            context.globalState.update(PAIRED_RELAY_KEY, targets.relayUrl)
        ]);
        await saveAccountInfo(context, linked.userName, linked.userEmail);
        sidebar?.update({ linked: true, connection: 'disconnected' });
        log('Account paired. The workspace remains disconnected until manual Connect.');
        vscode.window.showInformationMessage('VSLink paired. Press Connect current workspace when you are ready.');
    }
    catch (error) {
        const message = safeError(error);
        log(`Account pairing failed: ${message}`);
        vscode.window.showErrorMessage(`VSLink pairing failed: ${message}`);
    }
}
async function unlink(context) {
    const choice = await vscode.window.showWarningMessage('Unpair this VS Code editor from VSLink?', { modal: true, detail: 'This removes the saved pairing and stops the current connection.' }, 'Unpair');
    if (choice !== 'Unpair')
        return;
    disconnect('Editor unpaired.');
    await Promise.all([
        context.secrets.delete(TOKEN_SECRET_KEY),
        context.secrets.delete(OLD_TOKEN_SECRET_KEY),
        context.globalState.update(PAIRED_BACKEND_KEY, undefined),
        context.globalState.update(PAIRED_RELAY_KEY, undefined)
    ]);
    await saveAccountInfo(context, null, null);
    sidebar?.update({ linked: false, connection: 'disconnected' });
    vscode.window.showInformationMessage('This editor is no longer paired with VSLink.');
}
function workspaceChanged(context) {
    if (client)
        disconnect('Workspace changed; the active VSLink connection was stopped.');
    updateWorkspaceState(resolveWorkspace(context));
}
function updateWorkspaceState(result) {
    sidebar?.update({
        workspaceName: result.identity?.name || 'No supported workspace',
        eligible: Boolean(result.identity),
        eligibilityMessage: result.message
    });
}
async function refreshLinkedState(context) {
    const token = await context.secrets.get(TOKEN_SECRET_KEY);
    sidebar?.update({ linked: Boolean(token) });
}
function resolveWorkspace(context) {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!vscode.workspace.isTrusted)
        return { message: 'Trust this workspace before connecting.' };
    if (folders.length !== 1)
        return { message: 'Open exactly one workspace folder to use VSLink.' };
    if (folders[0].uri.scheme !== 'file')
        return { message: 'This VSLink release supports local workspaces only.' };
    if (!context.storageUri?.fsPath)
        return { message: 'VS Code workspace storage is unavailable for this window.' };
    const location = workspaceStorageLocation(context.storageUri.fsPath);
    if (!location)
        return { message: 'Could not identify this workspace’s VS Code chat storage.' };
    return {
        identity: {
            hash: location.hash,
            name: (vscode.workspace.name || folders[0].name || 'VS Code').slice(0, 200),
            storageRoot: location.root
        },
        message: 'One trusted local workspace. Starts disconnected on every VS Code launch.'
    };
}
function workspaceStorageLocation(storagePath) {
    let cursor = path.resolve(storagePath);
    while (true) {
        const parent = path.dirname(cursor);
        if (parent === cursor)
            return undefined;
        if (path.basename(parent) === 'workspaceStorage') {
            const hash = path.basename(cursor);
            if (!/^[A-Za-z0-9_-]{8,128}$/.test(hash))
                return undefined;
            return { root: parent, hash };
        }
        cursor = parent;
    }
}
async function openPairingPage(context) {
    const previousBackend = context.globalState.get(PAIRED_BACKEND_KEY);
    await vscode.env.openExternal(vscode.Uri.parse((0, linking_1.pairingPageUrl)(previousBackend)));
}
function exchangeLinkCode(code, workspace, exchangeUrl) {
    const body = JSON.stringify({
        code,
        workspaceHash: workspace.hash,
        workspaceName: workspace.name,
        workspacePath: '',
        alwaysConnected: false
    });
    return new Promise((resolve, reject) => {
        const endpoint = new URL(exchangeUrl);
        const transport = endpoint.protocol === 'http:' ? http : https;
        const request = transport.request(endpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 15000
        }, response => {
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += buffer.length;
                if (size > 64 * 1024) {
                    request.destroy(new Error('Pairing response was too large.'));
                    return;
                }
                chunks.push(buffer);
            });
            response.on('end', () => {
                let data;
                try {
                    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                }
                catch {
                    reject(new Error('Pairing server returned an invalid response.'));
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(typeof data?.error === 'string' ? data.error.slice(0, 200) : `Pairing failed with HTTP ${response.statusCode || 'error'}.`));
                    return;
                }
                if (!validLinkToken(data?.token)) {
                    reject(new Error('Pairing server did not return a valid credential.'));
                    return;
                }
                resolve({
                    token: data.token,
                    userName: safeOptionalString(data.userName),
                    userEmail: safeOptionalString(data.userEmail)
                });
            });
        });
        request.on('timeout', () => request.destroy(new Error('Pairing request timed out.')));
        request.on('error', reject);
        request.end(body);
    });
}
async function saveAccountInfo(context, name, email) {
    await Promise.all([
        context.globalState.update(ACCOUNT_NAME_KEY, name || undefined),
        context.globalState.update(ACCOUNT_EMAIL_KEY, email || undefined)
    ]);
    sidebar?.update({ accountName: name, accountEmail: email });
}
function assistantMarker(inbox) {
    return latestAssistant(inbox)?.marker || '';
}
function latestAssistant(inbox) {
    const session = inbox.sessions[0];
    if (!session)
        return undefined;
    for (let index = session.messages.length - 1; index >= 0; index--) {
        const message = session.messages[index];
        if (message.role !== 'assistant')
            continue;
        return {
            marker: `${session.sessionId}:${index}:${message.timestamp || 0}:${message.text.length}:${message.text.slice(-80)}`,
            message,
            sessionId: session.sessionId
        };
    }
    return undefined;
}
function validLinkToken(value) {
    return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
}
function safeOptionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
}
function safeError(error) {
    const value = error instanceof Error ? error.message : String(error);
    return value.replace(/[\r\n\t]/g, ' ').slice(0, 240);
}
function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    output?.appendLine(line);
}
