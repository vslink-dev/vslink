"use strict";
const crypto_1 = require("crypto");
const vscode = require("vscode");
class SidebarProvider {
    constructor(initialState) {
        this.actions = new vscode.EventEmitter();
        this.onAction = this.actions.event;
        this.state = initialState;
    }
    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [] };
        view.webview.html = this.html();
        view.webview.onDidReceiveMessage(message => {
            const action = message?.action;
            if (action === 'connect' || action === 'disconnect' || action === 'link' || action === 'unlink' || action === 'showLog') {
                this.actions.fire(action);
            }
        });
    }
    update(next) {
        this.state = { ...this.state, ...next };
        void this.view?.webview.postMessage({ type: 'state', state: this.displayState() });
    }
    displayState() {
        const { linked, accountName, connection, eligible, eligibilityMessage, version } = this.state;
        return { linked, accountName: linked ? accountName : null, connection, eligible, eligibilityMessage: eligible ? '' : eligibilityMessage, version };
    }
    dispose() {
        this.actions.dispose();
    }
    html() {
        const nonce = (0, crypto_1.randomBytes)(16).toString('base64');
        const initial = JSON.stringify(this.displayState()).replace(/</g, '\\u003c');
        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Vslink Copilot</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    :root { --accent: #ffda3d; --muted: var(--vscode-descriptionForeground); --border: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); --card: color-mix(in srgb, var(--vscode-foreground) 3%, var(--vscode-sideBar-background)); }
    body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: 12px/1.5 var(--vscode-font-family); }
    main { display: flex; flex-direction: column; gap: 16px; padding: 10px 6px; }
    h2 { margin: 0 0 6px; color: var(--muted); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
    .card { border: 1px solid var(--border); border-radius: 7px; background: var(--card); }
    .row { display: flex; align-items: center; gap: 9px; min-height: 52px; padding: 9px; }
    .icon { width: 18px; height: 18px; flex: none; color: var(--muted); }
    .row-main { min-width: 0; flex: 1; }
    .row-title { font-weight: 600; }
    .account-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-subtitle { margin-top: 2px; color: var(--muted); font-size: 11px; }
    .connection-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 9px 0; }
    .connection-label { display: flex; align-items: center; gap: 8px; flex: 1; white-space: nowrap; }
    .status { display: inline-flex; align-items: center; gap: 5px; padding: 2px 6px; border: 1px solid var(--border); border-radius: 20px; color: var(--muted); font-size: 10px; white-space: nowrap; }
    .dot { width: 5px; height: 5px; flex: none; border-radius: 50%; background: currentColor; }
    .connected { color: var(--vscode-testing-iconPassed); }
    .connecting, .reconnecting { color: var(--vscode-descriptionForeground); }
    .connection-copy { margin: 8px 9px 10px; color: var(--muted); font-size: 11px; }
    button, summary { -webkit-tap-highlight-color: transparent; }
    button { font: inherit; cursor: pointer; }
    button:disabled { cursor: default; opacity: .4; }
    button:focus-visible, summary:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 3px; }
    summary:focus-visible, footer button:focus-visible { outline-offset: -1px; }
    .primary { display: block; width: calc(100% - 16px); min-height: 34px; margin: 0 8px 8px; padding: 6px 10px; border: 1px solid transparent; border-radius: 5px; background: var(--accent); color: #25200b; font-size: 12px; font-weight: 600; }
    .primary:hover:not(:disabled) { background: #ffe46d; }
    .primary[data-active="true"] { color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); border-color: var(--border); }
    .primary[data-active="true"]:hover:not(:disabled) { background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
    .text-button { flex: none; padding: 4px 0; background: transparent; border: 0; color: var(--muted); font-size: 11px; }
    .text-button:hover:not(:disabled) { color: var(--vscode-foreground); }
    .setup-note { margin: 0; overflow-wrap: anywhere; }
    .options { margin: -3px 0 0; color: var(--muted); font-size: 11px; }
    summary { width: fit-content; padding: 2px 0; cursor: pointer; }
    summary:hover { color: var(--vscode-foreground); }
    .sharing-copy { line-height: 1.7; }
    .sharing-copy p { margin: 10px 0 0; }
    footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin: -3px 0 0; padding-top: 8px; border-top: 1px solid var(--border); color: var(--muted); font-size: 10px; }
    body.vscode-high-contrast, body.vscode-high-contrast-light { --border: var(--vscode-contrastBorder); }
    body.vscode-high-contrast .primary, body.vscode-high-contrast-light .primary { border-color: var(--vscode-contrastBorder); }
  </style>
</head>
<body>
  <main aria-label="VSLink connection">
    <section aria-labelledby="accountHeading">
      <h2 id="accountHeading">Account</h2>
      <div class="card row">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20v-2a7 7 0 0 1 14 0v2"/></svg>
        <div class="row-main">
          <div class="row-title account-name" id="accountName"></div>
          <div class="row-subtitle" id="accountDetail"></div>
        </div>
        <button id="link" class="text-button" hidden>Unpair</button>
      </div>
    </section>
    <section aria-labelledby="connectionHeading">
      <h2 id="connectionHeading">Connection</h2>
      <div class="card">
        <div class="connection-head">
          <div class="connection-label">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14a3 3 0 0 1-3 3H9l-5 4V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3Z"/><path d="M8 8h8M8 12h5"/></svg>
            <span class="row-title">Copilot Chat</span>
          </div>
          <div class="status" id="status" role="status" aria-live="polite"><span class="dot" aria-hidden="true"></span><span id="statusText"></span></div>
        </div>
        <p class="connection-copy">Continue your conversations in the browser.</p>
        <button id="primary" class="primary"><span id="primaryText"></span></button>
      </div>
    </section>
    <p class="setup-note" id="setupNote" role="alert" hidden></p>
    <details class="options">
      <summary>What Connect shares</summary>
      <div class="sharing-copy">
        <p>While connected, VSLink shares your visible Copilot prompts and completed answers, including earlier chats, with your paired browser through the VSLink relay.</p>
        <p>The workspace name and identifier are included. Files, terminal output, Git data, attachments, tool payloads, and hidden reasoning are not shared.</p>
      </div>
    </details>
    <footer><span id="version"></span><button id="log" class="text-button">Connection log</button></footer>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = ${initial};
    const byId = id => document.getElementById(id);
    const send = action => vscode.postMessage({ action });
    byId('log').addEventListener('click', () => send('showLog'));
    byId('primary').addEventListener('click', () => {
      if (state.connection !== 'disconnected') return send('disconnect');
      send(state.linked ? 'connect' : 'link');
    });
    byId('link').addEventListener('click', () => send(state.linked ? 'unlink' : 'link'));
    function render() {
      const primary = byId('primary');
      const labels = { disconnected: state.linked ? 'Not connected' : 'Not paired', connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…' };
      if (!Object.hasOwn(labels, state.connection)) {
        byId('status').className = 'status';
        byId('statusText').textContent = 'Connection unavailable';
        byId('setupNote').hidden = false;
        byId('setupNote').textContent = 'Open the connection log to check what happened.';
        primary.disabled = true;
        byId('link').disabled = true;
        throw new Error('Unexpected VSLink connection state: ' + state.connection);
      }
      const active = state.connection !== 'disconnected';
      const namedAccount = state.linked && typeof state.accountName === 'string' && state.accountName.trim().length > 0;
      byId('accountName').textContent = namedAccount ? state.accountName : state.linked ? 'Account paired' : 'Not paired';
      byId('accountName').title = namedAccount ? state.accountName : '';
      byId('accountDetail').textContent = state.linked ? 'Paired with this editor' : 'Pair your VSLink account to get started';
      byId('version').textContent = 'v' + state.version;
      byId('status').className = 'status ' + state.connection;
      byId('statusText').textContent = labels[state.connection];
      byId('primaryText').textContent = active ? 'Disconnect' : state.linked ? 'Connect' : 'Pair account';
      primary.dataset.active = String(active);
      primary.disabled = !active && !state.eligible;
      byId('setupNote').hidden = state.eligible;
      byId('setupNote').textContent = state.eligible ? '' : state.eligibilityMessage;
      const link = byId('link');
      link.hidden = !state.linked;
      link.disabled = active;
      link.title = active ? 'Disconnect before unpairing' : 'Unpair this editor';
    }
    window.addEventListener('message', event => {
      if (event.data?.type !== 'state' || !event.data.state) return;
      state = event.data.state;
      render();
    });
    render();
  </script>
</body>
</html>`;
    }
}
exports.SidebarProvider = SidebarProvider;
