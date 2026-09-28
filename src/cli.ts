import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AgentMailbox, type Agent } from './agent-mailbox.js';
import { buildMailboxServer } from './agent-mailbox-server.js';
import { createMailboxMonitor, mailboxServiceStatus, runMailboxService, startMailboxService, stopMailboxService } from './agent-mailbox-service.js';

const help = `Local Codex ↔ Claude mailbox

agent-mailbox [--workspace /path/to/project] --agent codex <command> [options]

Commands:
  send --to claude --subject "Review" --body "Message"
  send --to claude --subject "Review" --body-file /path/to/message.md
  reply --id MESSAGE_ID --body "Reply"          Reply to received mail
  inbox [--all] [--limit 20]                   Unread, or all received mail
  read --id MESSAGE_ID                        Read without acknowledging
  ack --id MESSAGE_ID                         Mark handled
  wait [--timeout 25]                         Wait up to 50 seconds
  serve                                      Start the stdio MCP server
  register --session SESSION_ID              Bind this agent's existing chat
  unregister                                Stop waking this agent's chat
  monitor-start                             Install/start the macOS background monitor
  monitor-restart                           Restart after updating the monitor code
  monitor-status                            Show service, bindings and delivery attempts
  monitor-stop                              Stop and uninstall the background monitor
  monitor-run                               Run the monitor in the foreground

Use --agent claude on Claude's side. --workspace defaults to the current directory.
Messages stay in that workspace's .agent-mailbox directory; --root overrides the data path.
The monitor wakes registered idle chats. Claude can queue while busy; offline chats keep mail pending.
`;

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      agent: { type: 'string' }, root: { type: 'string' }, workspace: { type: 'string' }, to: { type: 'string' },
      subject: { type: 'string' }, body: { type: 'string' }, 'body-file': { type: 'string' },
      'reply-to': { type: 'string' }, id: { type: 'string' },
      session: { type: 'string' },
      all: { type: 'boolean' }, limit: { type: 'string' }, timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    }, allowPositionals: true,
  });
  if (values.help || !positionals.length) { console.log(help); return; }
  if (positionals.length !== 1) throw new Error('Supply exactly one command. See --help.');
  const workspace = fs.realpathSync(values.workspace ?? process.cwd());
  if (!fs.statSync(workspace).isDirectory()) throw new Error('--workspace must be a directory.');
  const root = path.resolve(values.root ?? path.join(workspace, '.agent-mailbox'));
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  switch (positionals[0]) {
    case 'monitor-start': print(await startMailboxService(root, false, workspace)); return;
    case 'monitor-restart': print(await startMailboxService(root, true, workspace)); return;
    case 'monitor-stop': print(await stopMailboxService(root)); return;
    case 'monitor-status': print({ workspace, root, service: mailboxServiceStatus(root), ...createMailboxMonitor(root, workspace).status() }); return;
    case 'monitor-run': await runMailboxService(root, workspace); return;
  }
  if (values.agent !== 'codex' && values.agent !== 'claude') throw new Error('--agent must be codex or claude.');
  const mailbox = new AgentMailbox(root, values.agent);
  const id = () => {
    if (!values.id) throw new Error('--id is required.');
    return values.id;
  };
  const body = () => {
    if ((values.body !== undefined) === (values['body-file'] !== undefined)) throw new Error('Provide exactly one of --body or --body-file.');
    if (values['body-file'] !== undefined) {
      if (fs.statSync(values['body-file']).size > 64000) throw new Error('Message file is too large (maximum 64 KB).');
      return fs.readFileSync(values['body-file'], 'utf8');
    }
    return values.body!;
  };
  switch (positionals[0]) {
    case 'register': {
      const sessionId = values.session ?? (values.agent === 'codex' ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_SESSION_ID);
      if (!sessionId) throw new Error('--session is required when the client does not expose its session ID.');
      const monitor = createMailboxMonitor(root, workspace);
      monitor.configure(values.agent, { sessionId });
      print({ registered: values.agent, sessionId });
      break;
    }
    case 'unregister': createMailboxMonitor(root, workspace).configure(values.agent, null); print({ unregistered: values.agent }); break;
    case 'send':
      if (!values.to || !values.subject) throw new Error('--to and --subject are required.');
      print(mailbox.send({ to: values.to as Agent, subject: values.subject, body: body(), replyTo: values['reply-to'] }));
      break;
    case 'reply': {
      const original = mailbox.read(id());
      const subject = values.subject ?? (original.subject.startsWith('Re: ') ? original.subject : `Re: ${original.subject}`).slice(0, 200);
      print(mailbox.send({ to: original.from, subject, body: body(), replyTo: original.id }));
      break;
    }
    case 'inbox': print(mailbox.inbox({ includeRead: values.all, limit: values.limit === undefined ? undefined : Number(values.limit) })); break;
    case 'read': print(mailbox.read(id())); break;
    case 'ack': mailbox.ack([id()]); print({ acknowledged: [id()] }); break;
    case 'wait': print(await mailbox.wait({ timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout) * 1000 })); break;
    case 'serve': {
      const server = buildMailboxServer(mailbox, workspace);
      await server.connect(new StdioServerTransport());
      const close = () => { void server.close().finally(() => process.exit(0)); };
      process.stdin.once('end', close);
      process.once('SIGTERM', close);
      process.once('SIGINT', close);
      break;
    }
    default: throw new Error(`Unknown command: ${positionals[0]}. See --help.`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
