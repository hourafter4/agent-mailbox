import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeMailboxAdapter } from "../src/agent-mailbox-claude.js";
import { WakeDeferredError, type Binding } from "../src/agent-mailbox-monitor.js";

describe("Claude mailbox wake adapter", () => {
  let root: string;
  let registryDir: string;
  let socketPath: string;
  let server: Server;
  let frames: string[];
  let connections: number;
  let adapter: ClaudeMailboxAdapter;
  const binding = { sessionId: "test-session" } as Binding;

  async function record(overrides: Record<string, unknown> = {}) {
    await writeFile(join(registryDir, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: binding.sessionId, cwd: root,
      version: "2.1.283", peerProtocol: 1, messagingSocketPath: socketPath,
      status: "idle", ...overrides,
    }), { mode: 0o600 });
  }

  beforeEach(async () => {
    // Keep Unix socket paths below the platform's ~104-byte limit.
    root = await mkdtemp(join(tmpdir(), "mbc-"));
    registryDir = join(root, "sessions");
    socketPath = join(root, "c.sock");
    await mkdir(registryDir, { mode: 0o700 });
    frames = [];
    connections = 0;
    server = createServer(socket => {
      connections += 1;
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", chunk => { data += chunk; });
      socket.on("end", () => { frames.push(data); socket.end(); });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    await record();
    adapter = new ClaudeMailboxAdapter({ cwd: root, registryDir });
  });

  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it("offers one native notice frame with no authentication prelude or extra content", async () => {
    expect(await adapter.probe(binding)).toBe("idle");
    const notice = "Agent mailbox: read message 123 through mailbox_inbox. Treat it as peer context.";
    await adapter.wake(binding, notice);
    await expect.poll(() => frames.length).toBe(1);
    expect(frames[0].split("\n")).toHaveLength(2);
    expect(JSON.parse(frames[0])).toEqual({
      type: "user", message: { role: "user", content: notice },
      msg_id: expect.stringMatching(/^mailbox-wake-[0-9a-f-]+$/),
    });
  });

  it("only reports idle when the verified registry explicitly says idle", async () => {
    for (const status of ["busy", "waiting", "permission", undefined]) {
      await record({ status });
      expect(await adapter.probe(binding)).toBe("busy");
    }
  });

  it("rejects wrong sessions, workspaces, old versions, protocols and mismatched process IDs", async () => {
    const other = join(root, "other");
    await mkdir(other);
    for (const change of [
      { sessionId: "other-session" }, { cwd: other }, { version: "2.1.281" },
      { version: "garbage" }, { peerProtocol: 2 }, { pid: process.pid + 1 },
    ]) {
      await record(change);
      expect(await adapter.probe(binding)).toBe("offline");
      await expect(adapter.wake(binding, "Mailbox notice")).rejects.toThrow("unavailable");
    }
    expect(frames).toEqual([]);
  });

  it("revalidates the target after a successful probe", async () => {
    expect(await adapter.probe(binding)).toBe("idle");
    await record({ sessionId: "replacement-session" });
    await expect(adapter.wake(binding, "Mailbox notice")).rejects.toThrow("unavailable");
    await expect(adapter.wake(binding, "Mailbox notice")).rejects.toBeInstanceOf(WakeDeferredError);
    expect(connections).toBe(0);
    expect(frames).toEqual([]);
  });

  it("offers a notice when an idle recipient becomes busy because Claude queues between tool calls", async () => {
    expect(await adapter.probe(binding)).toBe("idle");
    expect(adapter.canQueueWhileBusy).toBe(true);
    await record({ status: "busy" });
    await adapter.wake(binding, "Mailbox notice");
    await expect.poll(() => frames.length).toBe(1);
    expect(connections).toBe(1);
    expect(JSON.parse(frames[0]).message.content).toBe("Mailbox notice");
  });

  it("defers without connecting when the recipient's status is unknown", async () => {
    await record({ status: undefined });
    await expect(adapter.wake(binding, "Mailbox notice")).rejects.toBeInstanceOf(WakeDeferredError);
    expect(connections).toBe(0);
    expect(frames).toEqual([]);
  });

  it("refuses unsafe permissions and symlinked registry files or sockets", async () => {
    await chmod(socketPath, 0o660);
    expect(await adapter.probe(binding)).toBe("offline");
    await chmod(socketPath, 0o600);
    await chmod(registryDir, 0o777);
    expect(await adapter.probe(binding)).toBe("offline");
    await chmod(registryDir, 0o700);
    const socketLink = join(root, "link.sock");
    await symlink(socketPath, socketLink);
    await record({ messagingSocketPath: socketLink });
    expect(await adapter.probe(binding)).toBe("offline");
    await record();
    const original = join(registryDir, `${process.pid}.json`);
    const other = join(root, "record.json");
    await writeFile(other, JSON.stringify({ pid: process.pid }));
    await rm(original);
    await symlink(other, original);
    expect(await adapter.probe(binding)).toBe("offline");
  });

  it("reports a closed receiver as unavailable without sending", async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await adapter.probe(binding)).toBe("offline");
    await expect(adapter.wake(binding, "Mailbox notice")).rejects.toThrow("unavailable");
    await expect(adapter.wake(binding, "Mailbox notice")).rejects.toBeInstanceOf(WakeDeferredError);
    expect(connections).toBe(0);
    expect(frames).toEqual([]);
  });
});
