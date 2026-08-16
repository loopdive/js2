// #2867 Gap 2 — async-fn throw → reject routing in the native `$Promise` carrier,
// plus the call-site prerequisite that makes a drive-lowered async result
// (a real `$Promise`) observable via `.then` at all.
//
// Three coupled fixes, ALL gated on the native-`$Promise` carrier
// (`isStandalonePromiseActive`), so the gc/host lane is byte-unchanged.
// (#2867 S2 correction, 2026-08-15: this said "wasi-only today → widens to
// standalone in lockstep at #2895 slice 1d" and called standalone
// "still-host-backed" — STALE. The widen landed with the #2980 flip on
// 2026-07-10; standalone is on the carrier, and only gc/host is unchanged.)
//
//  1. async-frame.ts — a `throw` in an async body, OR a rejected await, settles the
//     frame's result `$Promise` REJECTED (was: uncaught Wasm throw → trap / promise
//     stranded pending). Wrapped the resume dispatch in `try/catch $exn → __promise_reject`;
//     the continuation re-throws a microtask-delivered rejection (MODE_THROW+ERROR),
//     and the rejected-now entry arm arms MODE_THROW instead of delivering the reason
//     as a value.
//  2. async-scheduler.ts — a `.then`/`.catch` HANDLER that throws now rejects the
//     chained promise (spec PerformPromiseThen reject step) instead of letting the
//     exception escape the microtask wrapper uncaught (which trapped the whole drain).
//  3. expressions.ts — a drive-lowered async call (`f()` for a genuinely-suspending
//     async fn) already returns a real `$Promise`; the legacy call-site contract
//     (#1313/#1727) double-wrapped it in a second `Promise.resolve`, so `.then`/
//     assignment read NaN / illegal-cast. Skip the wrap for drive-lowered callees.
//
// Host-free: drive settlement with the module's own `__drain_microtasks` export.
// This is exactly the test262 `asyncTest(fn)` shape (`fn().then(verifyFulfill,
// $DONE)` — inline `.then` on the async call).
//
// (#2867 S2 CI-fix, 2026-08-15) "Host-free" here means **no JS-host carrier
// import** (`env.Promise_*`, `env.__make_callback`) — it does NOT mean an empty
// import section. Under `--target wasi` ANY `throw` links the WASI error path
// (`wasi_snapshot_preview1.fd_write` / `proc_exit`), which is the documented
// behaviour of that target, and three of these five cases throw on purpose. The
// old assertion here was `expect(r.imports).toEqual([])` followed by
// `WebAssembly.instantiate(r.binary, {})`, which:
//
//   * PASSED its assertion for the wrong reason — **`r.imports` under-reports**:
//     for every throwing wasi program it returns `[]` while the binary really
//     imports fd_write/proc_exit (verified by `WebAssembly.Module.imports`).
//     That is a live compiler-side defect and it makes `r.imports` unusable as a
//     host-free oracle anywhere; and
//   * then FAILED at instantiate with
//     `Import #0 "wasi_snapshot_preview1": module is not an object or function`.
//
// A/B by file copy against the #2867 S2/S2b source changes shows the identical
// 3 failures on the pre-#2867 base, so this is pre-existing on main and was not
// introduced by that commit (whose only edit to this file was a comment).
//
// The assertions below are therefore made STRONGER, not weaker: the import list
// is read from the **binary** (immune to the `r.imports` bug), `env.*` carrier
// imports are still forbidden outright, and the WASI shim asserts it is never
// actually CALLED — so a throw that escapes to the WASI abort path instead of
// being routed to a reject handler still fails the test.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Minimal `wasi_snapshot_preview1` shim that records any use. */
function wasiShim() {
  const calls: string[] = [];
  return {
    calls,
    importObject: {
      wasi_snapshot_preview1: {
        fd_write: () => {
          calls.push("fd_write");
          return 0;
        },
        proc_exit: (code: number) => {
          calls.push(`proc_exit(${code})`);
          throw new Error(`unexpected WASI proc_exit(${code})`);
        },
      },
    },
  };
}

async function runWasi(body: string, reads: string[]): Promise<Record<string, number>> {
  const src = `
let ff = 0;
let rj = 0;
let val = 0;
${body}
export function getFf(): number { return ff; }
export function getRj(): number { return rj; }
export function getVal(): number { return val; }
`;
  const r = await compile(src, { fileName: "t.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);

  // Read the truth from the binary — `r.imports` under-reports (see header).
  const binaryImports = WebAssembly.Module.imports(await WebAssembly.compile(r.binary)).map(
    (i) => `${i.module}.${i.name}`,
  );
  // The carrier must never fall back to a JS host import.
  expect(binaryImports.filter((n) => !n.startsWith("wasi_snapshot_preview1."))).toEqual([]);

  const shim = wasiShim();
  const { instance } = await WebAssembly.instantiate(r.binary, shim.importObject);
  const ex = instance.exports as Record<string, CallableFunction>;
  ex.run!();
  ex.__drain_microtasks?.();
  // A routed rejection must never reach the WASI abort/print path.
  expect(shim.calls).toEqual([]);
  const out: Record<string, number> = {};
  for (const n of reads) out[n] = ex[n]!() as number;
  return out;
}

describe("#2867 Gap 2 — async throw→reject routing (wasi carrier)", () => {
  it("a drive-lowered async result is observable via inline .then (call-site no double-wrap)", async () => {
    // The dominant prerequisite: `f().then(onF)` must thread f()'s settled value,
    // not a Promise-of-Promise (was NaN). A genuinely-pending await drives f().
    const r = await runWasi(
      `
      async function f(): Promise<number> { await Promise.resolve(1).then((w: number) => w + 40); return 42; }
      export function run(): void { f().then((v: number) => { val = v; }); }
      `,
      ["getVal"],
    );
    expect(r.getVal).toBe(42);
  });

  it("a throw after a genuinely-pending await rejects the result promise", async () => {
    const r = await runWasi(
      `
      async function f(): Promise<number> {
        const x = await Promise.resolve(1).then((v: number) => v + 40);
        throw x; // 41
      }
      export function run(): void { f().then((v: number) => { ff = 1; }, (e: number) => { rj = e; }); }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 41 });
  });

  it("a rejected genuinely-pending await propagates as a rejection", async () => {
    const r = await runWasi(
      `
      async function f(): Promise<number> {
        const x = await Promise.resolve(1).then((v: number) => { throw v + 40; });
        return x;
      }
      export function run(): void { f().then((v: number) => { ff = 1; }, (e: number) => { rj = e; }); }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 41 });
  });

  it("a throwing .then handler rejects the chained promise (not a trap)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.resolve(1)
          .then((v: number) => { throw v + 8; })
          .then((v: number) => { ff = 1; }, (e: number) => { rj = e; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 9 });
  });

  it("a normal (non-throwing) async fulfilment still routes to the fulfil handler", async () => {
    const r = await runWasi(
      `
      async function f(): Promise<number> {
        const x = await Promise.resolve(1).then((v: number) => v + 40);
        return x + 1; // 42
      }
      export function run(): void { f().then((v: number) => { val = v; }, (e: number) => { rj = -1; }); }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 42, getRj: 0 });
  });
});
