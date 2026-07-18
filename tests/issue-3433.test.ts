import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

// #3433 — per-compile memoization of the two full-file assignment scans:
//   - `symbolBindsAsyncFunction` (#2612): `x = async function …` detection,
//     previously re-walked the whole source file for EVERY call expression
//     whose earlier async checks fell through (i.e. every ordinary sync call);
//   - `resolveAssignedNominalType` (#2767): `var d; d = new Date(0)` nominal
//     recovery, previously re-walked the file per bare-`var`/`let` receiver.
// Both scans made compile time O(call-sites × file-size) — ~40 % of total
// compile time on oracle-v8 test262 harness assemblies (6–18 KB per test) and
// the root cause of the post-#3370 shard slowdown. The memo must be a pure
// compile-work optimization: identical detection results, identical output.

async function compileHost(src: string, opts?: Record<string, unknown>) {
  const r = await compile(src, { fileName: "t.ts", ...opts });
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  return r;
}

async function runHost(src: string): Promise<unknown> {
  const r = await compileHost(src);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as { test(): unknown }).test();
}

describe("#3433 memoized assignment scans preserve #2612/#2767 detection", () => {
  it("many sync calls + one late async assignment: every query still detects it", async () => {
    // Harness-shaped source: a pile of ordinary sync calls (each one used to
    // trigger a full-file rescan) around a two-step `var ref; ref = async …`
    // binding. The memo must classify ref() as async at every consuming call.
    const ret = await runHost(`
      function s1(x: number): number { return x + 1; }
      function s2(x: number): number { return s1(x) + s1(x); }
      function s3(x: number): number { return s2(x) + s2(x); }
      var ref;
      ref = async function (a: number) { return a; };
      export function test(): number {
        let acc = s3(1) + s3(2) + s2(3) + s1(4);
        const p: any = ref(acc);
        const q: any = ref(acc + 1);
        return p !== null && typeof p.then === "function" && q !== null && typeof q.then === "function" ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("distinct symbols are not conflated: sync var next to async var", async () => {
    const ret = await runHost(`
      var syncRef;
      var asyncRef;
      syncRef = function (a: number) { return a * 2; };
      asyncRef = async function (a: number) { return a; };
      export function test(): number {
        const s: any = syncRef(21);
        const p: any = asyncRef(1);
        const syncOk = s === 42 && (s === null || typeof s !== "object" || typeof s.then !== "function");
        const asyncOk = p !== null && typeof p.then === "function";
        return syncOk && asyncOk ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("#2767 Date nominal recovery still works with repeated queries", async () => {
    const ret = await runHost(`
      var d;
      d = new Date(0);
      export function test(): number {
        // Two member calls on the bare-var receiver → two memo lookups.
        const iso = d.toISOString();
        const t = d.getTime();
        return iso === "1970-01-01T00:00:00.000Z" && t === 0 ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("memo is per-compile: identical source compiles to identical bytes twice", async () => {
    const src = `
      var ref;
      ref = async function (a: number) { return a; };
      function sync(x: number): number { return x + 1; }
      export function test(): number {
        const p: any = ref(sync(1));
        return p !== null && typeof p.then === "function" ? 1 : 0;
      }
    `;
    const a = await compileHost(src);
    const b = await compileHost(src);
    expect(Buffer.compare(Buffer.from(a.binary), Buffer.from(b.binary))).toBe(0);
  });
});
