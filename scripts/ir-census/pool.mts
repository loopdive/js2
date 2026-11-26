// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The resumable, parallel file loop shared by the census scripts.
 *
 * The parent appends one JSONL row per file to `out` (the only writer, so rows
 * never interleave) and skips files already there. Files go to `jobs` child
 * processes, one at a time each, over stdin; a child answers on fd 3 so that
 * compiler output on stdout cannot corrupt a row. A file that exceeds
 * `timeoutMs` is recorded as `timeout` and its child replaced; children are
 * also replaced every `RECYCLE_AFTER` files to bound memory.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

const RECYCLE_AFTER = 250;

export interface PoolOptions {
  readonly files: string;
  readonly out: string;
  readonly jobs: number;
  readonly timeoutMs: number;
  /** The script a child runs, and its arguments; the child must call `childLoop`. */
  readonly child: readonly string[];
  readonly cwd: string;
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** Child side: measure each file named on stdin, answer one JSON row on fd 3. */
export async function childLoop(measure: (file: string) => Promise<object>): Promise<void> {
  const sink = (row: object) => appendFileSync(3, `${JSON.stringify(row)}\n`);
  for await (const file of createInterface({ input: process.stdin })) {
    if (!file) continue;
    try {
      sink(await measure(file));
    } catch (error) {
      sink({ file, status: "threw", error: errorText(error) });
    }
  }
}

function doneFiles(out: string): Set<string> {
  if (!existsSync(out)) return new Set();
  const done = new Set<string>();
  for (const line of readFileSync(out, "utf8").split("\n")) {
    if (line.trim()) done.add((JSON.parse(line) as { file: string }).file);
  }
  return done;
}

/** Parent side: run every file of `files` not yet in `out`. */
export async function runPool(options: PoolOptions): Promise<void> {
  const done = doneFiles(options.out);
  const queue = readFileSync(options.files, "utf8")
    .split("\n")
    .filter((file) => file && !done.has(file));
  mkdirSync(dirname(options.out), { recursive: true });
  const log = openSync(`${options.out}.log`, "a");
  const total = queue.length;
  const started = Date.now();
  let finished = 0;
  console.error(`census: ${done.size} done, ${total} to go, ${options.jobs} jobs`);

  const record = (row: object): void => {
    appendFileSync(options.out, `${JSON.stringify(row)}\n`);
    finished += 1;
    if (finished % 100 === 0 || finished === total) {
      const rate = finished / ((Date.now() - started) / 1000);
      const eta = Math.round((total - finished) / rate / 60);
      console.error(`census: ${finished}/${total}, ${rate.toFixed(2)} files/s, eta ${eta} min`);
    }
  };

  const lane = async (): Promise<void> => {
    let child: ChildProcess | undefined;
    let rows: AsyncIterator<string> | undefined;
    let served = 0;
    const stop = () => {
      child?.kill("SIGKILL");
      child = undefined;
    };
    while (queue.length > 0) {
      if (!child || served >= RECYCLE_AFTER) {
        stop();
        child = spawn(process.execPath, [...process.execArgv, ...options.child], {
          cwd: options.cwd,
          stdio: ["pipe", "ignore", log, "pipe"],
        });
        rows = createInterface({ input: child.stdio[3] as Readable })[Symbol.asyncIterator]();
        served = 0;
      }
      const file = queue.shift()!;
      child.stdin!.write(`${file}\n`);
      served += 1;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
      });
      const next = await Promise.race([rows!.next(), timeout]);
      clearTimeout(timer);
      if (next === "timeout" || next.done) {
        const timedOut = next === "timeout";
        record({ file, status: timedOut ? "timeout" : "threw", error: timedOut ? "census timeout" : "child exited" });
        stop();
        continue;
      }
      record(JSON.parse(next.value) as object);
    }
    stop();
  };
  await Promise.all(Array.from({ length: Math.max(1, options.jobs) }, lane));
}
