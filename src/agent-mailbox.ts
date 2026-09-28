import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const agentSchema = z.enum(["codex", "claude"]);
const idSchema = z.string().uuid();
const sendSchema = z.object({
  to: agentSchema,
  subject: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(16_000).refine(value => value.trim().length > 0, "Body must not be blank"),
  replyTo: idSchema.optional(),
}).strict();
const messageSchema = sendSchema.extend({
  id: idSchema,
  from: agentSchema,
  createdAt: z.string().datetime(),
}).refine(value => value.from !== value.to, "Cannot send to yourself");

export type Agent = z.infer<typeof agentSchema>;
export type Message = z.infer<typeof messageSchema>;
type InboxMessage = Message & { read: boolean };

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

// Link a completely written file into place without replacing any existing message.
function publish(path: string, value: unknown, allowExisting = false): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
    fsyncSync(fd);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (!allowExisting || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** Local two-party mailbox. Reading never acknowledges; ack is explicit and idempotent. */
export class AgentMailbox {
  readonly root: string;
  readonly agent: Agent;

  constructor(root: string, agent: Agent) {
    this.agent = agentSchema.parse(agent);
    this.root = resolve(z.string().min(1).parse(root));
    for (const path of [this.root, join(this.root, "messages"), join(this.root, "read"), join(this.root, "read", this.agent)]) {
      privateDirectory(path);
    }
  }

  send(input: { to: Agent; subject: string; body: string; replyTo?: string }): Message {
    const data = sendSchema.parse(input);
    if (data.to === this.agent) throw new Error("Cannot send to yourself");
    if (data.replyTo) {
      const original = this.read(data.replyTo);
      if (original.from !== data.to) throw new Error("Reply must target the original sender");
    }
    const message: Message = { ...data, id: randomUUID(), from: this.agent, createdAt: new Date().toISOString() };
    publish(join(this.root, "messages", `${message.id}.json`), message);
    return message;
  }

  inbox(options: { includeRead?: boolean; limit?: number } = {}): InboxMessage[] {
    const { includeRead, limit } = z.object({
      includeRead: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(100),
    }).strict().parse(options);
    const messages: InboxMessage[] = [];
    for (const filename of readdirSync(join(this.root, "messages"))) {
      if (!filename.endsWith(".json") || !idSchema.safeParse(filename.slice(0, -5)).success) continue;
      const message = this.load(filename.slice(0, -5));
      if (message.to !== this.agent) continue;
      const read = existsSync(this.receiptPath(message.id));
      if (includeRead || !read) messages.push({ ...message, read });
    }
    return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, limit);
  }

  read(id: string): InboxMessage {
    const message = this.load(idSchema.parse(id));
    if (message.to !== this.agent) throw new Error("Message is addressed to another agent");
    return { ...message, read: existsSync(this.receiptPath(id)) };
  }

  ack(ids: string[]): void {
    const validIds = z.array(idSchema).min(1).max(100).parse(ids);
    // Validate the whole batch before writing any receipts.
    for (const id of validIds) this.read(id);
    for (const id of validIds) publish(this.receiptPath(id), { id, readAt: new Date().toISOString() }, true);
  }

  async wait(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<InboxMessage[]> {
    const timeoutMs = z.number().int().min(0).max(50_000).parse(options.timeoutMs ?? 25_000);
    const deadline = performance.now() + timeoutMs;
    while (true) {
      options.signal?.throwIfAborted();
      const messages = this.inbox();
      if (messages.length > 0 || performance.now() >= deadline) return messages;
      await delay(Math.min(100, Math.max(0, deadline - performance.now())), undefined, { signal: options.signal });
    }
  }

  private load(id: string): Message {
    const message = messageSchema.parse(JSON.parse(readFileSync(join(this.root, "messages", `${id}.json`), "utf8")));
    if (message.id !== id) throw new Error("Message ID does not match filename");
    return message;
  }

  private receiptPath(id: string): string {
    return join(this.root, "read", this.agent, `${id}.json`);
  }
}
