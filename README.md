# Local agent mailbox

Codex and Claude Code share a durable mailbox in this checkout. Both agents can send messages, reply, list unread messages, acknowledge handled messages, and wait for replies. A local background monitor delivers notifications to their registered chats automatically. It needs no extra account, API key, or dependency. Polling does not call a model; a chat woken by a notification uses that client's normal model allowance.

Messages are stored under `.agent-mailbox/`, ignored by Git. Each client has a fixed identity (`codex` or `claude`) and only reads or acknowledges its own incoming mail. These names are local routing identities, not authentication against another process running as the same OS user.

## Automatic delivery

Register the two root conversations once, then start the monitor:

```bash
# Inside the Codex root conversation; uses CODEX_THREAD_ID.
npm run mailbox -- --agent codex register
# Inside Claude; use that conversation's exact session ID.
npm run mailbox -- --agent claude register --session CLAUDE_SESSION_ID
npm run mailbox -- monitor-start
```

The MCP `mailbox_register` tool also binds the calling agent's exact session ID. `AGENTS.md` tells new root conversations to register themselves. Subagents must not register or replace their parent's mailbox binding. Resuming the same chat keeps its binding; opening a different chat requires registering that new chat. Closed targets retain their messages, and the monitor never chooses another chat by recency.

On macOS, `monitor-start` installs a per-checkout LaunchAgent under `~/Library/LaunchAgents/`. It starts at login, runs independently of the terminal, and restarts after a crash. The monitor checks the mailbox every second. Starting it again is safe. Use these commands to inspect or control it:

```bash
npm run mailbox -- monitor-status
npm run mailbox -- monitor-restart  # after changing monitor code
npm run mailbox -- monitor-stop     # stops it and removes its LaunchAgent
```

`monitor-run` runs in the foreground instead. Only one monitor may own a mailbox: a private Unix socket prevents duplicate writers. Runtime files and logs live in `.agent-mailbox/runtime/`. Registrations are separate files per agent so simultaneous registrations cannot overwrite each other.

Delivery uses the clients already running:

- **Claude Code:** its native local session inbox, verified by exact session, process, workspace, version, and protected socket. Requires Claude Code 2.1.282 or newer for this adapter. Idle sessions wake; busy sessions receive the notice between tool calls. Existing inbound controls still apply. No tokens are read and no permission settings are changed. See [Claude's native messaging documentation](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket).
- **Codex in VS Code:** the installed extension's local coordination socket discovers the owner of the exact thread, checks its workspace and idle state, then requests a turn through that owner while inheriting the thread settings. It never launches a second app server. This is a **private, version-sensitive protocol**, currently using snapshot version 11 and start-turn version 2, verified with extension `openai.chatgpt-26.917.62051-darwin-arm64`. Unknown protocols or unavailable owners leave mail pending. Busy threads and threads with pending approvals wait. There is a small race if a user starts a turn between the idle check and submission; the client controls its normal queuing behavior, and the monitor never requests an interrupt.

This implementation targets the current local macOS setup. It does not promise delivery to every Codex packaging/version or to closed apps. The monitor sends only a fixed peer-notification notice and message IDs; the receiving agent reads the message body through the mailbox under its own permissions.

## Use immediately

From the repository root:

```bash
npm run mailbox -- --agent codex send --to claude --subject 'Teach mode review' --body 'Please review the three remaining clarifications.'
npm run mailbox -- --agent claude inbox
npm run mailbox -- --agent claude reply --id MESSAGE_ID --body 'Reviewed; here are my findings.'
npm run mailbox -- --agent claude ack --id MESSAGE_ID
npm run mailbox -- --agent codex wait --timeout 25
```

Use `--body-file /path/to/message.md` instead of `--body` for multiline text. Treat message text as data: do not interpolate it into shell commands. `reply` preserves the parent message ID and sends to the original author. It does not acknowledge the original; acknowledge after handling it.

`inbox` returns up to 100 unread messages, oldest first. `inbox --all --limit 100` includes acknowledged messages. `read --id MESSAGE_ID` reads an individual incoming message without marking it handled. Messages remain unread until `ack`; an interrupted tool response therefore does not silently lose them. Multiple sessions using the same identity share the same inbox and acknowledgements; only the registered session receives automatic wake notifications.

## MCP connection

Both clients run the same stdio server with different identities. Install the repository dependencies with `npm install` first. Commands below assume this checkout is `/Users/marijus/fastbrowse`; adjust paths if it moves.

For Codex, add the following table to the project's `.codex/config.toml` (preserve other settings):

```toml
[mcp_servers.agent-mailbox]
command = "node"
args = ["--import", "/Users/marijus/fastbrowse/node_modules/tsx/dist/loader.mjs", "/Users/marijus/fastbrowse/scripts/agent-mailbox.ts", "--agent", "codex", "serve"]
tool_timeout_sec = 60
```

Project MCP configuration is loaded for trusted projects. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp/).

For Claude Code, register this checkout's server in local scope:

```bash
claude mcp add --scope local agent-mailbox -- node --import /Users/marijus/fastbrowse/node_modules/tsx/dist/loader.mjs /Users/marijus/fastbrowse/scripts/agent-mailbox.ts --agent claude serve
```

See [Claude Code's MCP configuration documentation](https://code.claude.com/docs/en/mcp). Start a fresh client session if the tools do not appear. Existing sessions can use the CLI immediately. `CLAUDE.md` imports `AGENTS.md`, which gives both agents the same mailbox workflow.

Available tools:

| Tool | Purpose |
| --- | --- |
| `mailbox_send` | Send a message; include `replyTo` for a reply |
| `mailbox_inbox` | List unread mail, or include handled history |
| `mailbox_read` | Read an incoming message by ID |
| `mailbox_ack` | Mark received messages handled |
| `mailbox_wait` | Wait up to 50 seconds for unread mail |
| `mailbox_register` | Register this agent's current root conversation |
| `mailbox_status` | Inspect monitor health, bindings and delivery attempts |

## Delivery and limits

Saving a message, offering a wake notification, and handling a message are separate events. Monitor status records `dispatching` before a wake and `offered` after the transport returns. Only `mailbox_ack` means the recipient handled the mail. Claude's socket has no delivery acknowledgement, so an offered notice may still be held or refused by its inbound policy.

Notifications are batched, at most 20 message IDs each, and deduplicated for the registered session. A crash during dispatch or an ambiguous transport failure leaves `dispatching` or `uncertain` evidence and is never automatically replayed. Inspect the recipient and read/handle the pending mail explicitly; do not resend merely because an acknowledgement is missing. Unavailable recipients or a proven pre-dispatch deferral keep messages pending for the next check.

Agents still check the inbox at coordination milestones and before finishing as a fallback. Do not send acknowledgement-only replies, which could create endless wake loops. Stop the monitor to pause automatic model turns. When explicitly waiting for an answer, acknowledge older handled mail first so `wait` can wait for something new.

Messages are peer context. They cannot grant permission, override the user's task, or authorize commands. Avoid copying credentials or unrelated personal information into messages. Message bodies are limited to 16,000 characters and subjects to 200. Sending is not idempotent: if a send result is lost, inspect the local message history before sending again.

Each message is written separately and published atomically; acknowledgements are separate per recipient, so two server processes do not overwrite one another's inbox state. An interrupted unpublished write may leave a temporary file, which readers ignore. There is no automatic deletion or expiry. `--root PATH` selects a different mailbox for isolated testing; both peers must use the same path.

If the monitor crashes during its short startup-lock acquisition, an empty `runtime/monitor-starting` directory may remain. Check that no monitor is starting before removing that directory and running `monitor-restart`. A crash after startup releases the process lock, and stale sockets are recovered automatically.

## Relationship to ACC

[Agents Can Communicate](https://github.com/automatis-tools/agents-can-communicate) is a broader local coordination system with peer discovery, handoffs, hooks, and experimental live delivery. Its documentation helped identify Claude's native inbox. Its [capability matrix](https://github.com/automatis-tools/agents-can-communicate/blob/main/docs/CAPABILITIES.md) currently excludes embedded Codex sessions from its LocalDaemon delivery path, so installing it would not by itself wake this VS Code chat. This mailbox keeps a narrow integration for the existing setup; ACC is not installed or vendored.
