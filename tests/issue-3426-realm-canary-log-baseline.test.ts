// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ChildProcess, ForkOptions } from "child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompilerPool, TestResult } from "../scripts/compiler-pool.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

interface WorkerMessage {
  type?: string;
  pid?: number;
  id?: number;
  status?: string;
  recycle?: boolean;
}
interface ObservedResult extends TestResult {
  id: number;
  recycle?: boolean;
}
interface ObservedWorker {
  proc: ChildProcess;
  messages: WorkerMessage[];
  stderr: string;
  closed: boolean;
  stderrEnded: boolean;
  stdoutEnded: boolean;
  close: Promise<void>;
  observeClose: () => void;
  done: Promise<void>;
}

async function finite<T>(promise: Promise<T>, label: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out awaiting ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runPrimary(pool: CompilerPool, source: string, label: string) {
  const meta = parseMeta(source);
  const assembly = assembleOriginalHarness(source, meta);
  return (await pool.runTest(
    assembly.primary.source,
    {
      originalHarness: true,
      asyncTest: assembly.async,
      inferModuleStrictArguments: meta.flags?.includes("module") === true,
      label,
    },
    30_000,
  )) as ObservedResult;
}

describe("#3426 log-mode cleaned canary baseline", () => {
  it("logs the deleted name once, then keeps the same real worker clean", async () => {
    const environmentKeys = ["TEST262_REALM_CANARY", "TEST262_WORKER_RECYCLE_INTERVAL"] as const;
    const previousEnvironment = environmentKeys.map((key) => [key, process.env[key]] as const);
    const workers: ObservedWorker[] = [];
    const observationErrors: unknown[] = [];
    let pool: CompilerPool | undefined;
    let primary: ObservedResult | undefined;
    let clean: ObservedResult | undefined;
    let failed = false;
    let primaryFailure: unknown;
    const closingFailures: unknown[] = [];

    // Delegate the real fork unchanged except for observing inherited fd 2.
    // Install readers and real IPC/close listeners before the pool receives it.
    vi.doMock("child_process", async () => {
      const actual = await vi.importActual<typeof import("child_process")>("child_process");
      return {
        ...actual,
        fork: (modulePath: string | URL, args: string[], options: ForkOptions) => {
          if (!Array.isArray(options.stdio)) throw new Error("Expected the pool's explicit fork stdio array");
          const stdio = [...options.stdio];
          stdio[2] = "pipe";
          const proc = actual.fork(modulePath, args, { ...options, stdio });
          let resolveClose!: () => void;
          const close = new Promise<void>((resolve) => {
            resolveClose = resolve;
          });
          const worker: ObservedWorker = {
            proc,
            messages: [],
            stderr: "",
            closed: false,
            stderrEnded: false,
            stdoutEnded: false,
            close,
            observeClose: () => {
              worker.closed = true;
              resolveClose();
            },
            done: Promise.resolve(),
          };
          workers.push(worker);
          proc.on("message", (message) => worker.messages.push(message as WorkerMessage));
          proc.on("error", (error) => observationErrors.push(error));
          proc.once("close", worker.observeClose);
          const streamEnds = [proc.stdout, proc.stderr].map((stream, index) => {
            if (!stream) {
              observationErrors.push(new Error("Expected actual piped worker stdout and stderr"));
              return Promise.resolve();
            }
            const end = new Promise<void>((resolve) => {
              stream.once("end", () => {
                if (index === 0) worker.stdoutEnded = true;
                else worker.stderrEnded = true;
                resolve();
              });
            });
            stream.on("error", (error) => observationErrors.push(error));
            if (index === 1) {
              stream.setEncoding("utf8");
              let bytes = 0;
              stream.on("data", (chunk: string) => {
                bytes += Buffer.byteLength(chunk);
                if (bytes <= 4 * 1024 * 1024) worker.stderr += chunk;
                else if (bytes - Buffer.byteLength(chunk) <= 4 * 1024 * 1024)
                  observationErrors.push(new Error("Worker stderr exceeded the test's 4MiB capture limit"));
                // Retain the authentic raw log in the suite's inherited stderr.
                try {
                  process.stderr.write(chunk);
                } catch (error) {
                  observationErrors.push(error);
                }
              });
            }
            stream.resume();
            return end;
          });
          worker.done = Promise.all([close, ...streamEnds]).then(() => undefined);
          return proc;
        },
      };
    });

    try {
      process.env.TEST262_REALM_CANARY = "log";
      // Absence selects the maintained default interval 0, not a test override.
      // biome-ignore lint/performance/noDelete: select the default without setting an environment override.
      delete process.env.TEST262_WORKER_RECYCLE_INTERVAL;
      const { CompilerPool: RealCompilerPool } = await import("../scripts/compiler-pool.js");
      pool = new RealCompilerPool(1, "unified");
      await finite(pool.ready(), "real worker ready", 30_000);
      expect(workers).toHaveLength(1);
      const worker = workers[0];
      expect(worker.proc.pid).toBeGreaterThan(0);
      expect(worker.messages.filter((message) => message.type === "ready")).toEqual([
        { type: "ready", pid: worker.proc.pid },
      ]);

      primary = await runPrimary(
        pool,
        `/*---
description: Delete an unchanged built-in function name descriptor
---*/
delete String.prototype.concat.name;
`,
        "String.prototype.concat.name deletion [log primary]",
      );
      const path = "built-ins/String/prototype/concat/S15.5.4.6_A1_T1.js";
      const source = readFileSync(join(import.meta.dirname, "..", "test262", "test", path), "utf8");
      clean = await runPrimary(pool, source, `${path} [clean primary]`);

      expect(primary.status).toBe("pass");
      expect(clean.status).toBe("pass");
      expect(primary.recycle).not.toBe(true);
      expect(clean.recycle).not.toBe(true);
      expect(workers).toHaveLength(1);
      expect(worker.closed).toBe(false);
      const replies = worker.messages.filter((message) => message.status !== undefined);
      expect(replies.map((message) => message.id)).toEqual([primary.id, clean.id]);
      expect(Number.isInteger(primary.id)).toBe(true);
      expect(Number.isInteger(clean.id)).toBe(true);
      expect(primary.id).not.toBe(clean.id);
      expect(replies.map((message) => message.status)).toEqual(["pass", "pass"]);
    } catch (error) {
      failed = true;
      primaryFailure = error;
    } finally {
      try {
        if (pool) {
          try {
            let shutdown: void | Promise<void>;
            try {
              shutdown = pool.shutdown();
            } finally {
              // The public synchronous pool removes ChildProcess listeners.
              // Restore only our original observer before yielding to real close.
              for (const worker of workers) {
                if (!worker.closed && !worker.proc.listeners("close").includes(worker.observeClose))
                  worker.proc.once("close", worker.observeClose);
              }
            }
            await shutdown;
          } catch (error) {
            closingFailures.push(error);
          }
        }
        try {
          await finite(Promise.all(workers.map((worker) => worker.done)), "actual worker close and stream EOF", 6_000);
        } catch (error) {
          closingFailures.push(error);
        }
      } finally {
        for (const [key, value] of previousEnvironment) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        vi.doUnmock("child_process");
      }
    }

    if (failed || closingFailures.length || observationErrors.length) {
      throw new AggregateError(
        [...(failed ? [primaryFailure] : []), ...closingFailures, ...observationErrors],
        "Real-worker log-baseline test or closing observation failed",
      );
    }
    // stderr EOF and real close, rather than IPC timing, delimit the complete log.
    expect(workers).toHaveLength(1);
    const worker = workers[0];
    expect(worker.closed).toBe(true);
    expect(worker.stderrEnded).toBe(true);
    expect(worker.stdoutEnded).toBe(true);
    const drift = worker.stderr.split(/\r?\n/).flatMap((line) => {
      const match = /^\[realm-canary\] drift after test#(\d+): (.*)$/.exec(line);
      return match ? [{ id: Number(match[1]), summary: match[2] }] : [];
    });
    expect(drift).toHaveLength(1);
    expect(drift[0].id).toBe(primary!.id);
    expect(drift[0].summary.split(", ")).toContain("String.prototype.concat.name:deleted");
    expect(drift.some((event) => event.id === clean!.id)).toBe(false);
    expect(worker.stderr).not.toContain("String.prototype.concat.name:added");
  }, 110_000);
});
