import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { WakeDeferredError, type Binding, type WakeAdapter } from "./agent-mailbox-monitor.js";

interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  messagingSocketPath: string;
  status?: string;
  parked: boolean;
}

const owned = (info: { uid: number }) => typeof process.getuid !== "function" || info.uid === process.getuid();

function supportedVersion(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 282)));
}

/** Wakes the existing session through Claude's native inbox; never starts a model process. */
export class ClaudeMailboxAdapter implements WakeAdapter {
  // Claude queues native inbox notices between tool calls without interrupting a running tool.
  readonly canQueueWhileBusy = true;
  private readonly cwd: string;
  private readonly registryDir: string;

  constructor(options: { cwd: string; registryDir?: string }) {
    this.cwd = options.cwd;
    this.registryDir = options.registryDir ?? join(homedir(), ".claude", "sessions");
  }

  private async resolve(binding: Binding): Promise<ClaudeSession | null> {
    try {
      const directory = await lstat(this.registryDir);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !owned(directory) || (directory.mode & 0o022)) return null;
      const cwd = await realpath(this.cwd);
      for (const name of await readdir(this.registryDir)) {
        if (!/^[1-9]\d*\.json$/.test(name)) continue;
        const pid = Number(name.slice(0, -5));
        let handle;
        try {
          handle = await open(join(this.registryDir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const info = await handle.stat();
          if (!info.isFile() || !owned(info) || (info.mode & 0o022) || info.size > 16_384) continue;
          const record = JSON.parse(await handle.readFile("utf8"));
          if (record.pid !== pid || record.sessionId !== binding.sessionId || record.peerProtocol !== 1 || !supportedVersion(record.version)) continue;
          if (typeof record.cwd !== "string" || !isAbsolute(record.cwd) || await realpath(record.cwd) !== cwd) continue;
          const socketPath = record.messagingSocketPath;
          if (typeof socketPath !== "string" || !isAbsolute(socketPath)) continue;
          const socket = await lstat(socketPath);
          if (!socket.isSocket() || socket.isSymbolicLink() || !owned(socket) || (socket.mode & 0o077)) continue;
          process.kill(pid, 0);
          // A parent can report idle while parked behind a background fork; its socket does not wake that fork.
          return { pid, sessionId: record.sessionId, cwd, messagingSocketPath: socketPath, status: record.status,
            parked: record.parkedJobId != null && record.parkedJobId !== "" };
        } catch {
          // Stale, unreadable, or malformed registry records are not recipients.
        } finally {
          await handle?.close();
        }
      }
    } catch {
      // A missing or unsafe registry cannot prove that the recipient is available.
    }
    return null;
  }

  async probe(binding: Binding): Promise<"idle" | "busy" | "offline"> {
    const session = await this.resolve(binding);
    return session === null || session.parked ? "offline" : session.status === "idle" ? "idle" : "busy";
  }

  /** Resolution means the notice was offered, not processed or acknowledged by Claude. */
  async wake(binding: Binding, notice: string): Promise<void> {
    if (!notice.trim() || Buffer.byteLength(notice) > 16_000) throw new Error("Invalid mailbox wake notice");
    const session = await this.resolve(binding);
    if (!session) throw new WakeDeferredError("Claude mailbox recipient is unavailable");
    if (session.parked) throw new WakeDeferredError("Claude mailbox recipient is parked behind another job");
    if (session.status !== "idle" && session.status !== "busy") {
      throw new WakeDeferredError("Claude mailbox recipient status is unknown");
    }
    const frame = JSON.stringify({
      type: "user",
      message: { role: "user", content: notice },
      msg_id: `mailbox-wake-${randomUUID()}`,
    }) + "\n";
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(session.messagingSocketPath);
      const timer = setTimeout(() => finish(new Error("Claude mailbox wake timed out")), 2_000);
      let settled = false;
      function finish(error?: Error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve();
      }
      socket.once("error", finish);
      socket.once("connect", () => socket.end(frame, () => finish()));
      socket.once("close", () => finish(new Error("Claude mailbox connection closed before offering notice")));
    });
  }
}
