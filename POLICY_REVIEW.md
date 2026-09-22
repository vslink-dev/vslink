# Publication checklist — 15 September 2026

Scope: the current extension source in `vslink-complient-final`. No worker, server, website policy, Marketplace account, or installed extension was changed. An extension audit cannot certify Microsoft's acceptance or guarantee against removal.

## Implemented

- [x] Remove the misleading Trial label. Marketplace's `Free` label describes installation; the description, README, and sidebar prominently require a paid service with no trial.
- [x] Set the engine minimum to the native-command version actually checked, VS Code 1.137.0.
- [x] Describe saved history, visible canceled/error answers, metadata, account storage, relay access, and the effects of prompts under Copilot's existing permissions.
- [x] Preserve manual pairing/Connect and informational consent styling. Validate that the workspace and pairing did not change during confirmation.
- [x] Reject invalid/missing pairing endpoints; never substitute production for a bad local URL. Save new pairing credentials only after their endpoint metadata is saved.
- [x] Remove URL credentials. Use the Authorization header and the existing registration body. Wait for registration before claiming Connected or accepting chat commands. Auth/protocol failures stop with an error.
- [x] Protect JSONL paths against prototype traversal, invalid mutations and indices. Handle initial-state replacement, deletion and array truncation using the inspected VS Code format.
- [x] Filter transcript-hidden requests, constrain response extraction to display markdown, preserve literal text, and remove silent last-200-request truncation. Explicit errors replace silent text clipping and parse/mutation skips.
- [x] Confirm Send and New Chat through newly recorded JSONL prompts; prevent concurrent remote submissions and stale/wrong-session reply success. No automatic prompt resend.
- [x] Add isolated regression tests. No real Copilot prompt or production account was used to test these changes.

## Still required before publishing

- [ ] **Native history permission:** obtain written Marketplace/Microsoft clarification about user-consented background reading of the current workspace's native Copilot JSONL/JSON storage. No stable session-enumeration API or explicit permission for this exact use was established. This feature was retained, not silently replaced or certified.
- [ ] **Production relay:** update the worker to authenticate the Authorization header and verify real deployment compatibility. The inspected original worker requires the URL token; this extension intentionally will not send one. Confirm server-side user/workspace authorization before `registration_confirmed`, consistent with the local flow.
- [ ] **Credential lifecycle:** implement and test server-side revocation and an account/device removal flow. Local Unpair currently only removes this editor's copy. Determine rotation/expiry requirements before publication.
- [ ] **Website privacy and service terms:** verify the public privacy page is reachable, accurate and prominent. Document real retention, logs, subprocessors, deletion/contact procedures and credential handling. The audit could not independently retrieve the policy page; that is not proof it is broken. Do not invent a no-storage or no-logging claim.
- [ ] **Marketplace ownership/listing:** verify publisher ownership, repository/issue URLs, trademark presentation, pricing text, license and support links on the final listing. An unpublished local manifest does not verify these external settings.
- [ ] **Live compatibility:** manually test native Send/New Chat and history rendering on supported VS Code versions and macOS/Windows/Linux, then run an end-to-end test with the intended webapp and updated relay. Synthetic tests do not establish production behavior or Microsoft policy acceptance.

End-to-end encryption is not implemented and is not represented as a blanket Marketplace requirement. A compliant transport design still needs truthful disclosures and appropriate server-side controls. Decide E2EE architecture separately if desired.

## Source basis

- [Visual Studio Marketplace Terms of Use](https://aka.ms/vsmarketplace-ToU): disclosure/privacy and publisher responsibilities; prohibited or misleading behavior and removal powers. The September 2025 document was reviewed. Its general rules do not resolve the specific native-storage-reading question by themselves.
- [Extension pricing label](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#extension-pricing-label): supported manifest pricing labels are Free and Trial, not Paid.
- [VS Code 1.109 agent-session management](https://code.visualstudio.com/updates/v1_109#_agent-session-management): New Local Chat command introduction. This is not evidence that all current command arguments work on 1.109; the implementation's checked baseline is 1.137.0.
- [VS Code commands guide](https://code.visualstudio.com/api/extension-guides/command) and [maintainer discussion on opening Chat](https://github.com/microsoft/vscode-discussions/discussions/2480): native command integration. Neither provides a durable message-delivery receipt.
- [ChatContext API](https://code.visualstudio.com/api/references/vscode-api#ChatContext): participant context is not an API to enumerate all existing native Copilot conversations.
- [Proposed API restrictions](https://code.visualstudio.com/api/advanced-topics/using-proposed-api): proposed APIs are not used in this extension.
- [Extension runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security): trust and extension access/security context.
- [Microsoft guidance on access-token logging](https://learn.microsoft.com/en-us/aspnet/core/signalr/security#access-token-logging): URL-token logging exposure. This supports reducing exposure, not a claim that URL tokens are automatically banned.

JSONL mutation and markdown serialization behavior was also checked against the installed VS Code 1.137.0 workbench implementation. Internal format compatibility is not a public API guarantee or authorization to publish a storage reader.
