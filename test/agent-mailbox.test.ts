import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMailbox, type Agent } from "../src/agent-mailbox.js";

describe("agent mailbox", () => {
  let root: string;
  let codex: AgentMailbox;
  let claude: AgentMailbox;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-mailbox-"));
    codex = new AgentMailbox(root, "codex");
    claude = new AgentMailbox(root, "claude");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("delivers replies and keeps acknowledgements explicit across restarts", () => {
    const question = codex.send({ to: "claude", subject: "Spec review", body: "Review the sending boundary." });
    expect(claude.inbox()).toEqual([{ ...question, read: false }]);
    expect(claude.read(question.id)).toEqual({ ...question, read: false });
    expect(new AgentMailbox(root, "claude").inbox()).toHaveLength(1);
    const reply = claude.send({ to: "codex", subject: "Reviewed", body: "Added that boundary.", replyTo: question.id });
    expect(codex.inbox()).toEqual([{ ...reply, read: false }]);
    claude.ack([question.id]);
    claude.ack([question.id]);
    expect(new AgentMailbox(root, "claude").inbox()).toEqual([]);
    expect(claude.inbox({ includeRead: true })).toEqual([{ ...question, read: true }]);
    expect(claude.read(question.id).read).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "messages", `${question.id}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "read", "claude", `${question.id}.json`)).mode & 0o777).toBe(0o600);
  });

  it("rejects reading, acknowledging, and replying to another recipient's message", () => {
    const outgoing = codex.send({ to: "claude", subject: "Question", body: "Hello" });
    const incoming = claude.send({ to: "codex", subject: "Question", body: "Hi" });
    expect(() => codex.read(outgoing.id)).toThrow("another agent");
    expect(() => codex.ack([incoming.id, outgoing.id])).toThrow("another agent");
    expect(codex.read(incoming.id).read).toBe(false);
    expect(() => codex.send({ to: "claude", subject: "Wrong reply", body: "Hi", replyTo: outgoing.id })).toThrow("another agent");
  });

  it("validates addresses, IDs, content, limits, and timeouts", async () => {
    expect(() => new AgentMailbox(root, "other" as Agent)).toThrow();
    expect(() => codex.send({ to: "codex", subject: "Self", body: "Hi" })).toThrow();
    for (const change of [{ subject: " " }, { subject: "x".repeat(201) }, { body: " " }, { body: "x".repeat(16_001) }, { replyTo: "../../private" }]) {
      expect(() => codex.send({ to: "claude", subject: "Subject", body: "Body", ...change })).toThrow();
    }
    expect(() => codex.read("../../private")).toThrow();
    expect(() => codex.ack(["../../private"])).toThrow();
    for (const limit of [0, 101, 1.5, NaN]) expect(() => codex.inbox({ limit })).toThrow();
    for (const timeoutMs of [-1, 50_001, NaN]) await expect(codex.wait({ timeoutMs })).rejects.toThrow();
    expect(readdirSync(join(root, "messages"))).toEqual([]);
  });

  it("waits for arrivals from another instance, times out, and supports cancellation", async () => {
    const pending = claude.wait({ timeoutMs: 1_000 });
    const sender = new AgentMailbox(root, "codex");
    const message = sender.send({ to: "claude", subject: "Ping", body: "Arrived" });
    expect(await pending).toEqual([{ ...message, read: false }]);
    claude.ack([message.id]);
    expect(await claude.wait({ timeoutMs: 15 })).toEqual([]);
    const controller = new AbortController();
    const cancelled = claude.wait({ timeoutMs: 1_000, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toThrow();
  });

  it("retains every message from concurrent processes without partial JSON", async () => {
    const moduleUrl = new URL("../src/agent-mailbox.ts", import.meta.url).href;
    const run = promisify(execFile);
    await Promise.all(Array.from({ length: 3 }, (_, producer) => run(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      `import { AgentMailbox } from ${JSON.stringify(moduleUrl)};
       const mailbox = new AgentMailbox(${JSON.stringify(root)}, 'codex');
       for (let i = 0; i < 8; i++) mailbox.send({ to: 'claude', subject: 'Producer ${producer}', body: String(i) });`,
    ])));
    const messages = claude.inbox();
    expect(messages).toHaveLength(24);
    expect(new Set(messages.map(message => message.id)).size).toBe(24);
    expect(readdirSync(join(root, "messages"))).toHaveLength(24);
    expect(claude.inbox({ limit: 2 })).toHaveLength(2);
  });
});
