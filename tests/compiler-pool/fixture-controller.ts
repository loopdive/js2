import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CompilerPool } from "../../scripts/compiler-pool.js";

export const workerPath = fileURLToPath(new URL("./fixtures/lifecycle-worker.mjs", import.meta.url));
export function finite<T>(promise: Promise<T>, label: string, ms = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture deadline: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
export function pending(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}
export interface ObservedChild {
  proc: ChildProcess;
  closed: boolean;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  messages: any[];
  errors: unknown[];
  done: Promise<void>;
  observeClose: () => void;
}
export class FixtureController {
  readonly children = new Map<ChildProcess, ObservedChild>();
  readonly pools = new Set<CompilerPool>();
  readonly expectedTimeoutPools = new Set<CompilerPool>();
  pool(mode = "held") {
    const old = process.env.COMPILER_POOL_CLOSE_FIXTURE_MODE;
    process.env.COMPILER_POOL_CLOSE_FIXTURE_MODE = mode;
    try {
      const pool = new CompilerPool(1, "compile", workerPath);
      this.pools.add(pool);
      this.observe(pool);
      return pool;
    } finally {
      if (old === undefined) Reflect.deleteProperty(process.env, "COMPILER_POOL_CLOSE_FIXTURE_MODE");
      else process.env.COMPILER_POOL_CLOSE_FIXTURE_MODE = old;
    }
  }
  observe(pool: CompilerPool) {
    this.pools.add(pool);
    const actualGenerations = new Set<ChildProcess>([
      ...((pool as any).outstandingChildren?.keys() ?? []),
      ...(pool as any).forks.map(({ proc }: { proc: ChildProcess }) => proc),
    ]);
    for (const proc of actualGenerations) {
      if (this.children.has(proc)) continue;
      const child: ObservedChild = {
        proc,
        closed: false,
        messages: [],
        errors: [],
        done: undefined!,
        observeClose: undefined!,
      };
      child.done = new Promise<void>((resolve) => {
        child.observeClose = () => {
          child.closed = true;
          resolve();
        };
        proc.once("close", child.observeClose);
      });
      proc.once("exit", (code, signal) => {
        child.exit = { code, signal };
      });
      proc.on("error", (error) => child.errors.push(error));
      proc.on("message", (message) => child.messages.push(message));
      proc.stdout?.resume();
      this.children.set(proc, child);
    }
  }
  first(pool: CompilerPool) {
    return (pool as any).forks[0].proc as ChildProcess;
  }
  async message(proc: ChildProcess, type: string) {
    const child = this.children.get(proc)!;
    if (child.messages.some((message) => message.type === type)) return;
    await finite(
      new Promise<void>((resolve) => {
        const listener = (message: any) => {
          if (message.type === type) {
            proc.off("message", listener);
            resolve();
          }
        };
        proc.on("message", listener);
        child.done.then(() => proc.off("message", listener));
      }),
      `${type} from ${proc.pid}`,
    );
  }
  release(proc: ChildProcess) {
    if (this.children.get(proc)?.closed || !proc.connected) return;
    proc.send({ type: "release" });
  }
  async cleanup() {
    const errors: unknown[] = [];
    // Set the actual shutdown flag before releasing a child; cleanup cannot respawn it.
    for (const pool of this.pools) {
      try {
        this.observe(pool);
      } catch (error) {
        errors.push(error);
      }
    }
    const drains: Promise<void>[] = [];
    for (const pool of this.pools) {
      try {
        drains.push(
          Promise.resolve(pool.shutdown()).catch((error) => {
            if (!this.expectedTimeoutPools.has(pool) || error?.name !== "CompilerPoolShutdownTimeoutError")
              errors.push(error);
          }),
        );
      } catch (error) {
        errors.push(error);
      }
    }
    // Legacy void shutdown removed listeners; restore only our actual close witness.
    for (const child of this.children.values()) {
      if (!child.closed && !child.proc.listeners("close").includes(child.observeClose)) {
        child.proc.once("close", child.observeClose);
      }
    }
    for (const child of this.children.values()) {
      try {
        this.release(child.proc);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const child of this.children.values()) {
      try {
        await finite(child.done, `cleanup close ${child.proc.pid}`);
      } catch (error) {
        errors.push(error);
      }
    }
    await Promise.all(drains);
    // An intentionally observed timeout remains the original rejected promise.
    if (errors.length) throw new AggregateError(errors, "Owned fixture cleanup failed");
  }
}
