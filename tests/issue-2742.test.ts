/**
 * Tests for #2742 group (d): builtin function `.length` must be a non-enumerable
 * own data property per ES §17.
 *
 * Group (a)/(b)/(c) (generic-receiver ToString coercion) are out-of-scope for
 * this PR — they are substrate-gated. Only group (d) is implemented here.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as any)[fn](...args);
}

describe("#2742 group (d): builtin function .length is non-enumerable", () => {
  it("String.prototype.charAt.hasOwnProperty('length') returns true", async () => {
    const src = `
      export function test(): number {
        return String.prototype.charAt.hasOwnProperty('length') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("String.prototype.charAt.propertyIsEnumerable('length') returns false (DontEnum)", async () => {
    const src = `
      export function test(): number {
        return String.prototype.charAt.propertyIsEnumerable('length') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("String.prototype.charCodeAt.propertyIsEnumerable('length') returns false", async () => {
    const src = `
      export function test(): number {
        return String.prototype.charCodeAt.propertyIsEnumerable('length') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("String.prototype.indexOf.propertyIsEnumerable('length') returns false", async () => {
    const src = `
      export function test(): number {
        return String.prototype.indexOf.propertyIsEnumerable('length') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("String.prototype.substring.propertyIsEnumerable('length') returns false", async () => {
    const src = `
      export function test(): number {
        return String.prototype.substring.propertyIsEnumerable('length') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("for-in on String.prototype.charAt does not enumerate 'length'", async () => {
    const src = `
      export function test(): number {
        var count = 0;
        for (var p in String.prototype.charAt) {
          if (p === 'length') count++;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("user-defined function own property is still enumerable when added dynamically", async () => {
    // Regression guard: regular own properties on Wasm structs must remain enumerable.
    const src = `
      export function test(): number {
        var obj: any = {};
        obj.x = 42;
        return obj.propertyIsEnumerable('x') ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #2742 group (c) — an accessor GETTER whose return value is a compiled closure
// must reach the host as a CALLABLE.
//
// `get valueOf() { return function () { … }; }` lowers the inner function to a
// WasmGC closure struct. The getter itself was already bridged (V8 can invoke
// it), but its RETURN value crossed back raw, so V8 observed
// `typeof o.valueOf === "object"` — i.e. NOT callable. In OrdinaryToPrimitive
// (§7.1.1.1 step 5.b `IsCallable(method)`) a non-callable method is silently
// SKIPPED; with `toString` also non-callable the algorithm reaches step 6 and
// throws "Cannot convert object to primitive value". That is the mechanism
// behind the `String.prototype.trim{Start,End}` this-value method-priority
// failures.
//
// The fix marshals the accessor return through `_maybeWrapCallableUnknownArity`
// (which converts only values `__is_closure` positively identifies, leaving
// everything else untouched). It is deliberately NOT a generic call-exit
// marshal — that was tried and reverted for regressing ~85 dstr files
// (#3123/#2835).
//
// Every expectation below was verified against plain V8 (node) FIRST. The
// `valueOf`-only case in particular does NOT yield the valueOf string: hint
// "string" consults the inherited `Object.prototype.toString` first.
// ---------------------------------------------------------------------------
describe("#2742 group (c): accessor getter returning a compiled closure", () => {
  // THE regression — red on the merge base with
  // "Cannot convert object to primitive value".
  it("bridges a getter-returned closure so ToPrimitive can call valueOf", async () => {
    const src = `
      const o: any = {
        get toString(): any { return undefined; },
        get valueOf(): any { return function () { return "  xy  "; }; }
      };
      export function test(): number {
        return (String.prototype.trim as any).call(o) === "xy" ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  // Asserts the LOWERING, not merely the absence of a throw: the getter-returned
  // value must itself be `typeof === "function"` on the host side.
  it("presents the getter-returned closure as typeof 'function'", async () => {
    const src = `
      const o: any = { get valueOf(): any { return function () { return 7; }; } };
      export function test(): number { return typeof o.valueOf === "function" ? 1 : 0; }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  // OrdinaryToPrimitive must consult BOTH accessors, in spec order, exactly once
  // each. Encoded (100*toString + 10*valueOf + value) so a partial fix that
  // returns the right string without reading the accessors cannot pass.
  it("accesses toString then valueOf exactly once each (V8 parity: 111)", async () => {
    const src = `
      let toStringAccessed = 0;
      let valueOfAccessed = 0;
      const thisVal: any = {
        get toString(): any { toStringAccessed += 1; return undefined; },
        get valueOf(): any { valueOfAccessed += 1; return function () { return "  xy  "; }; }
      };
      export function test(): number {
        const r = (String.prototype.trim as any).call(thisVal);
        return 100 * toStringAccessed + 10 * valueOfAccessed + (r === "xy" ? 1 : 0);
      }
    `;
    expect(await run(src, "test")).toBe(111);
  });

  // Narrowness guard: a getter returning a NON-callable must STAY non-callable
  // (the marshal must not turn data into a function), and hint "string" must
  // still prefer the inherited Object.prototype.toString.
  it("leaves a non-closure getter return untouched", async () => {
    const src = `
      const o: any = { get valueOf(): any { return "  xy  "; } };
      export function test(): number {
        const notCallable = typeof o.valueOf !== "function";
        const trimmed = (String.prototype.trim as any).call(o) === "[object Object]";
        return notCallable && trimmed ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  // Pre-existing correct behaviour must not regress.
  it("keeps plain toString and the data-property undefined fallback working", async () => {
    const src = `
      const withToString: any = { toString: function () { return "  xy  "; } };
      const dataUndef: any = { toString: undefined, valueOf: function () { return "  xy  "; } };
      export function test(): number {
        const a = (String.prototype.trim as any).call(withToString) === "xy";
        const b = (String.prototype.trim as any).call(dataUndef) === "xy";
        return a && b ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("preserves getter identity and permits SameValue redefinition", async () => {
    const src = `
      const getter = function (): any {
        return function (): number { return 7; };
      };
      const o: any = {};
      Object.defineProperty(o, "value", {
        get: getter,
        configurable: false
      });
      export function test(): number {
        const identity = Object.getOwnPropertyDescriptor(o, "value").get === getter;
        let redefined = false;
        try {
          Object.defineProperty(o, "value", { get: getter });
          redefined = true;
        } catch (_err) {
          redefined = false;
        }
        return identity && redefined && o.value() === 7 ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("bridges an accessor-returned arity-1 function used as a descriptor setter", async () => {
    const src = `
      export function test(): number {
        let observed = "";
        const attributes: any = {};
        Object.defineProperty(attributes, "set", {
          get: function (): any {
            return function (value: any): void {
              observed = value;
            };
          }
        });
        const o: any = {};
        Object.defineProperty(o, "value", attributes);
        o.value = "ok";
        return observed === "ok" ? 1 : 0;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("does not turn unsupported accessor-returned rest closures into a Wasm trap", async () => {
    const src = `
      const target: any = {};
      Object.defineProperty(target, "x", {
        value: 1,
        enumerable: true,
        configurable: true
      });
      const handler: any = {
        get ownKeys(): any {
          return (..._args: any[]): any => ["x"];
        },
        get getOwnPropertyDescriptor(): any {
          return (..._args: any[]): any => ({
            value: 1,
            enumerable: true,
            configurable: true
          });
        }
      };
      export function test(): number {
        return Object.keys(new Proxy(target, handler)).length;
      }
    `;
    await expect(run(src, "test")).rejects.toThrow(/not a function/);
  });
});
