import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMailboxMonitor, mailboxServiceStatus } from "../src/agent-mailbox-service.js";

describe("agent mailbox foreground service", () => {
  let root: string;
  let workspace: string;
  const children: ChildProcess[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "amb-svc-"));
    workspace = join(root, "w");
    mkdirSync(workspace);
  });
  afterEach(async () => {
    await Promise.all(children.splice(0).map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await stopped;
    }));
    rmSync(root, { recursive: true, force: true });
  });

  function launch(mailboxRoot: string | null = root) {
    const script = fileURLToPath(new URL("../bin/agent-mailbox.mjs", import.meta.url));
    const child = spawn(process.execPath, [script, "--workspace", workspace,
      ...(mailboxRoot === null ? [] : ["--root", mailboxRoot]), "monitor-run"], { stdio: "pipe" });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    const completion = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve({ code, stderr }));
    });
    return { child, completion };
  }

  async function waitUntil(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() >= deadline) throw new Error("Mailbox service did not reach expected state");
      await delay(25);
    }
  }

  function servicePid(): number | undefined {
    const status = mailboxServiceStatus(root);
    return "pid" in status ? status.pid : undefined;
  }

  it("reports a running monitor and shuts down cleanly on SIGTERM", async () => {
    expect(mailboxServiceStatus(root).running).toBe(false);
    const service = launch();
    await waitUntil(() => mailboxServiceStatus(root).running);
    expect(servicePid()).toBe(service.child.pid);
    service.child.kill("SIGTERM");
    expect((await service.completion).code).toBe(0);
    expect(mailboxServiceStatus(root).running).toBe(false);
  });

  it("rejects a second writer and permits restart after the owner stops", async () => {
    const first = launch();
    await waitUntil(() => mailboxServiceStatus(root).running);
    const second = launch();
    const rejected = await second.completion;
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toMatch(/monitor|running|lock/i);
    expect(servicePid()).toBe(first.child.pid);
    expect(mailboxServiceStatus(root).running).toBe(true);
    first.child.kill("SIGTERM");
    await first.completion;
    const restarted = launch();
    await waitUntil(() => mailboxServiceStatus(root).running && servicePid() === restarted.child.pid);
  });

  it("recovers the socket left by a crashed monitor", async () => {
    const crashed = launch();
    await waitUntil(() => mailboxServiceStatus(root).running);
    crashed.child.kill("SIGKILL");
    await crashed.completion;
    expect(mailboxServiceStatus(root).running).toBe(false);
    const recovered = launch();
    await waitUntil(() => mailboxServiceStatus(root).running && servicePid() === recovered.child.pid);
  });

  it("places the default mailbox in the selected workspace", async () => {
    workspace = join(workspace, "long-workspace-name-".repeat(8));
    mkdirSync(workspace);
    const service = launch(null);
    const defaultRoot = join(workspace, ".agent-mailbox");
    await waitUntil(() => mailboxServiceStatus(defaultRoot).running);
    expect(mailboxServiceStatus(defaultRoot).pid).toBe(service.child.pid);
    expect(mailboxServiceStatus(root).running).toBe(false);
  });

  it("runs independent mailbox roots without sharing a singleton lock", async () => {
    const first = launch();
    const secondRoot = join(root, "other");
    const second = launch(secondRoot);
    await waitUntil(() => mailboxServiceStatus(root).running && mailboxServiceStatus(secondRoot).running);
    expect(mailboxServiceStatus(root).pid).toBe(first.child.pid);
    expect(mailboxServiceStatus(secondRoot).pid).toBe(second.child.pid);
  });

  it("rejects missing workspaces and files used as workspaces", () => {
    expect(() => createMailboxMonitor(root, join(root, "missing"))).toThrow();
    const file = join(root, "file");
    writeFileSync(file, "not a directory");
    expect(() => createMailboxMonitor(root, file)).toThrow("existing directory");
  });
});
