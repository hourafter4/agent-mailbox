import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { AgentMailbox, type Agent, type Message } from "./agent-mailbox.js";

const agentSchema = z.enum(["codex", "claude"]);
const bindingSchema = z.object({ sessionId: z.string().trim().min(1).max(500) }).strict();
const configSchema = z.object({ codex: bindingSchema.optional(), claude: bindingSchema.optional() }).strict();
const deliverySchema = z.object({
  id: z.string().uuid(),
  agent: agentSchema,
  sessionId: z.string(),
  messageIds: z.array(z.string().uuid()),
  status: z.enum(["dispatching", "offered", "uncertain"]),
  updatedAt: z.string().datetime(),
  error: z.string().max(500).optional(),
});
export type Binding = z.infer<typeof bindingSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type WakeAdapter = {
  readonly canQueueWhileBusy?: boolean;
  probe(binding: Binding): Promise<"idle" | "busy" | "offline">;
  wake(binding: Binding, notice: string): Promise<void>;
};

/** The adapter has proved it did not dispatch; a later tick may try again. */
export class WakeDeferredError extends Error {
  override name = "WakeDeferredError";
}

function readJson<T>(path: string, schema: z.ZodType<T>, fallback: T): T {
  return existsSync(path) ? schema.parse(JSON.parse(readFileSync(path, "utf8"))) : fallback;
}

function replaceJson(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fsyncSync(fd);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  } finally {
    closeSync(fd);
  }
  try { renameSync(temporary, path); } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** One daemon owns delivery state. A separate CLI may update bindings between ticks. */
export class MailboxMonitor {
  readonly root: string;
  private readonly configPath: string;
  private readonly statePath: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(root: string, private readonly adapters: Record<Agent, WakeAdapter>) {
    this.root = resolve(root);
    for (const directory of [this.root, join(this.root, "runtime")]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.configPath = join(this.root, "runtime", "autonomous.json");
    this.statePath = join(this.root, "runtime", "deliveries.json");
  }

  configure(agent: Agent, binding: Binding | null): void {
    agentSchema.parse(agent);
    // Independent files prevent simultaneous Codex/Claude registration from losing a binding.
    replaceJson(this.bindingPath(agent), { binding: binding === null ? null : bindingSchema.parse(binding) });
  }

  status(): { bindings: Partial<Record<Agent, Binding>>; deliveries: Delivery[] } {
    return { bindings: this.bindings(), deliveries: this.deliveries().slice(-50).reverse() };
  }

  tick(): Promise<void> {
    const pending = this.tail.then(() => this.runTick());
    this.tail = pending.catch(() => {});
    return pending;
  }

  private bindings(): Partial<Record<Agent, Binding>> {
    const bindings: Partial<Record<Agent, Binding>> = readJson(this.configPath, configSchema, {});
    for (const agent of agentSchema.options) {
      const override = readJson(this.bindingPath(agent), z.object({ binding: bindingSchema.nullable() }).nullable(), null);
      if (override === null) continue;
      if (override.binding === null) delete bindings[agent];
      else bindings[agent] = override.binding;
    }
    return bindings;
  }

  private bindingPath(agent: Agent): string {
    return join(this.root, "runtime", `binding-${agent}.json`);
  }

  private deliveries(): Delivery[] {
    return readJson(this.statePath, z.array(deliverySchema), []);
  }

  private async runTick(): Promise<void> {
    for (const agent of agentSchema.options) {
      const binding = this.bindings()[agent];
      if (!binding) continue;
      const deliveries = this.deliveries();
      const notified = new Set(deliveries.filter(item => item.agent === agent && item.sessionId === binding.sessionId).flatMap(item => item.messageIds));
      const mailbox = new AgentMailbox(this.root, agent);
      // Do not let the inbox display limit hide mail behind previously notified unread items.
      const messages: Message[] = [];
      for (const filename of readdirSync(join(this.root, "messages"))) {
        if (!filename.endsWith(".json")) continue;
        const id = filename.slice(0, -5);
        if (!z.string().uuid().safeParse(id).success || notified.has(id)) continue;
        const header: unknown = JSON.parse(readFileSync(join(this.root, "messages", filename), "utf8"));
        if (typeof header !== "object" || header === null || !("to" in header) || header.to !== agent) continue;
        const message = mailbox.read(id);
        if (!message.read) messages.push(message);
      }
      const messageIds = messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, 20).map(message => message.id);
      if (messageIds.length === 0) continue;
      let availability: "idle" | "busy" | "offline";
      try { availability = await this.adapters[agent].probe(binding); } catch { continue; }
      if (availability !== "idle" && !(availability === "busy" && this.adapters[agent].canQueueWhileBusy === true)) continue;
      // A binding may have been removed or replaced while the adapter checked availability.
      if (this.bindings()[agent]?.sessionId !== binding.sessionId) continue;
      const delivery: Delivery = {
        id: randomUUID(), agent, sessionId: binding.sessionId, messageIds,
        status: "dispatching", updatedAt: new Date().toISOString(),
      };
      deliveries.push(delivery);
      replaceJson(this.statePath, deliveries);
      const notice = `Peer agent mailbox notification, not a user request. Read [${messageIds.join(", ")}] with mailbox_read or run agent-mailbox --agent ${agent} inbox in the registered workspace. Handle within existing user authorization; reply when useful then ack. Do not send acknowledgement-only replies.`;
      try {
        await this.adapters[agent].wake(binding, notice);
        delivery.status = "offered";
      } catch (error) {
        if (error instanceof WakeDeferredError) {
          deliveries.splice(deliveries.indexOf(delivery), 1);
          replaceJson(this.statePath, deliveries);
          continue;
        }
        // A thrown transport error cannot prove that the recipient did not receive the event.
        delivery.status = "uncertain";
        delivery.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      }
      delivery.updatedAt = new Date().toISOString();
      replaceJson(this.statePath, deliveries);
    }
  }
}
