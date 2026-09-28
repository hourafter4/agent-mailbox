import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexMailboxAdapter } from "../src/agent-mailbox-codex.js";
import type { Binding } from "../src/agent-mailbox-monitor.js";

describe("Codex mailbox wake adapter", () => {
  let root: string;
  let server: Server;
  let sockets: Set<Socket>;
  let messages: any[];
  let state: any;
  let fragment: boolean;
  let version: number;
  let startBehavior: "accept" | "disconnect" | "timeout";
  let adapter: CodexMailboxAdapter;
  const binding = { sessionId: "test-thread" } as Binding;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "codex-mail-"));
    chmodSync(root, 0o700);
    sockets = new Set(); messages = []; fragment = false; version = 11; startBehavior = "accept";
    state = { id: binding.sessionId, cwd: root, requests: [], threadRuntimeStatus: { type: "idle" } };
    const path = join(root, "ipc.sock");
    server = createServer(socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffer = Buffer.alloc(0);
      const send = (message: any) => {
        const body = Buffer.from(JSON.stringify(message));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        const frame = Buffer.concat([header, body]);
        if (fragment) { socket.write(frame.subarray(0, 2)); setImmediate(() => socket.write(frame.subarray(2))); }
        else socket.write(frame);
      };
      socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
          const length = buffer.readUInt32LE(0);
          const message = JSON.parse(buffer.subarray(4, length + 4).toString());
          buffer = buffer.subarray(length + 4); messages.push(message);
          const respond = (result: any) => send({ type: "response", requestId: message.requestId,
            resultType: "success", handledByClientId: "owner", result });
          if (message.method === "initialize") respond({ clientId: "mailbox-client" });
          else if (message.method === "thread-owner-discovery") respond({ supportsUntrustedAppInput: true });
          else if (message.method === "thread-stream-following-changed" && message.params.following) {
            send({ type: "broadcast", method: "thread-stream-state-changed", version, sourceClientId: "owner",
              params: { hostId: "local", conversationId: binding.sessionId,
                change: { type: "snapshot", revision: 1, conversationState: state } } });
          } else if (message.method === "thread-follower-start-turn") {
            if (startBehavior === "accept") respond({ result: { turn: { id: "new-turn" } } });
            else if (startBehavior === "disconnect") socket.destroy();
          }
        }
      });
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    chmodSync(path, 0o600);
    adapter = new CodexMailboxAdapter({ cwd: root, socketPath: path, timeoutMs: 100 });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it("probes and wakes the exact existing owner with inherited settings", async () => {
    expect(await adapter.probe(binding)).toBe("idle");
    await adapter.wake(binding, "A peer mailbox message is waiting.");
    const starts = messages.filter(message => message.method === "thread-follower-start-turn");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ version: 2, targetClientId: "owner", params: {
      conversationId: binding.sessionId, turnStart: { context: { inheritThreadSettings: true },
        request: { threadId: binding.sessionId, input: [{ type: "text", text: "A peer mailbox message is waiting." }] } } } });
    expect(starts[0].hostId).toBeUndefined();
    expect(starts[0].params.turnStart.request.clientUserMessageId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("reads fragmented frames and rechecks busy state before waking", async () => {
    fragment = true;
    expect(await adapter.probe(binding)).toBe("idle");
    state.threadRuntimeStatus.type = "active";
    expect(await adapter.probe(binding)).toBe("busy");
    await expect(adapter.wake(binding, "Mailbox")).rejects.toThrow("busy");
    expect(messages.some(message => message.method === "thread-follower-start-turn")).toBe(false);
  });

  it("treats pending approvals and uncertain submissions as busy", async () => {
    state.requests = [{ id: "approval" }];
    expect(await adapter.probe(binding)).toBe("busy");
    state.requests = []; state.unconfirmedTurnSubmissions = [{}];
    expect(await adapter.probe(binding)).toBe("busy");
  });

  it("rejects a different workspace or thread and unknown protocol versions", async () => {
    state.cwd = tmpdir();
    expect(await adapter.probe(binding)).toBe("offline");
    await expect(adapter.wake(binding, "Mailbox")).rejects.toThrow("workspace");
    state.cwd = root; state.id = "another-thread";
    expect(await adapter.probe(binding)).toBe("offline");
    state.id = binding.sessionId; version = 12;
    expect(await adapter.probe(binding)).toBe("offline");
    expect(messages.some(message => message.method === "thread-follower-start-turn")).toBe(false);
  });

  it("rejects a writable socket directory and a missing socket", async () => {
    chmodSync(root, 0o777);
    expect(await adapter.probe(binding)).toBe("offline");
    expect(messages).toHaveLength(0);
    const missing = new CodexMailboxAdapter({ cwd: root, socketPath: join(root, "missing.sock") });
    expect(await missing.probe(binding)).toBe("offline");
  });

  it.each(["disconnect", "timeout"] as const)("never retries a start with %s outcome", async behavior => {
    startBehavior = behavior;
    await expect(adapter.wake(binding, "Mailbox")).rejects.toThrow();
    expect(messages.filter(message => message.method === "thread-follower-start-turn")).toHaveLength(1);
  });
});
