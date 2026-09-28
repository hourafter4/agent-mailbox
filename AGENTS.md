# Agent mailbox

This is an independent repository for reusable local Codex/Claude communication. Keep project-specific state, session IDs, MCP registrations and launchd files out of Git. The default mailbox belongs to the selected workspace, not this tool checkout.

Use subagents for independent work with non-overlapping file ownership. Run `npm test` and `npm run typecheck` before committing. Do not widen client permissions or replay uncertain wakeups. Native transport success only means offered; explicit mailbox acknowledgement means handled.
