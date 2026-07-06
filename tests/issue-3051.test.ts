/**
 * #3051 — RegExp `[@@replace]` / `[@@split]` result-array coercion protocol.
 *
 * Mirrors the `built-ins/RegExp/prototype/Symbol.replace/result-coerce-*`
 * cluster from test262. A user overrides `regexp.exec` with a compiled
 * function that returns a plain object literal used as the match result:
 *
 *   r.exec = function() { return { 0: '…', index: {valueOf(){…}}, length: … }; };
 *
 * V8's native `RegExp.prototype[@@replace]` (which we delegate to via the
 * `__regex_symbol_call` host import) reads the result through the ordinary
 * `Get(result, "0" | "index" | "length" | "groups")` + `ToString` /
 * `ToIntegerOrInfinity` / `ToLength` protocol (spec §22.2.6.11). The compiled
 * object literal is an opaque WasmGC struct, so before #3051 V8 read every
 * field as `undefined` and the coercions never ran. The fix wraps a
 * `regexp.exec` override's RETURN value in `_wrapForHost` (see `__extern_set` /
 * `extern_set_strict` in src/runtime.ts) so the native protocol observes the
 * struct's fields and dispatches the nested `valueOf` / `toString` closures.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  if (typeof imports.setExports === "function") {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports as never as Record<string, () => unknown>)[fn]!();
}

// Slice 2 cases assign arbitrary values to RegExp's spec-readonly flag
// properties (`r.global = Symbol.replace`) after `Object.defineProperty`
// re-marks them writable — code TypeScript rejects at type-check time
// (`Cannot assign to 'global' because it is a read-only property`). The
// production test262 runner compiles every test with `skipSemanticDiagnostics:
// true` (see tests/test262-runner.ts), so mirror that here to exercise the same
// codegen path (the typed `RegExp_set_global` setter) the conformance run does.
async function runLoose(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  if (typeof imports.setExports === "function") {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports as never as Record<string, () => unknown>)[fn]!();
}

describe("#3051 — RegExp @@replace result-array coercion", { timeout: 30000 }, () => {
  it("coerces result 'index' via ToIntegerOrInfinity (index is an object with valueOf)", async () => {
    // test262: Symbol.replace/result-coerce-index.js
    const out = await run(`
      export function test(): string {
        const coercibleIndex: any = {
          length: 1,
          0: "",
          index: { valueOf: function(): number { return 2.9; } },
        };
        const r = /./;
        (r as any).exec = function(): any { return coercibleIndex; };
        const replacer = function(_m: string, position: number): number { return position; };
        return (r as any)[Symbol.replace]("abcd", replacer) as string;
      }
    `);
    expect(out).toBe("ab2cd");
  });

  it("coerces result[0] (matched) via ToString (matched is an object with toString)", async () => {
    // test262: Symbol.replace/result-coerce-matched.js
    const out = await run(`
      export function test(): string {
        const coercibleValue: any = {
          length: 1,
          0: { toString: function(): string { return "toString value"; } },
          index: 0,
        };
        const r = /./;
        (r as any).exec = function(): any { return coercibleValue; };
        return (r as any)[Symbol.replace]("", "foo[$&]bar") as string;
      }
    `);
    expect(out).toBe("foo[toString value]bar");
  });

  it("coerces result 'length' via ToLength (length is an object with valueOf)", async () => {
    // test262: Symbol.replace/result-coerce-length.js
    const out = await run(`
      export function test(): string {
        const coercibleIndex: any = {
          length: { valueOf: function(): number { return 3.9; } },
          0: "",
          1: "foo",
          2: "bar",
          3: "baz",
          index: 0,
        };
        const r = /./;
        (r as any).exec = function(): any { return coercibleIndex; };
        return (r as any)[Symbol.replace]("", "$1$2$3") as string;
      }
    `);
    expect(out).toBe("foobar$3");
  });

  it("coerces each capture via ToString (result-coerce-capture)", async () => {
    // test262: Symbol.replace/result-coerce-capture.js
    const out = await run(`
      export function test(): string {
        const coercibleValue: any = {
          length: 2,
          0: "",
          1: { toString: function(): string { return "toString value"; } },
          index: 0,
        };
        const r = /./;
        (r as any).exec = function(): any { return coercibleValue; };
        return (r as any)[Symbol.replace]("", "[$1]") as string;
      }
    `);
    expect(out).toBe("[toString value]");
  });

  it("reads an overridden exec result array back into wasm (round-trip)", async () => {
    const out = await run(`
      export function test(): string {
        const r = /x/;
        (r as any).exec = function(): any { return ["hello", "cap1"]; };
        const m: any = (r as any).exec("xyz");
        return (m[0] as string) + "|" + (m[1] as string) + "|len=" + (m.length as number);
      }
    `);
    expect(out).toBe("hello|cap1|len=2");
  });
});

describe("#3051 Slice 2 — arg / flag coercion", { timeout: 30000 }, () => {
  it("ToString's a non-callable replaceValue (arg-2-coerce)", async () => {
    // test262: Symbol.replace/arg-2-coerce.js — replaceValue is a non-callable
    // object; §22.2.6.11 step 7a does `replaceValue = ? ToString(replaceValue)`
    // (its `toString`, not `valueOf`, since ToString hints "string"). Before the
    // fix `wrapCallable` wrapped the object as a callable bridge, V8 saw
    // functionalReplace=true, invoked it, and ToString of the return was "null".
    const out = await run(`
      export function test(): string {
        const arg: any = {
          valueOf: function(): number { throw new Error("valueOf must not run"); },
          toString: function(): string { return "toString value"; },
        };
        return (/./ as any)[Symbol.replace]("string", arg) as string;
      }
    `);
    expect(out).toBe("toString valuetring");
  });

  it("propagates a throwing toString on the replaceValue (arg-2-coerce-err)", async () => {
    // test262: Symbol.replace/arg-2-coerce-err.js — the replaceValue's toString
    // throws; the abrupt completion must surface as the program's own error.
    const out = await run(`
      export function test(): number {
        const arg: any = {
          toString: function(): string { throw new Error("boom"); },
        };
        try {
          (/./ as any)[Symbol.replace]("string", arg);
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(out).toBe(1);
  });

  it("coerces a Symbol assigned to a writable .global to ToBoolean=true (coerce-global)", async () => {
    // test262: Symbol.replace/coerce-global.js — `r.global = Symbol.replace`
    // after re-marking .global writable. §22.2.6.11 step 8 reads it as
    // `ToBoolean(? Get(rx,"global"))` → truthy → exec loops (called twice).
    const out = await runLoose(`
      export function test(): number {
        const r = /a/;
        let execCount = 0;
        Object.defineProperty(r, "global", { writable: true });
        r.exec = function (): any {
          execCount += 1;
          if (execCount === 1) { return ["a"]; }
          return null;
        };
        execCount = 0;
        r.global = Symbol.replace;
        r[Symbol.replace]("aa", "b");
        return execCount;
      }
    `);
    expect(out).toBe(2);
  });

  it("coerces falsy values assigned to a writable .global to ToBoolean=false", async () => {
    // test262: Symbol.replace/coerce-global.js — `r.global = undefined|false`
    // → non-global replace (only the first match is replaced).
    const out = await runLoose(`
      export function test(): string {
        const r = /a/g;
        Object.defineProperty(r, "global", { writable: true });
        r.lastIndex = 0;
        r.global = false;
        return r[Symbol.replace]("aa", "b");
      }
    `);
    expect(out).toBe("ba");
  });

  it("coerces a Symbol assigned to a writable .unicode without trapping (coerce-unicode)", async () => {
    // test262: Symbol.replace/coerce-unicode.js — assigning a Symbol to a
    // writable .unicode must coerce via ToBoolean, not ToNumber (which traps).
    const out = await runLoose(`
      export function test(): string {
        const r = /a/;
        Object.defineProperty(r, "unicode", { writable: true });
        r.unicode = Symbol.replace;
        return r[Symbol.replace]("a", "b");
      }
    `);
    expect(out).toBe("b");
  });
});

// Slice 3 (dev-3051c) — abrupt-throw propagation through a THROWING GETTER on
// the exec-override result object. test262:
//   Symbol.replace/result-get-{index,length,matched}-err.js
//
// Root cause (verified empirically, distinct from the architect's original
// "wasm-exn swallowed in the get-trap" hypothesis): an object literal whose ONLY
// properties are accessors compiles to a JS-host plain object (externref
// `$Object`), but a closure that RETURNS it (`r.exec = function () { return
// poisoned; }`) has a TS-inferred *structural* return type `{ … }`, which
// `resolveWasmType` maps to a struct return. `return poisoned` then coerces the
// externref host object to a struct it does not match, so the value marshals to
// `null` at the host-invocation bridge (`__call_fn_N`). V8's native @@replace
// sees `r.exec()` → null → RegExpExec finds no match → the result-object reads
// (and their throwing getters) never run. Fix (src/codegen/closures.ts):
// `computeClosureWrapperSig` forces the closure return type to externref when the
// body returns a host-path accessor object literal, keeping the host object
// intact so the native protocol dispatches the getter (and its throw).
describe("#3051 Slice 3 — throwing getter on exec result (abrupt propagation)", { timeout: 30000 }, () => {
  it("throwing `index` getter on the result object propagates (result-get-index-err)", async () => {
    const out = await run(`
      class Test262Error {}
      export function test(): string {
        const poisoned: any = { get index(): number { throw new Test262Error(); } };
        const r = /./;
        (r as any).exec = function (): any { return poisoned; };
        try {
          (r as any)[Symbol.replace]("a", "b");
        } catch (e) {
          return "threw";
        }
        return "no-throw";
      }
    `);
    expect(out).toBe("threw");
  });

  it("throwing `0` (matched) getter on the result object propagates (result-get-matched-err)", async () => {
    const out = await run(`
      class Test262Error {}
      export function test(): string {
        const poisoned: any = { get 0(): string { throw new Test262Error(); } };
        const r = /./;
        (r as any).exec = function (): any { return poisoned; };
        try {
          (r as any)[Symbol.replace]("a", "b");
        } catch (e) {
          return "threw";
        }
        return "no-throw";
      }
    `);
    expect(out).toBe("threw");
  });

  it("throwing `length` getter on the result object propagates (result-get-length-err)", async () => {
    const out = await run(`
      class Test262Error {}
      export function test(): string {
        const poisoned: any = { get length(): number { throw new Test262Error(); } };
        const r = /./;
        (r as any).exec = function (): any { return poisoned; };
        try {
          (r as any)[Symbol.replace]("a", "b");
        } catch (e) {
          return "threw";
        }
        return "no-throw";
      }
    `);
    expect(out).toBe("threw");
  });

  it("exec override returning an accessor-only object literal DIRECTLY is not nulled", async () => {
    // The closure returns the object literal inline (no intermediate var) — the
    // inferred struct return type must still be forced to externref.
    const out = await run(`
      export function test(): number {
        let ran = 0;
        const r = /./;
        (r as any).exec = function (): any { return { get index(): number { ran = 1; return 2; } }; };
        (r as any)[Symbol.replace]("abcd", function (_m: string, pos: number): string { return String(pos); });
        return ran; // 1 iff V8's protocol observed the object + ran its getter
      }
    `);
    expect(out).toBe(1);
  });

  it("regression guard: a closure returning a plain DATA object is unaffected", async () => {
    // No accessors → the predicate must NOT fire; struct return path preserved.
    const out = await run(`
      export function test(): number {
        const f = function (): { a: number; b: number } { return { a: 3, b: 4 }; };
        const o = f();
        return o.a + o.b;
      }
    `);
    expect(out).toBe(7);
  });
});
