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
async function runLoose(source: string, fn = "test", fileName = "test.ts"): Promise<unknown> {
  const result = await compile(source, {
    fileName,
    skipSemanticDiagnostics: true,
    ...(fileName.endsWith(".js") ? { allowJs: true } : {}),
  });
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

  it("propagates an own unicode getter throw through @@replace", async () => {
    const out = await runLoose(`
      export function test(): number {
        const marker: any = { tag: "unicode" };
        let score = 0;
        for (const r of [/./, /./g] as any[]) {
          Object.defineProperty(r, "unicode", {
            get: function(): any { throw marker; }
          });
          try { void r.unicode; } catch (e: any) { if (e === marker) score += 10; }
          try { r[Symbol.replace]("", ""); } catch (e: any) { if (e === marker) score += 1; }
        }
        return score;
      }
    `);
    expect(out).toBe(22);
  });

  it("derives @@replace mode from flags without rereading global or unicode", async () => {
    const out = await runLoose(`
      export function test(): number {
        const r: any = /./;
        let flagsReads = 0;
        Object.defineProperty(r, "flags", {
          get: function(): string { flagsReads += 1; return ""; }
        });
        Object.defineProperty(r, "global", {
          configurable: true,
          get: function(): never { throw new Error("global was reread"); }
        });
        Object.defineProperty(r, "unicode", {
          configurable: true,
          get: function(): never { throw new Error("unicode was reread"); }
        });
        const result = r[Symbol.replace]("a", "b");
        return result === "b" && flagsReads === 1 ? 1 : 0;
      }
    `);
    expect(out).toBe(1);
  });

  it("propagates the unicode getter throw through an unannotated JS callback", async () => {
    const out = await runLoose(
      `function capturesThrow(func, marker) {
         try { func(); } catch (error) { return error === marker ? 1 : 2; }
         return 0;
       }
       export function test() {
         var r = /./g;
         var marker = { tag: "unicode" };
         Object.defineProperty(r, "unicode", {
           get: function() { throw marker; }
         });
         return capturesThrow(function() { r[Symbol.replace]("", ""); }, marker);
       }`,
      "test",
      "issue-3051.js",
    );
    expect(out).toBe(1);
  });
});

describe("#3051 Slice 3 — abrupt-throw propagation + @@split species protocol", { timeout: 30000 }, () => {
  it("propagates a throwing result getter through @@replace (result-get-index-err)", async () => {
    // A poisoned exec result: `get index() { throw marker }`. Accessor-bearing
    // literals are HOST objects; before the fix the closure returning it
    // null-dropped (externref→struct ref.test fallback), the getter never
    // fired, and the abrupt completion was lost.
    const out = await runLoose(`
      export function test(): number {
        var r = /./;
        var marker: any = { tag: "m" };
        var poisonedIndex = {
          get index(): number { throw marker; }
        };
        (r as any).exec = function() { return poisonedIndex; };
        try {
          (r as any)[Symbol.replace]('a', 'b');
          return 0;
        } catch (e: any) {
          return e === marker ? 1 : 2;
        }
      }
    `);
    expect(out).toBe(1);
  });

  it("exposes a null-valued result field as null, not undefined (result-coerce-groups-err)", async () => {
    // `{ groups: null }` — §22.2.6.11 step 14.j/l: ToObject(null) must throw
    // TypeError. The struct-field null previously read back as a shape-miss.
    const out = await runLoose(`
      export function test(): number {
        var r = /./;
        var coercibleValue: any = { length: 1, 0: '', index: 0, groups: null };
        r.exec = function(): any { return coercibleValue; };
        try {
          (r as any)[Symbol.replace]('bar', '');
          return 0;
        } catch (e: any) {
          return (e instanceof TypeError) ? 1 : 2;
        }
      }
    `);
    expect(out).toBe(1);
  });

  it("resolves @@split SpeciesConstructor through a compiled ctor's sidecar (species-ctor-y)", async () => {
    // `rx.constructor = fn; rx.constructor[Symbol.species] = fn2` — the species
    // lives on the closure's sidecar; the property-less closureBridge hid it, so
    // the protocol defaulted to %RegExp% and new RegExp(<opaque proxy>) trapped.
    const out = await runLoose(`
      export function test(): string {
        var flagsArg: any = "unset";
        var re: any = {};
        re.constructor = function() {};
        re.constructor[Symbol.species] = function(_: any, flags: any) {
          flagsArg = flags;
          return /./y;
        };
        re.flags = '';
        (RegExp.prototype as any)[Symbol.split].call(re, '');
        return flagsArg as string;
      }
    `);
    expect(out).toBe("y");
  });

  it("drives a fake-regexp splitter's lastIndex get/set protocol (str-coerce-lastindex)", async () => {
    // The species-constructed splitter is a host object whose lastIndex getter
    // returns `{ valueOf(){ return 2.9 } }` — the accessor bridge must marshal
    // the data-struct return so native ToLength reaches valueOf.
    const out = await runLoose(`
      export function test(): string {
        var obj: any = { constructor: function() {} };
        var fakeRe: any = {
          set lastIndex(_: any) {},
          get lastIndex(): any {
            return { valueOf: function(): number { return 2.9; } };
          },
          exec: function(): any { return []; }
        };
        obj.constructor[Symbol.species] = function() { return fakeRe; };
        var result: any = (RegExp.prototype as any)[Symbol.split].call(obj, 'abcd');
        return (result.length as number) + "|" + (result[0] as string) + "|" + (result[1] as string);
      }
    `);
    expect(out).toBe("2||cd");
  });

  it("stored accessor getter observes OUTER writes after literal creation", async () => {
    // `var v; ({ get x() { return v } }); v = ...` — the getter must read the
    // updated value, not the creation-time snapshot (str-coerce-lastindex-err's
    // badLastIndex reassignment). Fixed by rebinding the outer local to the
    // shared ref cell (boxedCaptures write-through).
    const out = await runLoose(`
      export function test(): string {
        var v: any;
        var o = {
          get x(): any { return v; }
        };
        const before = (o as any).x;
        v = 42;
        const after = (o as any).x;
        return (before === undefined ? "u" : "x") + "|" + (after as number);
      }
    `);
    expect(out).toBe("u|42");
  });

  it("plain-object mirror converts via inherited Object.prototype.toString", async () => {
    // §7.1.1.1: an ordinary object without own toString/valueOf converts via
    // the INHERITED Object.prototype.toString — the @@split default-ctor path
    // (`new RegExp(<rx mirror>, flags)`) must not throw (species-ctor-ctor-non-obj
    // guard call).
    const out = await runLoose(`
      export function test(): string {
        var obj = { flags: '' };
        var r: any = (RegExp.prototype as any)[Symbol.split].call(obj);
        return "len=" + (r.length as number) + "|" + (r[0] as string) + "|" + (r[1] as string) + "|" + (r[2] as string);
      }
    `);
    // Matches native V8: ToString(rx mirror) = "[object Object]" →
    // new RegExp("[object Object]", "y") splits "undefined" → ["und","fin","d"].
    expect(out).toBe("len=3|und|fin|d");
  });
});
