# Vslink Copilot

Continue your workspace’s GitHub Copilot conversations in a paired browser. VSLink connects only when you choose **Connect** and starts disconnected after every VS Code launch.

**A paid VSLink subscription is required. There is no free trial.** Installing the extension is free; the connected browser service is paid. See [current pricing](https://vslink.dev/pricing). A VSLink subscription does not include GitHub Copilot access.

## Features

- One trusted, local workspace per connection.
- Saved Copilot conversations, including earlier visible chats, on macOS, Windows, and Linux.
- Send a prompt to the active native Copilot Chat, or start a new native conversation from the browser.
- Send and New Chat wait for a newly saved JSONL prompt before reporting submission. Commands are never automatically resent.
- Earlier conversations remain in the list after starting a new chat.
- A dropped transport connection reconnects only during the manually approved session. Disconnect stops polling and reconnection.

VSLink has no direct remote terminal, file, Git, approval, or workspace-switching controls. **Copilot itself may edit files or use tools in response to browser prompts**, according to the mode, model, and permissions selected in VS Code. VSLink does not change those permissions.

## Requirements

- VS Code **1.137.0 or newer**. This is the minimum version against which the native command arguments were checked; older versions are not claimed to work.
- GitHub Copilot Chat installed, enabled, signed in, and available to your account.
- Exactly one trusted local workspace folder.
- A VSLink account with an active paid subscription and a compatible relay.

## Connect

1. Open the workspace in VS Code and sign in to GitHub Copilot Chat.
2. Open Vslink Copilot in the Activity Bar and choose **Pair with VSLink**.
3. Complete pairing on the website, then return to VS Code.
4. Choose **Connect**, review the confirmation, and approve it.

Pairing alone does not read or relay chat. Every new VS Code launch starts disconnected. The sidebar’s expandable **What Connect shares** section explains the data flow.

The extension validates the website and relay supplied during pairing. Production uses `https://vslink.dev` and the configured official WSS relay. Localhost pairing uses that same local server for HTTP and WebSocket traffic. Missing or invalid saved endpoints require pairing again; they never silently select production.

## Data and privacy

After manual Connect, VSLink reads saved `chatSessions` files for the current workspace and forwards these fields through the VSLink relay to the paired browser:

- Visible prompt text and finished assistant text, including text retained in canceled or failed responses.
- Conversation and request IDs, titles, message counts, timestamps when available, and completion/error/cancellation status.
- Available model IDs, model labels, response details, and Copilot credit estimates.
- Workspace name and identifier, connection state, and history-update timing/pagination metadata.

The stored JSONL/JSON file contains more than the transmitted view. VSLink reconstructs it locally, then selects visible display text and the listed metadata. Transcript-hidden turns and hidden prompts are filtered out. Attachments, references, separate tool payloads, hidden reasoning, terminal/Git/file payloads, machine ID, recent project details, and workspace filesystem paths are not deliberately included in the outgoing view.

**Visible chat text is not secret-redacted.** Code, secrets, file paths, terminal output, or other information written into a visible prompt or answer are part of that text and are forwarded. Diagnostic errors can also contain file names or paths. Only connect workspaces whose chat you want available through this service.

The account credential is stored in VS Code **SecretStorage**. Account name, email, and paired endpoint addresses are stored in local extension state. Pairing sends a one-time code and workspace name/identifier to the pairing website. The credential is sent in the WebSocket Authorization header and registration message, never in its URL.

Production transport uses TLS, but **this release is not end-to-end encrypted**: the relay can process the content it forwards. Localhost development may use unencrypted HTTP/WS confined to loopback endpoints. There is no automatic downgrade from HTTPS/WSS.

Disconnect stops extension polling and forwarding; it does not erase data already received by the browser or relay. Unpair removes this editor’s local credential and account state; it **does not revoke the server-side credential** in this release. Server retention and deletion behavior must be verified separately. See the [VSLink Privacy Policy](https://vslink.dev/privacy-policy).

## Chat compatibility and limits

VSLink reads the current workspace’s native `.jsonl` and legacy `.json` files. It does not switch formats after a parse failure, scan other workspace histories, or write to Copilot’s storage. VS Code does not expose a stable public API to enumerate all existing native Copilot chats; this storage format is an internal implementation detail and may change.

The workspace storage location is derived from VS Code’s extension context on each platform. Valid empty drafts are excluded. There is no last-200-request history cutoff. Malformed files and limit violations return an explicit error, not a partial or older conversation presented as success:

- 4 MB per session file.
- 4 MB for the combined relayed inbox.
- 100,000 characters per visible prompt or answer.

Titles derived from a prompt are shortened for display; the full prompt remains in the message list within these limits. Optional timestamps and metadata are omitted when not recorded, not invented.

New Chat uses `workbench.action.chat.newLocalChat`; Send uses `workbench.action.chat.open`. These run in native Copilot, not an isolated model session. Submission is observed through a new matching JSONL prompt, not a public command receipt. If confirmation is missing, ambiguous, or interrupted, check VS Code before retrying: the command may have run even though VSLink could not confirm it. Simultaneous identical prompts entered directly in VS Code cannot be conclusively distinguished from a remote request by this storage-based observation.

Send targets the chat active in VS Code; VSLink cannot verify or switch that active selection through a stable public session API. Selecting an older conversation in the browser does not activate it in VS Code. A successful submission reports the actual observed session ID. `send_and_wait` accepts only a completed answer belonging to that confirmed request, never an answer from a different chat.

## Deployment status

This is an **unpublished source build**, not a Microsoft compliance certification. Review [POLICY_REVIEW.md](POLICY_REVIEW.md) before publishing.

The production worker source inspected during this audit requires a URL token. **That worker must be updated to accept Authorization-header authentication before deploying this extension.** This change has not been made here. HTTP authentication rejection stops the extension connection; it does not retry by putting a credential in the URL. The local server’s registration flow does not require the URL token.

## Development

This folder maintains the current 1.1.0 implementation as directly executable CommonJS JavaScript. `package.json` loads `src/extension.js`; there is no compilation step.

- Install the pinned dependency with `npm install --ignore-scripts`.
- Run `npm test` for syntax, parser, pairing, native-command confirmation, relay, consent, and sidebar regression tests. Tests use synthetic chat data and mocked VS Code/relay interfaces, not real user prompts or production credentials.
- Use an Extension Development Host for manual testing. Do not connect a real workspace without reviewing the disclosure.

No server, worker, webapp, installed extension, compiled output, or VSIX is included. This source folder has its own local Git repository.

## Support and attribution

- [VSLink website](https://vslink.dev)
- [Issue tracker](https://github.com/dev-tahir/vscode-link/issues)

GitHub, GitHub Copilot, Microsoft, and Visual Studio Code are trademarks of their respective owners. VSLink is not affiliated with or endorsed by GitHub or Microsoft.

See [LICENSE.txt](LICENSE.txt).
