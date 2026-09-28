import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WakeDeferredError, type Binding, type WakeAdapter } from "./agent-mailbox-monitor.js";

type Message = Record<string, any>;
type Pending = { resolve: (message: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

// This is the installed Codex extension's private coordination protocol, not a
// second app-server. Version mismatches fail closed instead of taking ownership.
class CodexConnection {
  private socket!: Socket;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, Pending>();
  private snapshot?: Pending;
  private clientId = "";
  private ownerId = "";
  private threadId = "";
  private failure?: Error;

  constructor(private timeoutMs: number) {}

  async open(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.destroy(); reject(new Error("Codex IPC connection timed out")); }, this.timeoutMs);
      this.socket = connect(path);
      this.socket.once("connect", () => { clearTimeout(timer); resolve(); });
      this.socket.once("error", error => { clearTimeout(timer); reject(error); });
      this.socket.on("error", error => this.fail(error));
      this.socket.on("close", () => this.fail(new Error("Codex IPC disconnected")));
      this.socket.on("data", chunk => this.receive(chunk));
    });
    const result = await this.request("initialize", 0, { clientType: "agent-mailbox" });
    if (typeof result.result?.clientId !== "string") throw new Error("Invalid Codex IPC initialization");
    this.clientId = result.result.clientId;
  }

  async inspect(threadId: string): Promise<Message> {
    const owner = await this.request("thread-owner-discovery", 1, { hostId: "local", conversationId: threadId });
    if (typeof owner.handledByClientId !== "string" || owner.result?.supportsUntrustedAppInput !== true) {
      throw new Error("Unsupported Codex owner protocol");
    }
    this.ownerId = owner.handledByClientId;
    this.threadId = threadId;
    return new Promise((resolve, reject) => {
      this.snapshot = { resolve, reject, timer: setTimeout(() => {
        this.snapshot = undefined;
        reject(new Error("Codex thread snapshot timed out"));
      }, this.timeoutMs) };
      try { this.follow(true); } catch (error) { this.fail(error as Error); }
    });
  }

  async start(notice: string): Promise<void> {
    // Only the fixed mailbox notification is sent here, never peer message text.
    const response = await this.request("thread-follower-start-turn", 2, {
      conversationId: this.threadId,
      turnStart: {
        request: {
          threadId: this.threadId,
          input: [{ type: "text", text: notice, text_elements: [] }],
          clientUserMessageId: randomUUID(),
        },
        context: { inheritThreadSettings: true },
      },
    }, this.ownerId);
    if (typeof response.result?.result?.turn?.id !== "string") {
      throw new Error("Codex turn delivery outcome unknown: invalid response");
    }
  }

  close(): void {
    if (this.threadId && !this.failure && this.socket?.writable) {
      try { this.follow(false); } catch { /* Socket may close between checks. */ }
    }
    this.socket?.end();
    this.socket?.destroy();
    this.fail(new Error("Codex IPC closed"));
  }

  private follow(following: boolean): void {
    this.send({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
      sourceClientId: this.clientId, targetClientIds: [this.ownerId],
      params: { conversationId: this.threadId, hostId: "local", following } });
  }

  private request(method: string, version: number, params: Message, targetClientId?: string): Promise<Message> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, timer: setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex IPC ${method} timed out; delivery may be unknown`));
      }, this.timeoutMs) });
      try { this.send({ type: "request", requestId, sourceClientId: this.clientId,
        method, version, params, targetClientId, timeoutMs: this.timeoutMs }); }
      catch (error) { this.fail(error as Error); }
    });
  }

  private send(message: Message): void {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (!length || length > 64 * 1024 * 1024) throw new Error("Invalid Codex IPC frame length");
        if (this.buffer.length < length + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, length + 4).toString());
        this.buffer = this.buffer.subarray(length + 4);
        this.handle(message);
      }
    } catch (error) { this.fail(error as Error); this.socket.destroy(); }
  }

  private handle(message: Message): void {
    if (message.type === "response") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType === "success") pending.resolve(message);
      else pending.reject(new Error(`Codex IPC: ${message.error ?? "request failed"}`));
    } else if (message.type === "broadcast" && message.method === "thread-stream-state-changed"
      && message.sourceClientId === this.ownerId && message.params?.conversationId === this.threadId
      && message.params?.hostId === "local" && this.snapshot) {
      if (message.version !== 11) throw new Error("Unsupported Codex thread snapshot version");
      if (message.params.change?.type !== "snapshot") return;
      const pending = this.snapshot;
      this.snapshot = undefined;
      clearTimeout(pending.timer);
      pending.resolve(message.params.change.conversationState);
    } else if (message.type === "client-discovery-request") {
      this.send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (this.snapshot) { clearTimeout(this.snapshot.timer); this.snapshot.reject(error); this.snapshot = undefined; }
  }
}

export class CodexMailboxAdapter implements WakeAdapter {
  private socketPath: string;
  private timeoutMs: number;

  constructor(private options: { cwd: string; socketPath?: string; timeoutMs?: number }) {
    this.socketPath = options.socketPath ?? join(process.env.CODEX_HOME ?? homedir() + "/.codex", "ipc", "ipc.sock");
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  async probe(binding: Binding): Promise<"idle" | "busy" | "offline"> {
    const connection = new CodexConnection(this.timeoutMs);
    try { return await this.inspect(connection, binding); }
    catch { return "offline"; }
    finally { connection.close(); }
  }

  async wake(binding: Binding, notice: string): Promise<void> {
    const connection = new CodexConnection(this.timeoutMs);
    try {
      try {
        if (await this.inspect(connection, binding) !== "idle") throw new Error("Codex thread is busy");
      } catch (error) {
        throw new WakeDeferredError(error instanceof Error ? error.message : String(error));
      }
      await connection.start(notice);
    } finally { connection.close(); }
  }

  private async inspect(connection: CodexConnection, binding: Binding): Promise<"idle" | "busy"> {
    const uid = process.getuid?.();
    const [socket, parent] = await Promise.all([lstat(this.socketPath), lstat(dirname(this.socketPath))]);
    if (uid == null || !socket.isSocket() || socket.uid !== uid || !parent.isDirectory()
      || parent.uid !== uid || (parent.mode & 0o022) || (socket.mode & 0o022)) {
      throw new Error("Codex IPC socket must be owned and protected by the current user");
    }
    await connection.open(this.socketPath);
    const state = await connection.inspect(binding.sessionId);
    if (state?.id !== binding.sessionId || typeof state.cwd !== "string"
      || await realpath(state.cwd) !== await realpath(this.options.cwd)) throw new Error("Codex thread workspace does not match");
    const status = state.threadRuntimeStatus?.type;
    if (status !== "idle" && status !== "active") throw new Error("Codex thread status unavailable");
    return status === "idle" && Array.isArray(state.requests) && state.requests.length === 0
      && (state.unconfirmedTurnSubmissions?.length ?? 0) === 0 ? "idle" : "busy";
  }
}
