# Vslink Copilot

Continue the GitHub Copilot Chat already running in your desktop VS Code from any browser. Pair one trusted workspace, connect when you choose, then read earlier conversations, send a message to the active chat, or start a new native Copilot conversation.

VSLink does not add remote terminal, file, or Git controls to this extension. Copilot continues to use the model and tool permissions selected in VS Code.

## Install

### VS Code Marketplace

1. Open **Extensions** in VS Code.
2. Search for **Vslink Copilot** and select **Install**.
3. Install and sign in to **GitHub Copilot Chat**.
4. Open exactly one trusted local workspace folder.

You can also open the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=vslink.vslink-copilot) directly.

### Run from source

```sh
git clone https://github.com/vslink-dev/vslink.git
cd vslink
npm install --ignore-scripts
npm test
code .
```

Press **F5** in VS Code to open an Extension Development Host.

## Connect

1. Open **Vslink Copilot** from the Activity Bar.
2. Choose **Pair with VSLink** and finish pairing at [vslink.dev](https://vslink.dev).
3. Return to VS Code and choose **Connect**.
4. Open the VSLink web app in your browser.

Each VS Code launch starts disconnected. Viewing an older browser conversation does not switch the chat currently active in VS Code. If a sent message is not confirmed, check VS Code before retrying.

Requires VS Code **1.137+**, GitHub Copilot access, and a paid VSLink subscription. There is no free trial. [View pricing](https://vslink.dev/pricing).

## Privacy and encryption

While connected, visible chat text and conversation/workspace metadata pass through the VSLink relay. Production currently protects transport with TLS. Client-side end-to-end encryption is planned; until that update ships, only connect chats you are comfortable sending through the relay. Visible text is not secret-redacted. See **What Connect shares** in the sidebar and the [privacy policy](https://vslink.dev/privacy-policy).

## Development

`npm test` runs the source, pairing, parser, relay, native-chat, consent, and sidebar checks. Native Copilot chat storage is an internal VS Code format and can change between releases. See the [publication checklist](POLICY_REVIEW.md).

[Report an issue](https://github.com/vslink-dev/vslink/issues) · [License](LICENSE.txt)

Not affiliated with or endorsed by Microsoft or GitHub.
