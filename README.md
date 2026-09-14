# Current extension source

This is the current Vslink Copilot 1.1.0 implementation from the extension being tested, not the older Desktop extension.

The original TypeScript working folder is unavailable. This project maintains the current implementation as directly executable CommonJS JavaScript in src/. Compiler import helpers and obsolete source-map references were removed; feature logic was preserved. package.json loads src/extension.js directly, with no compilation step.

It includes the latest pairing flow, saved conversation reader, native New Chat with JSONL confirmation, connection dialog, sidebar layout, and existing icons.

## Development

- Run npm install --ignore-scripts to install the declared ws dependency.
- Run npm test for the source checks and isolated extension regression tests.
- Open this folder in VS Code and launch an Extension Development Host with --extensionDevelopmentPath pointing to this folder.
- Nothing connects automatically; pairing and Connect remain manual.

No server, relay worker, webapp, node_modules, out/dist build output, source maps, VSIX, Git directory, or installed extension metadata is included. The original working copy and installed extension were not moved or changed.

## Existing implementation notes

This is a source separation, not a compliance certification or a behavior rewrite. Existing runtime fallbacks remain out of scope: linking.js substitutes official endpoints for invalid pairing URLs; extension.js uses the default relay when saved relay state is absent. sessionParser.js retains its existing text/message limits. These need a separate strict-behavior audit before publication. No new fallback was added to this export.

The sidebar tests contain no HTTP preview server. Runtime http/https usage is only the extension client talking to the existing pairing service.

---
# Vslink Copilot

VSLink connects one trusted VS Code workspace to your paired browser so you can continue the current GitHub Copilot Chat from another device.

## What this release does

- Connects only after you explicitly choose **Connect current workspace**.
- Starts disconnected after every VS Code launch.
- Automatically restores a dropped WSS connection only during the manually approved session.
- Shows saved Copilot conversations with visible messages in the current workspace, newest first. Earlier conversations stay available after starting a new chat; valid empty drafts are excluded.
- Supports VS Code's `.jsonl` chat format and legacy `.json` chat files on macOS, Windows, and Linux.
- Sends prompts to the active native VS Code Copilot Chat.
- Starts a new native Copilot chat from the browser's **New Chat** page. Your first prompt stays visible until workspace JSONL confirms the conversation.
- Stores the account-link credential in VS Code SecretStorage.

VSLink does not provide remote terminal, file, Git, task, approval, command-execution, or project-switching features in this Marketplace release.

## Connect

1. Install GitHub Copilot Chat and sign in to Copilot.
2. Open exactly one local workspace folder and trust it in VS Code.
3. Open VSLink from the Activity Bar and choose **Pair with VSLink**.
4. Complete pairing in your browser, then return to VS Code.
5. Choose **Connect current workspace** when you want to use Copilot Chat in VSLink.
6. Review the confirmation and approve **Connect**.

Pairing an account does not connect the workspace or read chat. Each new VS Code launch begins disconnected. Disconnecting stops chat polling and relay reconnection immediately.

## Data used while connected

After manual approval, VSLink reads saved Copilot conversations from the current workspace, including earlier chats, and relays:

- Visible user prompts
- Visible completed assistant answers
- Workspace name and VS Code's workspace identifier

VSLink filters out and does not relay:

- File contents
- Attachment/reference payloads and their file-path metadata
- Terminal commands or output
- Git data
- Tool calls and tool results
- Approval controls
- Copilot thinking or hidden reasoning data
- Recent projects, machine ID, or workspace filesystem path

Copilot chats can still contain code, secrets, logs, or other sensitive information that you or Copilot included in visible messages. Review the connection disclosure before connecting.
If a file path is written directly into a visible prompt or answer, it is part of that visible text and will be relayed.

Traffic uses WSS/TLS to the VSLink relay. The current relay can process relayed content in order to forward it to your browser; it is not end-to-end encrypted in this release. See the [VSLink Privacy Policy](https://vslink.dev/privacy-policy).

## Chat storage compatibility

VS Code does not currently provide a stable public API for other extensions to enumerate existing native Copilot Chat sessions. VSLink therefore reads the current workspace's local `chatSessions` files while connected. This is an unsupported VS Code storage format and may change in a future VS Code release.

The platform-specific base locations differ, but VSLink uses the same `.jsonl`/`.json` parser everywhere:

- macOS: `~/Library/Application Support/Code/User/workspaceStorage/<id>/chatSessions/`
- Windows: `%APPDATA%\Code\User\workspaceStorage\<id>\chatSessions\`
- Linux: `~/.config/Code/User/workspaceStorage/<id>/chatSessions/`

VSLink derives the active workspace identifier from VS Code's extension storage context. It does not scan other workspace histories.

## Commands

- `Vslink Copilot: Connect Current Workspace`
- `Vslink Copilot: Disconnect Current Workspace`
- `Vslink Copilot: Pair Account`
- `Vslink Copilot: Unpair This Editor`
- `Vslink Copilot: Show Connection Log`

## Requirements and limitations

- VS Code 1.93 or newer
- GitHub Copilot Chat installed and available
- Exactly one trusted local workspace folder
- A VSLink account and internet connection

The latest chat is inferred from the most recently modified session file containing visible messages. The browser preserves your selected conversation as the list updates. Earlier conversations are read-only; select the latest chat or start a New Chat to send. This release does not remotely switch VS Code to an earlier conversation.

Valid empty drafts are excluded; unreadable or malformed files produce an error instead of omitting a conversation. The per-file read limit is 4 MB, and the combined relayed inbox is limited to 4 MB; larger histories fail visibly rather than sending a partial inbox. Existing per-session text limits remain unchanged. VS Code storage changes can temporarily break history display until VSLink is updated.

## Support

- [VSLink website](https://vslink.dev)
- [Issue tracker](https://github.com/dev-tahir/vscode-link/issues)

GitHub, GitHub Copilot, Microsoft, and Visual Studio Code are trademarks of their respective owners. VSLink is not affiliated with or endorsed by GitHub or Microsoft.

## License

See [LICENSE.txt](https://github.com/dev-tahir/vscode-link/blob/HEAD/LICENSE.txt).
