// #2035 — a generator's `return <value>` was pushed into the eager yield
// buffer as a normal element, so spread / for-of / Array.from / yield*
// surfaced it as an extra yielded value, and the terminal
// `{value, done:true}` result never materialized.
//
// Per ECMA-262 §27.5.1.2 the return value belongs ONLY to the final
// `{value, done:true}` IteratorResult and must be excluded from
// IteratorClose-consuming constructs (spread, for-of, Array.from, yield*).
//
// Fix has two halves:
//   1. Runtime + legacy codegen route the return value through
//      `__gen_set_return`, which stashes it on the buffer as a side
//      property; the host `next()` drain surfaces it once with `done:true`.
//   2. The IR front-end (`src/ir/from-ast.ts` lowerTail) previously emitted
//      its OWN `__gen_push_*` for the return — the second codegen path that
//      kept for-of over an immediate `g()` call leaking. It now defers any
//      generator carrying a `return <expr>` to the (correct) legacy path.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => `L${e.line}: ${e.message}`).join("; ")}`);
  }
  const importObj = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(result.binary, importObj as never);
  if (typeof importObj.setExports === "function") {
    (importObj.setExports as (e: unknown) => void)(instance.exports);
  }
  return (instance.exports as { test(): unknown }).test();
}

describe("#2035 generator return value excluded from iteration", () => {
  it("spread excludes the return value", async () => {
    const got = await run(`
      function* g() { yield 1; yield 2; return 3; }
      export function test(): string { return JSON.stringify([...g()]); }`);
    expect(got).toBe("[1,2]"); // node: [1,2] (was [1,2,3])
  });

  it("for-of over an immediate generator call excludes the return value (sum)", async () => {
    const got = await run(`
      function* g() { yield 1; yield 2; return 3; }
      export function test(): number { let s = 0; for (const v of g()) { s += v; } return s; }`);
    expect(got).toBe(3); // node: 3 (was 6 — leaked the return 3)
  });

  it("for-of over an immediate generator call visits exactly the yields (count)", async () => {
    const got = await run(`
      function* g() { yield 1; yield 2; return 3; }
      export function test(): number { let c = 0; for (const v of g()) { c++; } return c; }`);
    expect(got).toBe(2); // node: 2 (was 3)
  });

  it("Array.from excludes the return value", async () => {
    const got = await run(`
      function* g() { yield 1; yield 2; return 3; }
      export function test(): string { return JSON.stringify(Array.from(g())); }`);
    expect(got).toBe("[1,2]"); // node: [1,2] (was [1,2,3])
  });

  it("yield* delegation does not leak the inner generator's return value", async () => {
    const got = await run(`
      function* inner() { yield 1; yield 2; return 99; }
      function* outer() { yield* inner(); yield 3; }
      export function test(): string { return JSON.stringify([...outer()]); }`);
    expect(got).toBe("[1,2,3]"); // node: [1,2,3] (inner's return 99 excluded)
  });

  it("raw next() surfaces the return value once with done:true, then undefined", async () => {
    // The terminal result must be {value:3, done:true}; the step after that
    // is {value:undefined, done:true}. The load-bearing facts: value 3 lands
    // on the FIRST done:true step (not as a yielded done:false element), and
    // the next step has no value, both with done:true. We encode each step's
    // (value, done) into one number so the comparison is representation-stable
    // across the wasm host boundary (done is a wasm i32 boolean, the terminal
    // empty value is an empty externref).
    const got = await run(`
      function* g() { yield 1; yield 2; return 3; }
      export function test(): string {
        const it = g();
        const a = it.next(); const b = it.next(); const c = it.next(); const d = it.next();
        // each entry: "<value>/<done 0|1>"; undefined value renders as ""
        function enc(r: any): string { return (r.value === undefined ? "" : String(r.value)) + "/" + (r.done ? "1" : "0"); }
        return enc(a) + "," + enc(b) + "," + enc(c) + "," + enc(d);
      }`);
    // a=1/0, b=2/0, c=3/1 (return surfaced once, done), d=/1 (undefined, done)
    expect(got).toBe("1/0,2/0,3/1,/1");
  });

  it("a string-typed yield with a numeric return still excludes the return", async () => {
    const got = await run(`
      function* g() { yield 1; return 7; }
      export function test(): number { let s = 0; for (const v of g()) { s += v; } return s; }`);
    expect(got).toBe(1); // node: 1 (yield 1 only; return 7 excluded)
  });

  it("a bare 'return;' (no value) iterates correctly", async () => {
    const got = await run(`
      function* g() { yield 1; if (true) { yield 2; } return; }
      export function test(): string { return JSON.stringify([...g()]); }`);
    expect(got).toBe("[1,2]"); // node: [1,2]
  });

  it("gen.return(v) early-termination semantics unchanged", async () => {
    const got = await run(`
      function* g() { yield 1; yield 2; yield 3; return 9; }
      export function test(): string {
        const it = g();
        const a = it.next();
        const r = it.return(42);
        const b = it.next();
        function enc(res: any): string { return (res.value === undefined ? "" : String(res.value)) + "/" + (res.done ? "1" : "0"); }
        return enc(a) + "," + enc(r) + "," + enc(b);
      }`);
    // a=1/0; return(42) → 42/1 (caller value, done; generator's own return 9
    // suppressed); next() → /1 (undefined, done)
    expect(got).toBe("1/0,42/1,/1");
  });
});
