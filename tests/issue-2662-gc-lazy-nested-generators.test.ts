// #2662 — host (gc) generator backend was EAGER-buffered: it ran the whole
// generator body at creation, breaking §27.5.3.1 suspend-at-start (nothing may
// run before the first `.next()`), side-effect interleaving, and infinite
// generators.
//
// Slice 1 (this PR) makes the CAPTURING NESTED generator shape LAZY on the
// default gc/host lane — the exact wrapped-test262 shape (`wrapTest` nests every
// test's top-level `function* g()` inside `export function test()`, capturing
// the test-local `var`s). Such a generator never escapes to a JS caller (it is
// local to its enclosing function), so the opaque-native-struct→JS boundary
// blocker does not apply and it routes to the native lazy state machine.
//
// TOP-LEVEL generators deliberately STAY eager on the host lane (they can be
// exported / returned to JS, where the native state struct is not a JS-callable
// Generator object and a post-done `.value` read surfaces the sentinel as NaN).
// Their lazy routing waits on the JS-boundary wrapper (the remaining #2662
// epic lever). The guard-rail tests below lock that boundary in.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Local harness that WIRES setExports — the eager-buffer nested-generator path
// (the guard-rail cases that deliberately stay eager) uses a lazy thunk that
// re-enters the module through `__call_fn_0`/`__gen_set_eager`, which needs the
// exports wired back into the host imports. The shared `compileAndRunInstance`
// helper does not call setExports, so use this instead.
async function compileAndRun(source: string): Promise<{ exports: Record<string, Function> }> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const importObj = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(result.binary, importObj as never);
  if (typeof importObj.setExports === "function") {
    (importObj.setExports as (e: unknown) => void)(instance.exports);
  }
  return { exports: instance.exports as Record<string, Function> };
}

describe("#2662 capturing-nested generators are lazy on the gc/host lane", () => {
  it("does NOT run the body at creation (§27.5.3.1 suspend-at-start)", async () => {
    const { exports } = await compileAndRun(`
      export function test(): number {
        // 'var'-captured so it is NOT TDZ-flagged (host-lane TDZ threading is a
        // separate wave); this is the wrapped-test262 var-capture shape.
        var flag = 0;
        function* g() { flag = 1; yield 1; flag = 2; yield 2; flag = 3; }
        const it = g();          // create only — NO .next()
        var before = flag;       // lazy => 0 (eager buffer would be 3)
        it.next(); it.next(); it.next();   // drive to completion
        return before * 10 + flag;         // 0*10 + 3 = 3 (before MUST be 0)
      }
    `);
    // before === 0 (lazy) → 0*10+3 = 3; an eager buffer would give 3*10+3 = 33.
    expect((exports.test as Function)()).toBe(3);
  });

  it("interleaves side effects one step per next()", async () => {
    const { exports } = await compileAndRun(`
      export function test(): string {
        var log = "[";
        function* g() { log += "a"; yield 1; log += "b"; yield 2; log += "c"; }
        const it = g();
        it.next(); log += "|";
        it.next(); log += "|";
        it.next();
        return log;              // "[a|b|c" (eager: "abc[||")
      }
    `);
    expect((exports.test as Function)()).toBe("[a|b|c");
  });

  it("wrapped-test262 shape: nothing runs before for-of drive, all runs during", async () => {
    const { exports } = await compileAndRun(`
      export function test(): string {
        var iterations = 0;
        function* g() { iterations += 1; yield 1; iterations += 1; yield 2; iterations += 1; yield 3; }
        var before = iterations;           // 0 (lazy)
        var sum = 0;
        for (const v of g()) sum += v;      // drives all 3
        return before + "/" + iterations + "/" + sum;   // "0/3/6"
      }
    `);
    expect((exports.test as Function)()).toBe("0/3/6");
  });

  it("infinite capturing nested generator terminates (eager buffer would hang)", async () => {
    const { exports } = await compileAndRun(`
      export function test(): number {
        var seen = 0;
        function* nat() { var i = 0; while (true) { seen = i; yield i; i++; } }
        const it = nat();
        var sum = 0;
        // Take exactly 3 — an eager buffer would never return from creation.
        sum += it.next().value as number;
        sum += it.next().value as number;
        sum += it.next().value as number;
        return sum;   // 0+1+2 = 3
      }
    `);
    expect((exports.test as Function)()).toBe(3);
  });

  // ── Guard-rails: shapes that MUST stay eager (correctness) ──────────────

  it("GUARD: an exported (escaping) generator stays a JS-callable Generator", async () => {
    const { exports } = await compileAndRun(`
      export function* g(): Generator<number> { yield 1; yield 2; }
    `);
    const gen = (exports.g as Function)();
    // The eager host path returns a real JS Generator object; the native
    // struct would have no callable `.next`.
    expect(typeof gen.next).toBe("function");
    expect(gen.next().value).toBe(1);
    expect(gen.next().value).toBe(2);
    expect(gen.next().done).toBe(true);
  });

  it("GUARD: a top-level generator's post-done .value is undefined (eager path)", async () => {
    const { exports } = await compileAndRun(`
      function* g() { yield 1; yield 2; }
      export function test(): string {
        const it = g();
        const a = it.next(); const b = it.next(); const c = it.next();
        function enc(r: any): string { return (r.value === undefined ? "" : String(r.value)) + "/" + (r.done ? "1" : "0"); }
        return enc(a) + "," + enc(b) + "," + enc(c);   // "1/0,2/0,/1"
      }
    `);
    expect((exports.test as Function)()).toBe("1/0,2/0,/1");
  });

  it("GUARD: a nested generator with a return value stays eager (excluded)", async () => {
    const { exports } = await compileAndRun(`
      export function test(): string {
        var iterations = 0;
        function* g() { iterations += 1; yield 1; iterations += 1; return 99; }
        // spread must exclude the return value (§27.5.1.2)
        return JSON.stringify([...g()]);   // "[1]"
      }
    `);
    expect((exports.test as Function)()).toBe("[1]");
  });
});
