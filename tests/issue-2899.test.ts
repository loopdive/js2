import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { parseMeta, createTestSandbox } from "./test262-runner.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";

// #2899 — ≤ES3: Function `.caller` / `.arguments` poison-pill must throw
// TypeError on get AND set (`bound.caller`, `bound.caller = {}`, etc.).
//
// `Function.prototype.caller` / `Function.prototype.arguments` are poison-pill
// accessor properties whose `[[Get]]` and `[[Set]]` invoke %ThrowTypeError%
// (ES5 §13.2.3 / ES2015+ §10.2.4). A bound function inherits them from
// %FunctionPrototype%, so reading or writing `bound.caller` / `bound.arguments`
// must raise a catchable TypeError.
//
// HISTORY — why this file was rewritten (2026-07-25). #2899 was closed on
// 2026-06-30 as "already fixed", on the strength of the #2745 `_safeSet`
// `strictAccessorWrite` path plus a green `runTest262File` check. Both signals
// were misleading, and the conformance test never passed:
//
//   * every unit case below compiled a source containing `export`, which makes
//     it MODULE code — always strict — so the member write routed through
//     `__extern_set_strict` and hit the strict-only accessor pre-check;
//   * `runTest262File` uses `wrapTest`, not the harness assembly CI scores, so
//     its verdict is not the conformance verdict.
//
// The real oracle (`assembleOriginalHarness`) runs
// `language/statements/function/13.2-30-s.js` at SCRIPT goal in its primary
// variant — sloppy mode, `__extern_set`, `strict = false`. There `_safeSet`
// skipped the accessor lookup entirely, the poison-pill setter's TypeError was
// caught, and the write was silently diverted to the sidecar. Only the two SET
// arms failed; both GET arms and the strict rerun always passed.
//
// Fix (#2899): §10.1.9.2 OrdinarySetWithOwnDescriptor step 3 CALLS the setter,
// and an abrupt completion from the setter propagates regardless of the
// Reference's strictness — sloppy-mode silence covers only [[Set]] RETURNING
// false (non-writable data / accessor with no setter). `_safeSet` now resolves
// the descriptor lazily on the exceptional path and re-raises when the write
// landed on an accessor that HAS a setter.

const WORKER_COMPILE_OPTS = {
  allowJs: true,
  fileName: "test.js",
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
} as const;

/** Compile + run a SCRIPT-goal (sloppy) source, returning its console output. */
async function runSloppy(source: string): Promise<{ logs: string[]; imports: unknown[] }> {
  const result = await compile(source, WORKER_COMPILE_OPTS as never);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const logs: string[] = [];
  const consoleProxy = {
    log: (...v: unknown[]) => logs.push(v.map(String).join(" ")),
    error: (...v: unknown[]) => logs.push(v.map(String).join(" ")),
    warn: () => {},
  };
  const imports = buildImports(result.imports, { console: consoleProxy } as unknown as never, result.stringPool, {
    globalSandbox: createTestSandbox(consoleProxy as unknown as Console),
  } as never);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
  if (typeof moduleInit === "function") (moduleInit as () => void)();
  return { logs, imports: result.imports as unknown[] };
}

/** Compile + run a MODULE-goal (always strict) source and return its exports. */
async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  // The bound-function bridge needs the live exports to dispatch the wasm
  // closure target (#1632a/#2745).
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return instance.exports as Record<string, Function>;
}

describe("#2899 — bound-function caller/arguments poison-pill throws on get and set", () => {
  it("SLOPPY (script goal): set of bound.caller / bound.arguments throws TypeError", async () => {
    // This is the arm the conformance test actually exercises and the one that
    // was broken. Digits pinpoint the failing arm:
    //   1 = set bound.caller, 10 = set bound.arguments, +7 = the control write.
    const { logs, imports } = await runSloppy(`
      function target() {}
      var self = {};
      var bound = target.bind(self);
      var score = 0;
      try { bound.caller = {}; } catch (e) { if (e instanceof TypeError) { score = score + 1; } }
      try { bound.arguments = {}; } catch (e) { if (e instanceof TypeError) { score = score + 10; } }
      var o = {}; o.x = 7; score = score + o.x;
      console.log("score=" + score);
    `);
    // Guard the premise: a SLOPPY write must lower to `__extern_set`, not
    // `__extern_set_strict`. If this ever flips, the test stops covering the
    // sloppy path and silently becomes a duplicate of the module-goal case
    // below — which is exactly how #2899 was closed prematurely.
    const setImports = imports.filter((i) => JSON.stringify(i).includes("extern_set"));
    expect(JSON.stringify(setImports)).toContain('"__extern_set"');
    expect(JSON.stringify(setImports)).not.toContain("__extern_set_strict");
    expect(logs).toEqual(["score=18"]);
  });

  it("SLOPPY control: a non-writable DATA property write still silently no-ops", async () => {
    // §10.1.9.2 returns false (no setter to call) → PutValue is silent for a
    // non-strict Reference. This must NOT start throwing: it is the behaviour
    // S8.5_A9 / S8.12.4_A1 / S8.6.1_A1 depend on, and it is what keeps the
    // #2899 fix narrow (setter-present only).
    const { logs } = await runSloppy(`
      var threw = 0;
      try { Math.E = 1; } catch (e) { threw = threw + 1; }
      try { Number.NaN = 1; } catch (e) { threw = threw + 10; }
      console.log("threw=" + threw);
    `);
    expect(logs).toEqual(["threw=0"]);
  });

  it("SLOPPY control: a getter-only accessor write still silently no-ops", async () => {
    // Accessor with NO setter → [[Set]] returns false → sloppy silence, again
    // per §10.1.9.2. Only an accessor that HAS a setter may propagate.
    const { logs } = await runSloppy(`
      var o = {};
      Object.defineProperty(o, "x", { get: function () { return 5; }, configurable: true });
      var threw = 0;
      try { o.x = 9; } catch (e) { threw = 1; }
      console.log("threw=" + threw + ",x=" + o.x);
    `);
    expect(logs).toEqual(["threw=0,x=5"]);
  });

  it("SLOPPY: a user accessor whose setter throws propagates that exception", async () => {
    // The general rule the poison pill is one instance of.
    const { logs } = await runSloppy(`
      var o = {};
      Object.defineProperty(o, "x", {
        set: function () { throw new TypeError("boom"); },
        configurable: true,
      });
      var caught = "none";
      try { o.x = 9; } catch (e) { caught = e.message; }
      console.log("caught=" + caught);
    `);
    expect(logs).toEqual(["caught=boom"]);
  });

  it("MODULE goal (always strict): get/set of bound.caller and bound.arguments all throw TypeError", async () => {
    //   1 = get bound.caller, 10 = set bound.caller, 100 = get bound.arguments,
    //   1000 = set bound.arguments.
    const e = await compileAndRun(`
      let __score: number = 0;
      function expectThrowsTE(bit: number, fn: () => void): void {
        try { fn(); } catch (err) { if (err instanceof TypeError) { __score = __score + bit; } return; }
      }
      export function test(): number {
        function target() {}
        var self = {};
        var bound = target.bind(self);
        expectThrowsTE(1,    function() { return bound.caller; });
        expectThrowsTE(10,   function() { bound.caller = {}; });
        expectThrowsTE(100,  function() { return bound.arguments; });
        expectThrowsTE(1000, function() { bound.arguments = {}; });
        return __score;
      }
    `);
    expect(e.test!()).toBe(1111);
  });

  it("bound functions have no own caller/arguments (inherited from %FunctionPrototype%)", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        function target() {}
        var self = {};
        var bound = target.bind(self);
        var r = 0;
        if (bound.hasOwnProperty('caller') === false) r += 1;
        if (bound.hasOwnProperty('arguments') === false) r += 10;
        return r;
      }
    `);
    expect(e.test!()).toBe(11);
  });

  it("control: ordinary object & function-custom property set/get is unaffected", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var o: any = {}; o.x = 7;          // ordinary object property
        function f() {}
        (f as any).foo = 42;               // function's own non-poison property
        return o.x + (f as any).foo;       // 49
      }
    `);
    expect(e.test!()).toBe(49);
  });

  // Authoritative end-to-end guard: the exact test262 case, assembled and run
  // the way CI scores it (`assembleOriginalHarness` → primary + strict rerun),
  // NOT via `runTest262File`/`wrapTest`, whose verdict is not the conformance
  // verdict and which reported this test green while it was failing.
  // Skipped gracefully when the test262 submodule isn't checked out.
  it("test262 language/statements/function/13.2-30-s.js passes both harness variants", async () => {
    const file = join(
      import.meta.dirname ?? ".",
      "..",
      "test262",
      "test",
      "language",
      "statements",
      "function",
      "13.2-30-s.js",
    );
    if (!existsSync(file)) return; // submodule not present in this job
    const source = readFileSync(file, "utf-8");
    const assembly = assembleOriginalHarness(source, parseMeta(source));
    // The primary variant is the SCRIPT-goal (sloppy) run — the one #2899 fixes.
    expect(assembly.strictRerun).toBeDefined();
    for (const variant of [assembly.primary, assembly.strictRerun!]) {
      const result = await compile(variant.source, WORKER_COMPILE_OPTS as never);
      expect(result.success).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
      (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
        instance.exports as Record<string, Function>,
      );
      const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
      expect(typeof moduleInit).toBe("function");
      // Completing the literal harness assembly without throwing IS the verdict.
      expect(() => (moduleInit as () => void)()).not.toThrow();
    }
  }, 60_000);
});
