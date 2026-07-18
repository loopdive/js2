// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2958 — standalone/WASI unhandled-rejection tracking.
 *
 * The native `$Promise` carrier (`src/codegen/async-scheduler.ts`) previously
 * let a promise that settled REJECTED with no reaction vanish silently: the
 * program exited 0 with the error swallowed. This adds Node-parity reporting:
 * at PROGRAM EXIT (the WASI `_start` tail, after the microtask/event-loop
 * drain), every still-unhandled rejection is written to stderr and the program
 * exits nonzero.
 *
 * Mechanism (see `ensureUnhandledRejectionTracking` / `…Reporter`): an intrusive
 * `$__unhandled_node` list is prepended on a handler-less rejection (both the
 * direct `Promise.reject(x)` mint and the `__promise_reject` settle of a
 * previously-pending promise); a later `.then/.catch/.finally`, an `await`, or a
 * combinator subscription marks the matching node handled so the reporter skips
 * it.
 *
 * These cases compile each program under `--target wasi` and run the produced
 * module under V8 (this Node) with a minimal `wasi_snapshot_preview1` shim so
 * the test is independent of the host wasmtime version (wasmtime ≥ 41 dropped
 * the legacy exception-handling encoding the promise runtime emits). The shim
 * captures stdout, stderr, and the `proc_exit` code.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Number of non-empty stderr lines (one per reported unhandled rejection). */
  reportLines: number;
}

/** Compile `src` under --target wasi and run `_start` under a minimal WASI shim. */
async function runWasi(src: string, name: string): Promise<RunResult> {
  const r = await compile(src, { fileName: `${name}.ts`, target: "wasi", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const dec = new TextDecoder();
  let mem: WebAssembly.Memory | undefined;

  const readIovs = (iovsPtr: number, iovsLen: number): string => {
    const dv = new DataView(mem!.buffer);
    let s = "";
    for (let i = 0; i < iovsLen; i++) {
      const base = dv.getUint32(iovsPtr + i * 8, true);
      const len = dv.getUint32(iovsPtr + i * 8 + 4, true);
      s += dec.decode(new Uint8Array(mem!.buffer, base, len));
    }
    return s;
  };

  const wasi = {
    fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
      const s = readIovs(iovs, iovsLen);
      if (fd === 2) stderr += s;
      else stdout += s;
      const dv = new DataView(mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) total += dv.getUint32(iovs + i * 8 + 4, true);
      dv.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit: (code: number): void => {
      exitCode = code;
      throw { __exit: code };
    },
    fd_read: () => 0,
    fd_close: () => 0,
    clock_time_get: () => 0,
    poll_oneoff: () => 0,
    random_get: () => 0,
    environ_get: () => 0,
    environ_sizes_get: () => 0,
    fd_fdstat_set_flags: () => 0,
    path_open: () => 0,
  };

  try {
    const { instance } = await WebAssembly.instantiate(r.binary!, { wasi_snapshot_preview1: wasi });
    mem = instance.exports.memory as WebAssembly.Memory;
    (instance.exports._start as (() => void) | undefined)?.();
  } catch (e) {
    if (!(e && typeof e === "object" && "__exit" in e)) throw e;
  }

  const reportLines = stderr.split("\n").filter((l) => l.length > 0).length;
  return { exitCode, stdout, stderr, reportLines };
}

describe("#2958 — WASI unhandled-rejection tracking", () => {
  it("AC1: Promise.reject with no handler reports and exits nonzero", async () => {
    const r = await runWasi(`Promise.reject(new Error("x"));`, "ac1-nohandler");
    expect(r.exitCode).toBe(1);
    expect(r.reportLines).toBe(1);
    expect(r.stderr).toContain("Unhandled promise rejection");
  });

  it("AC2: adding .catch silences the report (exit 0)", async () => {
    const r = await runWasi(`Promise.reject(new Error("x")).catch(() => {});`, "ac2-catch");
    expect(r.exitCode).toBe(0);
    expect(r.reportLines).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("AC2: .catch on a variable-held rejected promise silences it", async () => {
    const r = await runWasi(`const p = Promise.reject(new Error("x")); p.catch(() => {});`, "ac2-var-catch");
    expect(r.exitCode).toBe(0);
    expect(r.reportLines).toBe(0);
  });

  it("AC2: a two-arg .then whose onRejected handles it silences the report", async () => {
    const r = await runWasi(
      `Promise.reject(new Error("x")).then(() => {}, () => { console.log("onrej"); });`,
      "ac2-then-onrej",
    );
    expect(r.exitCode).toBe(0);
    expect(r.reportLines).toBe(0);
    expect(r.stdout).toBe("onrej\n");
  });

  it("AC3: reject inside a microtask with a same-turn late .catch does NOT report", async () => {
    const r = await runWasi(
      `Promise.resolve().then(() => { const p = Promise.reject(new Error("x")); p.catch(() => {}); });`,
      "ac3-same-turn",
    );
    expect(r.exitCode).toBe(0);
    expect(r.reportLines).toBe(0);
  });

  it("a rejected promise with no handler still reports even when other work runs", async () => {
    const r = await runWasi(
      `console.log("before"); Promise.reject(new Error("x")); console.log("after");`,
      "reports-around-work",
    );
    expect(r.exitCode).toBe(1);
    expect(r.reportLines).toBe(1);
    expect(r.stdout).toBe("before\nafter\n");
  });

  it("reports once per independent unhandled rejection", async () => {
    const r = await runWasi(`Promise.reject(new Error("a")); Promise.reject(new Error("b"));`, "two-unhandled");
    expect(r.exitCode).toBe(1);
    expect(r.reportLines).toBe(2);
  });

  it("non-Error rejection reasons are also reported (string, number)", async () => {
    const s = await runWasi(`Promise.reject("boom");`, "reject-string");
    expect(s.exitCode).toBe(1);
    expect(s.reportLines).toBe(1);
    const n = await runWasi(`Promise.reject(42);`, "reject-number");
    expect(n.exitCode).toBe(1);
    expect(n.reportLines).toBe(1);
  });

  it("a new Promise executor reject with no handler reports; a .catch silences it", async () => {
    const bare = await runWasi(`new Promise((_, rej) => { rej(new Error("z")); });`, "exec-reject");
    expect(bare.exitCode).toBe(1);
    expect(bare.reportLines).toBe(1);
    const caught = await runWasi(
      `new Promise((_, rej) => { rej(new Error("z")); }).catch(() => {});`,
      "exec-reject-caught",
    );
    expect(caught.exitCode).toBe(0);
    expect(caught.reportLines).toBe(0);
  });

  it("a rejection propagated to a DERIVED promise (via .then) is reported on the derived promise", async () => {
    const r = await runWasi(`Promise.reject(new Error("x")).then(() => { console.log("nope"); });`, "derived-reject");
    expect(r.exitCode).toBe(1);
    expect(r.reportLines).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("Promise.all whose result is caught does NOT report (combinator marks its input handled)", async () => {
    const r = await runWasi(`Promise.all([Promise.reject(new Error("x"))]).catch(() => {});`, "all-reject-caught");
    expect(r.exitCode).toBe(0);
    expect(r.reportLines).toBe(0);
  });

  it("no false positive: a fully-resolved chain never reports", async () => {
    const r = await runWasi(
      `Promise.resolve(1).then((v) => v + 1).then((v) => { console.log("final=" + v); });`,
      "resolved-chain",
    );
    expect(r.exitCode).toBe(0);
    expect(r.reportLines).toBe(0);
    expect(r.stdout).toBe("final=2\n");
  });

  it("no behavior change for a promise-free module (no report, exit 0)", async () => {
    const r = await runWasi(`console.log("hi");`, "no-promise");
    expect(r.exitCode).toBe(0);
    expect(r.reportLines).toBe(0);
    expect(r.stdout).toBe("hi\n");
  });
});
