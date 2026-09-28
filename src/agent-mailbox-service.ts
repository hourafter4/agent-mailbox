import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MailboxMonitor } from './agent-mailbox-monitor.js';
import { CodexMailboxAdapter } from './agent-mailbox-codex.js';
import { ClaudeMailboxAdapter } from './agent-mailbox-claude.js';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../bin/agent-mailbox.mjs', import.meta.url));

function resolveWorkspace(workspace: string): string {
  const resolved = fs.realpathSync(workspace);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Mailbox workspace must be an existing directory');
  return resolved;
}

export function createMailboxMonitor(root: string, workspace: string = process.cwd()) {
  const cwd = resolveWorkspace(workspace);
  return new MailboxMonitor(root, {
    codex: new CodexMailboxAdapter({ cwd }),
    claude: new ClaudeMailboxAdapter({ cwd }),
  });
}

function servicePaths(root: string) {
  const label = `com.agent-mailbox.${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12)}`;
  return {
    label, target: `gui/${process.getuid!()}/${label}`,
    plist: path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
    runtime: path.join(path.resolve(root), 'runtime'),
  };
}
const xml = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]!));

export async function startMailboxService(root: string, restart = false, workspace: string = process.cwd()) {
  if (process.platform !== 'darwin') throw new Error('Background service installation currently supports macOS. Use monitor-run in a persistent terminal elsewhere.');
  const cwd = resolveWorkspace(workspace);
  const p = servicePaths(root);
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  fs.mkdirSync(p.runtime, { recursive: true, mode: 0o700 });
  const args = [process.execPath, script, '--workspace', cwd, '--root', path.resolve(root), 'monitor-run'];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(p.label)}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(cwd)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(path.join(p.runtime, 'monitor.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(p.runtime, 'monitor.log'))}</string>
</dict></plist>\n`;
  const previous = fs.existsSync(p.plist) ? fs.readFileSync(p.plist, 'utf8') : undefined;
  let loaded = false;
  try { await exec('/bin/launchctl', ['print', p.target]); loaded = true; } catch { /* not installed */ }
  if (loaded && previous !== plist) { await exec('/bin/launchctl', ['bootout', p.target]); loaded = false; }
  fs.writeFileSync(p.plist, plist, { mode: 0o600 });
  if (!loaded) await exec('/bin/launchctl', ['bootstrap', `gui/${process.getuid!()}`, p.plist]);
  else await exec('/bin/launchctl', ['kickstart', ...(restart ? ['-k'] : []), p.target]);
  return { label: p.label, installed: true, plist: p.plist };
}

export async function stopMailboxService(root: string) {
  if (process.platform !== 'darwin') throw new Error('Stop the foreground monitor process on this platform.');
  const p = servicePaths(root);
  let loaded = false;
  try { await exec('/bin/launchctl', ['print', p.target]); loaded = true; } catch { /* already stopped */ }
  if (loaded) await exec('/bin/launchctl', ['bootout', p.target]);
  fs.rmSync(p.plist, { force: true });
  return { label: p.label, installed: false };
}

export function mailboxServiceStatus(root: string): { running: boolean; pid?: number; at?: string; error?: string } {
  const heartbeat = path.join(path.resolve(root), 'runtime', 'heartbeat.json');
  if (!fs.existsSync(heartbeat)) return { running: false };
  const last = JSON.parse(fs.readFileSync(heartbeat, 'utf8')) as { pid: number; at: string; error?: string };
  let alive = false;
  try { process.kill(last.pid, 0); alive = true; } catch { /* stopped */ }
  return { running: alive && Date.now() - Date.parse(last.at) < 15000, ...last };
}

/** The listening socket is the process lock; it also lets us recognize a live owner. */
async function lockMonitor(runtime: string): Promise<net.Server> {
  const startupClaim = path.join(runtime, 'monitor-starting');
  // Serialize stale-socket recovery too: two starters must never unlink a new owner.
  fs.mkdirSync(startupClaim, { mode: 0o700 });
  try { return await lockMonitorSocket(runtime); }
  finally { fs.rmdirSync(startupClaim); }
}

async function lockMonitorSocket(runtime: string): Promise<net.Server> {
  const socketPath = path.join(runtime, 'monitor.sock');
  if (fs.existsSync(socketPath)) {
    const original = fs.lstatSync(socketPath);
    if (!original.isSocket() || original.uid !== process.getuid?.()) throw new Error('Unsafe monitor lock path');
    const live = await new Promise<boolean>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const finish = (value: boolean) => { clearTimeout(timer); socket.destroy(); resolve(value); };
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Monitor lock probe timed out')); }, 1000);
      socket.once('connect', () => finish(true));
      socket.once('error', error => {
        if (['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) finish(false);
        else { clearTimeout(timer); reject(error); }
      });
    });
    if (live) throw new Error('A mailbox monitor is already running');
    try {
      const current = fs.lstatSync(socketPath);
      if (current.ino !== original.ino) throw new Error('Monitor lock changed; try again');
      fs.unlinkSync(socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const server = net.createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); resolve(); });
  });
  return server;
}

export async function runMailboxService(root: string, workspace: string = process.cwd()) {
  const monitor = createMailboxMonitor(root, workspace);
  const runtime = path.join(path.resolve(root), 'runtime');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const lock = await lockMonitor(runtime);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let previousError: string | undefined;
  try {
    while (!controller.signal.aborted) {
      let error: string | undefined;
      try { await monitor.tick(); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      if (error !== previousError) {
        console.error(`${new Date().toISOString()} ${error ?? 'Monitor recovered'}`);
        previousError = error;
      }
      const temporary = path.join(runtime, `heartbeat.${process.pid}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), error }), { mode: 0o600 });
      fs.renameSync(temporary, path.join(runtime, 'heartbeat.json'));
      await delay(1000, undefined, { signal: controller.signal }).catch(cause => { if (!controller.signal.aborted) throw cause; });
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await new Promise<void>(resolve => lock.close(() => resolve()));
  }
}
