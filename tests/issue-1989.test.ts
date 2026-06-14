// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1989 — ToPrimitive valueOf/toString dispatch must be PER-INSTANCE.
 *
 * Two object literals that share a Wasm struct SHAPE (e.g.
 * `{ valueOf() { return 7; } }` and `{ valueOf() { return 100; } }`) dedup to
 * one anonymous struct type. Before this fix, every same-shape literal's method
 * was compiled to a single name-keyed standalone function `${typeName}_valueOf`,
 * so the LAST-compiled literal's method body won for ALL coercions:
 *
 *   const a: any = { valueOf() { return 7; } };
 *   const b: any = { valueOf() { return 100; } };
 *   String(a + 1) + "," + String(b + 1)
 *   // wasm (buggy): "101,101"   node: "8,101"
 *
 * Three stacked defects had to be addressed (see the issue file):
 *   (D1) same-shape literals collapsed onto one method func — fixed by forking a
 *        per-literal method func for 2nd+ same-shape ToPrimitive-method literals
 *        and storing each literal's OWN funcref in its struct field
 *        (literals.ts, `toPrimitiveForkedStructs`).
 *   (D2) the headline `a + 1` (an `any`/externref operand) routes to the host
 *        `__host_add` which ran native JS `a + b` — V8 cannot reach a WasmGC
 *        struct's compiled valueOf. Fixed by running `_toPrimitiveSync` on
 *        un-proxied struct operands inside `host_add` (runtime.ts), which
 *        dispatches the per-instance compiled method in-module.
 *   (D3) the host `__call_valueOf`/`__call_toString` ToPrimitive exports + the
 *        in-module eqref dispatch read the per-instance struct field (not the
 *        name-keyed func) for forked structs (index.ts, type-coercion.ts).
 *
 * The §7.1.1.1 step-6 TypeError walk (both valueOf+toString return objects) is
 * preserved: single-literal structs stay on the well-tested name-keyed standalone
 * path; only the genuine same-shape collision opts into per-instance dispatch.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1989 — per-instance valueOf/toString dispatch", () => {
  it("method-shorthand: same-shape valueOf literals coerce per-instance (the repro)", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { valueOf() { return 7; } };
          const b: any = { valueOf() { return 100; } };
          return String(a + 1) + "," + String(b + 1);
        }
      `),
    ).toBe("8,101");
  });

  it("arrow-property: same-shape valueOf literals coerce per-instance", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { valueOf: () => 7 };
          const b: any = { valueOf: () => 100 };
          return String(a + 1) + "," + String(b + 1);
        }
      `),
    ).toBe("8,101");
  });

  it("function-expression property: same-shape valueOf literals coerce per-instance", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { valueOf: function () { return 7; } };
          const b: any = { valueOf: function () { return 100; } };
          return String(a + 1) + "," + String(b + 1);
        }
      `),
    ).toBe("8,101");
  });

  it("cross-method variant: valueOf and toString objects each pick their own method", async () => {
    // a/b carry valueOf (number hint via `+`); c carries toString (String()).
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { valueOf() { return 2; } };
          const b: any = { valueOf() { return 100; } };
          const c: any = { toString() { return "T"; } };
          return String(a + 1) + "," + String(b + 1) + "," + String(c);
        }
      `),
    ).toBe("3,101,T");
  });

  it("mixed-hint: one object's string vs number hint pick the right method", async () => {
    // `${a}` is a string hint → toString → "S"; `a + 0` is number hint → valueOf → 5.
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { valueOf() { return 5; }, toString() { return "S"; } };
          return \`\${a}\` + "," + String(a + 0);
        }
      `),
    ).toBe("S,5");
  });

  it("three same-shape valueOf objects all coerce via their own method", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { valueOf() { return 1; } };
          const b: any = { valueOf() { return 2; } };
          const c: any = { valueOf() { return 3; } };
          return String(a + 0) + String(b + 0) + String(c + 0);
        }
      `),
    ).toBe("123");
  });

  it("two same-shape toString objects stringify per-instance", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const a: any = { toString() { return "A"; } };
          const b: any = { toString() { return "B"; } };
          return String(a) + "," + String(b);
        }
      `),
    ).toBe("A,B");
  });

  it("preserves §7.1.1.1 step-6 TypeError when both valueOf and toString return objects", async () => {
    // Single literal: stays on the name-keyed standalone ToPrimitive walk, which
    // throws TypeError when neither method yields a primitive.
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
});
