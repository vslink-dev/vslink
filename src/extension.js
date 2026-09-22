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
let connectionAttempt;
let pairing = false;
async function activate(context) {
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
                void runUi(() => connectCurrentWorkspace(context));
                break;
            case 'disconnect':
                disconnect('Disconnected by user.');
                break;
            case 'link':
                void runUi(() => openPairingPage(context));
                break;
            case 'unlink':
                void runUi(() => unlink(context));
                break;
            case 'showLog':
                output?.show(true);
                break;
        }
    }), vscode.commands.registerCommand('remoteChatControl.connectCloud', () => runUi(() => connectCurrentWorkspace(context))), vscode.commands.registerCommand('remoteChatControl.disconnectCloud', () => disconnect('Disconnected by user.')), vscode.commands.registerCommand('remoteChatControl.signIn', () => runUi(() => openPairingPage(context))), vscode.commands.registerCommand('remoteChatControl.logout', () => runUi(() => unlink(context))), vscode.commands.registerCommand('remoteChatControl.showOutput', () => output?.show(true)), vscode.window.registerUriHandler({ handleUri: uri => handleUri(context, uri) }), vscode.workspace.onDidChangeWorkspaceFolders(() => workspaceChanged(context)), vscode.workspace.onDidGrantWorkspaceTrust(() => workspaceChanged(context)), context.secrets.onDidChange(event => {
        if (event.key !== TOKEN_SECRET_KEY)
            return;
        void runUi(() => refreshLinkedState(context));
    }));
    log('VSLink activated in disconnected mode. No chat data is being read or transmitted.');
}
function deactivate() {
    disconnect('VSLink deactivated.');
    sidebar = undefined;
    output = undefined;
}
async function runUi(action) {
    try { return await action(); }
    catch (error) {
        log(safeError(error));
        await vscode.window.showErrorMessage(safeError(error));
    }
}
async function connectCurrentWorkspace(context) {
    if (client || connectionAttempt || pairing) {
        await vscode.window.showInformationMessage('A connection or pairing is already in progress. Use Disconnect before starting again.');
        return;
    }
    const attempt = {};
    connectionAttempt = attempt;
    try {
        const workspace = resolveWorkspace(context);
        updateWorkspaceState(workspace);
        if (!workspace.identity) throw new Error(workspace.message);
        const token = await context.secrets.get(TOKEN_SECRET_KEY);
        if (!token) {
            const choice = await vscode.window.showInformationMessage('Pair with VSLink before connecting.', 'Pair with VSLink');
            if (choice === 'Pair with VSLink') await openPairingPage(context);
            return;
        }
        if (!validLinkToken(token)) throw new Error('Saved credential is invalid. Unpair this editor and pair again.');
        const targets = linking_1.validateSavedPairing(context.globalState.get(PAIRED_BACKEND_KEY), context.globalState.get(PAIRED_RELAY_KEY));
        const choice = await vscode.window.showInformationMessage('Connect to VSLink?', {
            modal: true,
            detail: `Show Copilot chats from “${workspace.identity.name}”, including earlier chats, in your paired browser via ${new URL(targets.relayUrl).host}. Your browser can send prompts using your VS Code permissions. You can disconnect at any time. See “What Connect shares” in the sidebar for details.`
        }, 'Connect');
        if (choice !== 'Connect') return;
        const current = resolveWorkspace(context).identity;
        if (connectionAttempt !== attempt || !current || JSON.stringify(current) !== JSON.stringify(workspace.identity))
            throw new Error('Workspace changed during confirmation. Connect again from the intended workspace.');
        if (await context.secrets.get(TOKEN_SECRET_KEY) !== token)
            throw new Error('Pairing changed during confirmation. Connect again.');
        if (connectionAttempt !== attempt) throw new Error('Connection was canceled.');
        const history = new chatHistory_1.ChatHistoryReader(workspace.identity);
        const starter = new (require('./newChat').NativeChatStarter)(vscode, history,
            () => client === cloud && cloud.connected ? cloud.socket : false, log);
        const cloud = new cloudClient_1.CloudClient(log, workspace.identity, token, {
            getInbox: () => history.current(),
            sendChat: prompt => starter.send(prompt),
            startChat: prompt => starter.start(prompt),
            sendAndWait: (prompt, maxWait) => starter.sendAndWait(prompt, maxWait),
            onAccountInfo: (name, email) => saveAccountInfo(context, name, email),
            onStateChange: state => sidebar?.update({ connection: state }),
            onFailure: error => {
                if (client !== cloud) return;
                disconnect('Connection stopped. Check the connection log before reconnecting.');
                void vscode.window.showErrorMessage(safeError(error));
            }
        }, targets.relayUrl);
        client = cloud;
        reader = history;
        try {
            history.start(inbox => cloud.sendInboxUpdate(inbox));
            if (history.lastError) throw history.lastError;
            cloud.start();
        } catch (error) {
            disconnect('Connection could not start.');
            throw error;
        }
        log(`Manual connection approved for workspace “${workspace.identity.name}”.`);
    } finally {
        if (connectionAttempt === attempt) connectionAttempt = undefined;
    }
}
function disconnect(message) {
    connectionAttempt = undefined;
    const activeClient = client;
    client = undefined;
    activeClient?.stop();
    reader?.stop();
    reader = undefined;
    sidebar?.update({ connection: 'disconnected' });
    log(message);
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
    if (pairing || connectionAttempt || client) {
        await vscode.window.showErrorMessage('Disconnect VSLink and finish any pending pairing before pairing again.');
        return;
    }
    pairing = true;
    try {
        const targets = (0, linking_1.resolvePairingTargets)(uri.query);
        const choice = await vscode.window.showInformationMessage(`Pair VSLink with “${workspace.identity.name}”?`, {
            modal: true,
            detail: `Pair your account through ${targets.backendOrigin}. You can connect this workspace after pairing.`
        }, 'Pair');
        if (choice !== 'Pair') return;
        const current = resolveWorkspace(context).identity;
        if (!current || JSON.stringify(current) !== JSON.stringify(workspace.identity)) throw new Error('Workspace changed. Pair again from the intended workspace.');
        const linked = await exchangeLinkCode(code, workspace.identity, targets.exchangeUrl);
        const afterExchange = resolveWorkspace(context).identity;
        if (!afterExchange || JSON.stringify(afterExchange) !== JSON.stringify(workspace.identity))
            throw new Error('Workspace changed during pairing. Pair again from the intended workspace.');
        // Save the credential last: failed metadata writes cannot leave an active
        // credential pointing at an old or partially updated relay.
        await context.secrets.delete(TOKEN_SECRET_KEY);
        await Promise.all([
            context.globalState.update(PAIRED_BACKEND_KEY, targets.backendOrigin),
            context.globalState.update(PAIRED_RELAY_KEY, targets.relayUrl)
        ]);
        await saveAccountInfo(context, linked.userName, linked.userEmail);
        await context.secrets.store(TOKEN_SECRET_KEY, linked.token);
        sidebar?.update({ linked: true, connection: 'disconnected' });
        log('Account paired. The workspace remains disconnected until manual Connect.');
        vscode.window.showInformationMessage('VSLink paired. Press Connect current workspace when you are ready.');
    }
    catch (error) {
        const message = safeError(error);
        log(`Account pairing failed: ${message}`);
        await vscode.window.showErrorMessage(`VSLink pairing failed: ${message}`);
    } finally {
        pairing = false;
    }
}
async function unlink(context) {
    if (pairing) throw new Error('Wait for pairing to finish before unpairing this editor.');
    const choice = await vscode.window.showWarningMessage('Unpair this VS Code editor from VSLink?', { modal: true, detail: 'This stops the connection and removes the pairing saved in this editor. It does not revoke the credential on the server.' }, 'Unpair');
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
    if (client || connectionAttempt)
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
    if (previousBackend === undefined && await context.secrets.get(TOKEN_SECRET_KEY))
        throw new Error('Saved pairing website is missing. Unpair this editor and pair again.');
    const opened = await vscode.env.openExternal(vscode.Uri.parse((0, linking_1.pairingPageUrl)(previousBackend)));
    if (!opened) throw new Error('VS Code could not open the pairing website. Check your browser settings.');
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
            response.on('error', reject);
            response.on('aborted', () => reject(new Error('Pairing response was interrupted. Pair again.')));
            response.on('end', () => {
                let data;
                try {
                    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                }
                catch (cause) {
                    reject(new Error('Pairing server returned invalid JSON.', { cause }));
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
                try {
                    resolve({
                        token: data.token,
                        userName: safeOptionalString(data.userName),
                        userEmail: safeOptionalString(data.userEmail)
                    });
                } catch (error) { reject(error); }
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
function validLinkToken(value) {
    return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
}
function safeOptionalString(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > 200) throw new Error('Pairing server returned invalid account information.');
    return value.trim() || null;
}
function safeError(error) {
    const value = error instanceof Error ? error.message : String(error);
    return value.replace(/[a-fA-F0-9]{64}/g, '[credential redacted]').replace(/[\r\n\t]/g, ' ').slice(0, 240);
}
function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    output?.appendLine(line);
}
