import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
const binary = fileURLToPath(new URL('../bin/agent-mailbox.mjs', import.meta.url));
const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-mailbox-mcp-')); roots.push(root); return root; }
async function connect(agent: string, root: string) {
  const client = new Client({ name: `test-${agent}`, version: '1' });
  clients.push(client);
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['--import', loader, script, '--agent', agent, '--root', root, 'serve'],
    cwd: os.tmpdir(), stderr: 'pipe',
  }));
  return client;
}
function parsed(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as { type: string; text: string }[];
  expect(result.isError, content[0]?.text).not.toBe(true);
  return JSON.parse(content[0].text);
}

it('exchanges messages between two real stdio MCP processes and keeps read mail until ack', async () => {
  const root = temp();
  const [codex, claude] = await Promise.all([connect('codex', root), connect('claude', root)]);
  expect((await codex.listTools()).tools.map(tool => tool.name).sort()).toEqual(['mailbox_ack', 'mailbox_inbox', 'mailbox_read', 'mailbox_register', 'mailbox_send', 'mailbox_status', 'mailbox_wait']);
  const sent = parsed(await codex.callTool({ name: 'mailbox_send', arguments: { to: 'claude', subject: 'Review', body: 'Line one\nLine two — č' } }));
  const received = parsed(await claude.callTool({ name: 'mailbox_wait', arguments: { timeoutMs: 1000 } }));
  expect(received[0]).toMatchObject({ id: sent.id, body: 'Line one\nLine two — č', read: false });
  parsed(await claude.callTool({ name: 'mailbox_read', arguments: { id: sent.id } }));
  expect(parsed(await claude.callTool({ name: 'mailbox_inbox', arguments: {} }))).toHaveLength(1);
  const reply = parsed(await claude.callTool({ name: 'mailbox_send', arguments: { to: 'codex', subject: 'Re: Review', body: 'Looks good', replyTo: sent.id } }));
  parsed(await claude.callTool({ name: 'mailbox_ack', arguments: { ids: [sent.id] } }));
  expect(parsed(await claude.callTool({ name: 'mailbox_inbox', arguments: {} }))).toEqual([]);
  expect(parsed(await claude.callTool({ name: 'mailbox_inbox', arguments: { includeRead: true } }))[0].read).toBe(true);
  expect(parsed(await codex.callTool({ name: 'mailbox_inbox', arguments: {} }))[0]).toMatchObject({ id: reply.id, replyTo: sent.id });
  expect((await codex.callTool({ name: 'mailbox_ack', arguments: { ids: [sent.id] } })).isError).toBe(true);
});

it('rejects invalid MCP arguments without creating messages', async () => {
  const root = temp();
  const client = await connect('codex', root);
  for (const args of [
    { to: '../outside', subject: 'x', body: 'x' },
    { to: 'codex', subject: 'x', body: 'x' },
    { to: 'claude', subject: 'x', body: ' ' },
    { to: 'claude', subject: 'x', body: 'x', replyTo: '../outside' },
  ]) expect((await client.callTool({ name: 'mailbox_send', arguments: args })).isError).toBe(true);
  expect((await client.callTool({ name: 'mailbox_wait', arguments: { timeoutMs: 51000 } })).isError).toBe(true);
});

it('CLI file bodies preserve literal shell syntax and replies route to the original sender', async () => {
  const root = temp();
  const file = path.join(root, 'message.md');
  const body = 'Literal `command` and $(command)\nA second line.';
  fs.writeFileSync(file, body);
  const cli = async (agent: string, args: string[]) => JSON.parse((await exec(process.execPath, ['--import', loader, script, '--agent', agent, '--root', root, ...args], { cwd: os.tmpdir() })).stdout);
  const sent = await cli('codex', ['send', '--to', 'claude', '--subject', 'Review', '--body-file', file]);
  expect((await cli('claude', ['inbox']))[0].body).toBe(body);
  const reply = await cli('claude', ['reply', '--id', sent.id, '--body', 'Done']);
  expect(reply).toMatchObject({ from: 'claude', to: 'codex', replyTo: sent.id, subject: 'Re: Review' });
  await cli('claude', ['ack', '--id', sent.id]);
  expect(await cli('claude', ['wait', '--timeout', '0'])).toEqual([]);
  await expect(cli('claude', ['wait', '--timeout', '100'])).rejects.toThrow();
});

it('standalone binary isolates projects and honors workspace from an unrelated working directory', async () => {
  const base = temp();
  const first = path.join(base, 'project with spaces');
  const second = path.join(base, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  const cli = async (cwd: string, args: string[]) => JSON.parse((await exec(process.execPath, [binary, ...args], { cwd })).stdout);
  const sent = await cli(os.tmpdir(), ['--workspace', first, '--agent', 'codex', 'send', '--to', 'claude', '--subject', 'First workspace', '--body', 'Scoped message']);
  expect(await cli(second, ['--agent', 'claude', 'inbox'])).toEqual([]);
  expect((await cli(first, ['--agent', 'claude', 'inbox']))[0].id).toBe(sent.id);
  const status = await cli(os.tmpdir(), ['--workspace', first, 'monitor-status']);
  expect(status.workspace).toBe(fs.realpathSync(first));
  expect(status.root).toBe(path.join(fs.realpathSync(first), '.agent-mailbox'));
});
