// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1525 — ToPrimitive must walk valueOf()/toString() before throwing.
 *
 * Per ECMA-262 §7.1.1 ToPrimitive / §7.1.1.1 OrdinaryToPrimitive:
 *   1. If input has [Symbol.toPrimitive], call it with the hint.
 *   2. Otherwise, for hint "number"/"default": try valueOf() then toString().
 *      For hint "string": try toString() then valueOf().
 *   3. Only throw TypeError if BOTH (or all three) return non-primitives.
 *
 * Two compiler bugs blocked spec compliance and produced 170 test262
 * failures with "Cannot convert object to primitive value":
 *
 *   1. `coerceType` for `ref → externref` eagerly invoked
 *      `${ClassName}_toString` (and `${ClassName}_@@toPrimitive`) whenever
 *      a matching method existed — even with no ToPrimitive hint and no
 *      string context. So `const obj: any = { toString(){...} }` stored
 *      the toString result into `obj`, making `typeof obj === "object"`
 *      evaluate to `"string"` and breaking downstream `obj + n`,
 *      `obj != 0`, and any host method that runs its own ToPrimitive on
 *      the wasmGC arg.
 *
 *      Fix: gate the eager `@@toPrimitive` / `toString` calls on
 *      `toPrimitiveHint !== undefined`. The plain "store as externref"
 *      path stays `extern.convert_any`, preserving struct identity.
 *
 *   2. `__extern_method_call`'s DataView native-dispatch fallback called
 *      `nativeFn.apply(realDv, args)` with the raw arg array. wasmGC
 *      struct args were not wrapped in the live-mirror Proxy, so V8's
 *      internal `ToIndex(byteOffset)` couldn't see `valueOf`/`toString`
 *      and threw before our spec-conformant ToPrimitive ever ran.
 *
 *      Fix: pass `wrappedArgs` (the proxy-wrapped variant built earlier
 *      in the same function) to the native DataView method.
 *
 * Sibling fixes:
 *   - #1090 — Symbol.toPrimitive dispatch through wasmGC closures.
 *   - #1253 — OrdinaryToPrimitive returning undefined instead of throwing.
 *   - #1319 — wasmGC structs without valueOf/toString → "[object Object]".
 *   - #1416 — host ToPrimitive for sidecar @@toPrimitive.
 *   - #1434 — ToNumber / ToNumeric Symbol/BigInt TypeError propagation.
 *
 * Test262 cases this targets:
 *   language/expressions/does-not-equals/S11.9.2_A4.1_T1.js
 *   built-ins/Array/prototype/indexOf/15.4.4.14-10-1.js
 *   built-ins/Array/prototype/reduce/15.4.4.21-9-c-ii-2.js
 *   built-ins/Boolean/prototype/toString/S15.6.4.2_A1_T2.js
 *   built-ins/DataView/prototype/setInt8/toindex-byteoffset.js
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1525 — ToPrimitive walks valueOf/toString before throwing", () => {
  it("object with valueOf() used in arithmetic returns the primitive", async () => {
    // §7.1.1.1 OrdinaryToPrimitive(obj, "number"): valueOf → 42 → 42 + 1 = 43.
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = { valueOf() { return 42; } };
          return obj + 1;
        }
      `),
    ).toBe(43);
  });

  it("object with toString() concatenated with a string returns the primitive", async () => {
    // ToPrimitive(obj, "default") tries valueOf (none) → toString → "hi".
    // Then "hi" + "!" → "hi!".
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = { toString() { return "hi"; } };
          return obj + "!";
        }
      `),
    ).toBe("hi!");
  });

  it("hint number prefers valueOf over toString", async () => {
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = {
            valueOf() { return 100; },
            toString() { return "X"; },
          };
          return obj + 1;
        }
      `),
    ).toBe(101);
  });

  it("object literal stored as any preserves struct identity (typeof === 'object')", async () => {
    // #1525 root cause: prior codegen path called `${name}_toString` eagerly
    // on ref→externref coercion, turning a struct literal into its toString
    // result the moment it was stored. After the fix the struct keeps its
    // identity until the user explicitly triggers ToPrimitive.
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = { toString() { return "Y"; } };
          return typeof obj;
        }
      `),
    ).toBe("object");
  });

  it("object literal with both valueOf and toString keeps struct identity when stored as any", async () => {
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = {
            valueOf() { return 100; },
            toString() { return "Y"; },
          };
          return typeof obj;
        }
      `),
    ).toBe("object");
  });

  it("loose equality coerces object via valueOf (obj != 0 reads valueOf)", async () => {
    // language/expressions/does-not-equals/S11.9.2_A4.1_T1.js shape:
    // `(obj != 0)` runs ToPrimitive on obj → valueOf → 0 → 0 == 0 → not !=.
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = { valueOf() { return 0; } };
          return obj != 0 ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  it("DataView.setInt8 honours wasmGC valueOf on byteOffset", async () => {
    // built-ins/DataView/prototype/setInt8/toindex-byteoffset.js shape:
    // the byteOffset argument is an object whose `valueOf` provides the
    // integer index. V8's native ToIndex(byteOffset) must dispatch through
    // the wasmGC closure via the proxy wrapper applied to __extern_method_call
    // args; otherwise it throws "Cannot convert object to primitive value".
    expect(
      await runWasm(`
        export function test(): any {
          const buf = new ArrayBuffer(8);
          const dv = new DataView(buf);
          const off: any = { valueOf() { return 2; } };
          dv.setInt8(off, 42);
          return dv.getInt8(2);
        }
      `),
    ).toBe(42);
  });

  it("DataView.getInt8 honours wasmGC valueOf on byteOffset", async () => {
    expect(
      await runWasm(`
        export function test(): any {
          const buf = new ArrayBuffer(8);
          const dv = new DataView(buf);
          dv.setInt8(3, 99);
          const off: any = { valueOf() { return 3; } };
          return dv.getInt8(off);
        }
      `),
    ).toBe(99);
  });

  it("TypeError when both valueOf and toString return objects", async () => {
    // §7.1.1.1 step 6 — TypeError propagates to Wasm catch_all.
    // Pre-#1525 the eager `extern.convert_any` + later `__unbox_number`
    // silently bottomed out at "[object Object]" → NaN; per spec the
    // TypeError must surface so user `try/catch` observes it (#1253).
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = {
            valueOf() { return ({} as any); },
            toString() { return ({} as any); },
          };
          try { return obj + 1; } catch (e) { return "TYPEERR"; }
        }
      `),
    ).toBe("TYPEERR");
  });

  it("explicit String(obj) calls toString even with valueOf present", async () => {
    // String(obj) is an explicit ToPrimitive("string") site — toString wins
    // over valueOf for hint "string" per §7.1.1.1.
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = {
            valueOf() { return 100; },
            toString() { return "stringified"; },
          };
          return String(obj);
        }
      `),
    ).toBe("stringified");
  });
});
