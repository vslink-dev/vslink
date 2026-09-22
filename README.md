# Vslink Copilot

Use your VS Code Copilot chats from a browser:

- Read current and earlier conversations from one workspace.
- Start a new chat in VS Code’s native Copilot Chat.
- Send prompts to the conversation currently active in VS Code.

Requires **VS Code 1.137+**, GitHub Copilot access, and one trusted local workspace folder. **A paid VSLink subscription is required; no free trial.** [Pricing](https://vslink.dev/pricing).

## Connect

1. Open your workspace and sign in to Copilot in VS Code.
2. Open the **Vslink Copilot** sidebar and pair your account on the website.
3. Return to VS Code, click **Connect**, and open [VSLink](https://vslink.dev) in your browser.

Each VS Code launch starts disconnected. Disconnect anytime from the sidebar.

Viewing an older chat in the browser does **not** switch the active chat in VS Code. Copilot uses your existing model and tool permissions. If sending isn’t confirmed, check VS Code before retrying.

## Privacy

While connected, visible chat text and conversation/workspace metadata pass through the VSLink relay. Text is not secret-redacted. Production uses TLS, **not end-to-end encryption**; the relay can read the content. See **What Connect shares** in the sidebar and the [privacy policy](https://vslink.dev/privacy-policy).

## Development

```sh
npm install --ignore-scripts
npm test
```

Extension source only; no server or worker. Native chat storage can change between VS Code releases. Production relay compatibility and publication checks remain outstanding: [checklist](POLICY_REVIEW.md).

[Report an issue](https://github.com/vslink-dev/vslink/issues) · [License](LICENSE.txt)

Not affiliated with or endorsed by Microsoft or GitHub.
