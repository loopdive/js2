/**
 * Test262 pool — manages persistent fork processes for compile + execute.
 * Uses child_process.fork (separate OS processes) instead of worker threads.
 * When a process exits, the OS reclaims ALL its memory (RSS, JIT code, etc.).
 *
 * Two modes:
 *   - compile(): compile only (for precompile-tests.ts cache warming)
 *   - runTest(): compile + execute in one fork (for vitest)
 *
 * Usage:
 *   const pool = new CompilerPool(4);
 *   const result = await pool.runTest(source, { execute: true, ... });
 *   pool.shutdown();
 */
import { fork, type ChildProcess } from "child_process";
import { join } from "path";

export interface PoolCompileResult {
  ok: true;
  binary: Uint8Array;
  stringPool: string[];
  imports: any[];
  sourceMap: string | null;
  compileMs: number;
}

export interface PoolCompileError {
  ok: false;
  error: string;
  compileMs: number;
}

export type PoolResult = PoolCompileResult | PoolCompileError;

/** Result from runTest() — full compile+execute cycle */
export interface TestResult {
  status: "pass" | "fail" | "compile_error" | "compile_timeout" | "compiled" | "skip";
  error?: string;
  errorCodes?: number[];
  imports?: string[];
  hostImportLeakClass?: string;
  reachedTest?: boolean;
  ret?: number;
  compileMs?: number;
  execMs?: number;
  instantiateError?: boolean;
  isException?: boolean;
  runtimeNegativePass?: boolean;
  runtimeNegativeNoThrow?: boolean;
  /** (#2939/#2940) vacuity correction: a `fail` whose harness callback never ran. */
  vacuous?: boolean;
}

interface PendingJob {
  id: number;
  resolve: (result: any) => void;
}

interface ForkState {
  proc: ChildProcess;
  busy: boolean;
  ready: boolean;
  active?: {
    job: QueueItem;
    timer: ReturnType<typeof setTimeout>;
  };
}

type QueueItem = {
  id: number;
  msg: Record<string, any>;
  /** Timeout ceiling in ms — applied from dispatch time, not enqueue time (#1227). */
  timeoutMs: number;
  label?: string;
  /** Number of times an unexpectedly-dead worker has retried this job. */
  workerCrashRetries?: number;
  resolve: (r: any) => void;
};

const MAX_WORKER_CRASH_RETRIES = 1;

export class CompilerPool {
  private forks: ForkState[] = [];
  private pending = new Map<number, PendingJob>();
  private queue: QueueItem[] = [];
  private nextId = 0;
  private readyResolve: (() => void) | null = null;
  private readyCount = 0;
  private workerPath: string;
  private shuttingDown = false;

  constructor(
    private size = 4,
    workerType: "compile" | "unified" = "compile",
    workerPathOverride?: string,
  ) {
    const workerFile = workerType === "unified" ? "test262-worker.mjs" : "compiler-fork-worker.mjs";
    this.workerPath = workerPathOverride ?? join(import.meta.dirname ?? __dirname, workerFile);
    for (let i = 0; i < size; i++) {
      this.forks.push(this.createFork());
    }
  }

  private createFork(): ForkState {
    const state: ForkState = { proc: this.forkProcess(), busy: false, ready: false };
    this.attachForkHandlers(state, true);
    return state;
  }

  private forkProcess(): ChildProcess {
    const maxOldSpaceSize = process.env.TEST262_WORKER_MAX_OLD_SPACE_SIZE ?? "512";
    return fork(this.workerPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv: ["--expose-gc", `--max-old-space-size=${maxOldSpaceSize}`],
      // Test262 baselines are produced on UTC CI hosts. Pin worker time-zone
      // semantics locally as well so Date parsing/formatting verdicts do not
      // depend on the developer machine. TEST262_TZ remains an explicit
      // diagnostic override.
      env: { ...process.env, TZ: process.env.TEST262_TZ ?? "UTC" },
    });
  }

  private attachForkHandlers(state: ForkState, countInitialReady: boolean) {
    const proc = state.proc;
    proc.on("message", (msg: any) => {
      if (this.shuttingDown) return;
      if (msg.type === "ready") {
        state.ready = true;
        if (countInitialReady) this.readyCount++;
        this.dispatch();
        if (this.readyCount === this.size && this.readyResolve) {
          this.readyResolve();
        }
        return;
      }

      // Binary arrives as base64 over IPC — decode it (compile-only mode)
      if (msg.ok && msg.binary && typeof msg.binary === "string") {
        msg.binary = new Uint8Array(Buffer.from(msg.binary, "base64"));
      }

      const job = this.pending.get(msg.id);
      if (job) {
        this.pending.delete(msg.id);
        state.active = undefined;
        state.busy = false;
        job.resolve(msg);
        if (msg.recycle === true) {
          this.respawnFork(state, msg.recycleReason);
        } else {
          this.dispatch();
        }
      }
    });

    proc.on("error", (err) => this.handleForkFailure(state, proc, `error: ${err.message}`));

    proc.on("exit", (code, signal) =>
      this.handleForkFailure(state, proc, `exit ${code ?? "null"}${signal ? ` (${signal})` : ""}`),
    );
  }

  /** Wait for all forks to be ready */
  ready(): Promise<void> {
    if (this.readyCount === this.size) return Promise.resolve();
    return new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /** Compile source — queues if all forks busy. */
  compile(
    source: string,
    timeoutMs = 10_000,
    _fullDiag?: boolean,
    sourceMapUrl?: string,
    label?: string,
    wasmPath?: string,
    metaPath?: string,
    target?: "gc" | "linear" | "wasi" | "standalone",
    // (#2119) false ⇒ keep mapped arguments for script tests; see runTest.
    inferModuleStrictArguments?: boolean,
  ): Promise<PoolResult> {
    return this.enqueue(
      {
        source,
        sourceMapUrl,
        wasmPath,
        metaPath,
        target,
        inferModuleStrictArguments,
        execute: false,
      },
      timeoutMs,
      label,
    );
  }

  /** Compile + execute a test — returns full TestResult. */
  runTest(
    source: string,
    opts: {
      isNegative?: boolean;
      isRuntimeNegative?: boolean;
      expectedErrorType?: string;
      /** Execute literal upstream harness source; success is module-init completion. */
      originalHarness?: boolean;
      /** Wait for the upstream doneprintHandle completion marker. */
      asyncTest?: boolean;
      /** Static Test262 module dependencies, keyed by pinned virtual path. */
      fixtureFiles?: Record<string, string>;
      /** Virtual entry path used to resolve `fixtureFiles` imports. */
      entryFile?: string;
      wasmPath?: string;
      metaPath?: string;
      label?: string;
      target?: "gc" | "linear" | "wasi" | "standalone";
      // (#2119) false ⇒ do not infer module-strictness (→ keep mapped
      // arguments) despite the synthetic `export function test()` wrapper.
      inferModuleStrictArguments?: boolean;
      // (#3461) Fast native-harness oracle (host lane): when set, `source` is
      // the body-only `bindingShim + body` unit and `harnessPrefix` is run
      // NATIVELY in the per-test sandbox before instantiation. Absent ⇒ honest
      // whole-assembly compile (unchanged).
      nativeHarness?: boolean;
      harnessPrefix?: string;
    } = {},
    timeoutMs = 30_000,
  ): Promise<TestResult> {
    return this.enqueue(
      {
        source,
        execute: true,
        isNegative: opts.isNegative || false,
        isRuntimeNegative: opts.isRuntimeNegative || false,
        expectedErrorType: opts.expectedErrorType,
        originalHarness: opts.originalHarness || false,
        asyncTest: opts.asyncTest || false,
        fixtureFiles: opts.fixtureFiles,
        entryFile: opts.entryFile,
        wasmPath: opts.wasmPath,
        metaPath: opts.metaPath,
        target: opts.target,
        inferModuleStrictArguments: opts.inferModuleStrictArguments,
        // (#3461) forwarded only in fast native-harness mode; undefined ⇒ the
        // worker takes its unchanged honest path.
        nativeHarness: opts.nativeHarness || false,
        harnessPrefix: opts.harnessPrefix,
      },
      timeoutMs,
      opts.label,
    );
  }

  private enqueue(msg: Record<string, any>, timeoutMs: number, label?: string): Promise<any> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      // #1227: do NOT start the timeout timer here. We only know the user-
      // observable wall-clock budget once a fork has accepted the job —
      // otherwise queue-wait time on a saturated pool gets counted against
      // the user's timeout, producing false `compile_timeout` results for
      // tests that compile in <1 s in isolation.
      this.queue.push({ id, msg, timeoutMs, label, resolve });
      this.dispatch();
    });
  }

  private dispatch() {
    if (this.shuttingDown) return;
    while (this.queue.length > 0) {
      const free = this.forks.find((f) => f.ready && !f.busy);
      if (!free) break;

      const job = this.queue.shift()!;
      free.busy = true;

      // #1227: start the timeout timer now, after the fork has accepted the
      // job. The timer measures only worker execution time — queue-wait time
      // is not counted against it. On expiry we know exactly which fork was
      // running this job (`free`), so we kill it specifically rather than
      // guessing via `forks.find(w => w.busy)`.
      const timer = setTimeout(() => {
        console.error(
          `[pool] TIMEOUT: exceeded ${job.timeoutMs / 1000}s${job.label ? ` [${job.label}]` : ""}, killing worker`,
        );
        this.pending.delete(job.id);
        job.resolve(
          job.msg.execute
            ? ({
                status: "compile_timeout",
                error: `timeout (${job.timeoutMs / 1000}s)`,
                compileMs: job.timeoutMs,
              } as TestResult)
            : ({
                ok: false,
                error: `compilation timeout (${job.timeoutMs / 1000}s)`,
                compileMs: job.timeoutMs,
              } as PoolResult),
        );
        free.busy = false;
        free.ready = false;
        free.active = undefined;
        free.proc.kill("SIGKILL");
        this.respawnFork(free);
      }, job.timeoutMs);

      free.active = { job, timer };

      // Wrap the resolve so the worker's response clears the timer before
      // the result is delivered. The fork's `message` handler invokes this
      // wrapper via `pending.get(msg.id).resolve(msg)` (see createFork).
      this.pending.set(job.id, {
        id: job.id,
        resolve: (r: any) => {
          clearTimeout(timer);
          job.resolve(r);
        },
      });

      free.proc.send({ id: job.id, ...job.msg });
    }
  }

  /**
   * Re-run one interrupted job on a fresh process, then surface a bounded
   * compile error if the same job kills a second worker. A dead fork used to
   * leave its pending promise unresolved; Vitest then abandoned the rest of
   * the shard and uploaded a deceptively successful partial JSONL artifact.
   */
  private handleForkFailure(state: ForkState, proc: ChildProcess, reason: string) {
    if (this.shuttingDown || state.proc !== proc) return;

    const active = state.active;
    const wasReady = state.ready;
    state.active = undefined;
    state.busy = false;
    state.ready = false;

    // Preserve the existing startup-failure behavior. A replacement that
    // cannot initialize must not create an unbounded respawn loop; there is
    // no accepted job to recover in this state.
    if (!active && !wasReady) {
      console.error(`[pool] worker failed before ready (${reason}); not respawning`);
      return;
    }

    if (active) {
      clearTimeout(active.timer);
      this.pending.delete(active.job.id);
      const retries = active.job.workerCrashRetries ?? 0;
      if (retries < MAX_WORKER_CRASH_RETRIES) {
        active.job.workerCrashRetries = retries + 1;
        this.queue.unshift(active.job);
        console.error(
          `[pool] worker ${reason}; retrying interrupted job on a fresh worker${active.job.label ? ` [${active.job.label}]` : ""}`,
        );
      } else {
        const error = `worker terminated unexpectedly after retry (${reason})`;
        active.job.resolve(
          active.job.msg.execute
            ? ({ status: "compile_error", error, compileMs: 0 } as TestResult)
            : ({ ok: false, error, compileMs: 0 } as PoolResult),
        );
      }
    } else {
      console.error(`[pool] idle worker ${reason}; spawning replacement`);
    }

    this.respawnFork(state, reason);
  }

  /** Respawn a dead/stuck fork — OS reclaims all memory from the old process */
  private respawnFork(state: ForkState, reason?: string) {
    if (this.shuttingDown) return;
    const oldProc = state.proc;
    oldProc.removeAllListeners();
    if (!oldProc.killed) {
      oldProc.kill("SIGTERM");
    }
    if (reason) {
      console.error(`[pool] recycling worker: ${reason}`);
    }
    state.busy = false;
    state.ready = false;
    state.active = undefined;
    state.proc = this.forkProcess();
    this.attachForkHandlers(state, false);
  }

  /** Shut down all forks — OS reclaims all memory */
  shutdown() {
    this.shuttingDown = true;
    for (const { proc } of this.forks) {
      proc.removeAllListeners();
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
    }
  }
}
