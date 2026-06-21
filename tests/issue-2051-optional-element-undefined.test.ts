// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2051 — a short-circuited optional **element** access (`a?.[i]`) whose static
 * type is a nullable primitive (`number | undefined`) must yield `undefined`,
 * not the element type's default (`0`).
 *
 * The property-access slice (`o?.v`) landed earlier; this is the matching
 * element slice. `compileOptionalElementAccess` lowered the whole `a?.[i]`
 * result to the element's bare value type (f64/i32) and the short-circuit arm
 * fabricated a typed zero — so a nullish base gave `a?.[0] === undefined`
 * false, `typeof a?.[0]` "number", `"" + a?.[0]` "0".
 *
 * Fix (mirrors `compileOptionalPropertyAccess`): when the chain's static result
 * type is a nullable primitive, widen the result to externref; the null arm
 * emits host `undefined` and the non-null arm boxes the element value (the
 * existing `coerceType` at the else-arm tail does `__box_number`). The else arm
 * ends in an `array.get`/`struct.get` (not a `call`), so — unlike the optional-
 * CALL arm (still deferred under #2051) — there is no late-import index-shift
 * hazard.
 *
 * Default (JS-host) mode: relies on host `undefined` (`__get_undefined`),
 * `__typeof`, `__extern_toString`, `__extern_is_undefined` — all already present.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<number | string> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test(): number | string }).test();
}

// Non-null base has element [0] === 0 so the v=0 distinguishing case (a real 0
// must NOT read as undefined) is exercised by the non-nullish tests below.
// The `if (b) return …; return null;` body shape gives `a?.[i]` the reliably
// nullable static type (`number | undefined`) the widening gate keys on —
// matching the issue repro and the landed property-access test. (A ternary
// `b ? [...] : null` body narrows TS's inference of `a?.[0]` to a bare `number`
// in some contexts, which is a pre-existing static-type-inference limit shared
// by the property-access gate, orthogonal to this element slice.)
const NUM = `function getArr(b: boolean): number[] | null { if (b) return [0, 20, 30]; return null; }`;
const STR = `function getStrs(b: boolean): string[] | null { if (b) return ["x", "y"]; return null; }`;

describe("#2051 optional element access yields undefined on short-circuit", () => {
  it("nullish: a?.[0] === undefined", async () => {
    expect(
      await run(`${NUM}\nexport function test(): boolean { const a = getArr(false); return (a?.[0]) === undefined; }`),
    ).toBe(1);
  });

  it("nullish: typeof a?.[0] === 'undefined'", async () => {
    expect(
      await run(
        `${NUM}\nexport function test(): boolean { const a = getArr(false); return typeof (a?.[0]) === "undefined"; }`,
      ),
    ).toBe(1);
  });

  it('nullish: "" + a?.[0] === "undefined"', async () => {
    expect(
      await run(
        `${NUM}\nexport function test(): boolean { const a = getArr(false); return ("" + (a?.[0])) === "undefined"; }`,
      ),
    ).toBe(1);
  });

  it("nullish: a?.[0] ?? 42 === 42", async () => {
    expect(
      await run(`${NUM}\nexport function test(): number { const a = getArr(false); return (a?.[0]) ?? 42; }`),
    ).toBe(42);
  });

  it("non-null: a?.[1] returns the real element (20)", async () => {
    expect(
      await run(
        `${NUM}\nexport function test(): number { const a = getArr(true); const r = a?.[1]; return r === undefined ? -1 : r; }`,
      ),
    ).toBe(20);
  });

  it("non-null distinguishing case: element 0 is NOT undefined", async () => {
    // a?.[0] is a real 0 → `=== undefined` must be false, `"" +` must be "0".
    expect(
      await run(`${NUM}\nexport function test(): boolean { const a = getArr(true); return (a?.[0]) === undefined; }`),
    ).toBe(0);
    expect(
      await run(`${NUM}\nexport function test(): boolean { const a = getArr(true); return ("" + (a?.[0])) === "0"; }`),
    ).toBe(1);
  });

  it("string-element array: nullish typeof is 'undefined', non-null is the value", async () => {
    expect(
      await run(
        `${STR}\nexport function test(): boolean { const a = getStrs(false); return typeof (a?.[0]) === "undefined"; }`,
      ),
    ).toBe(1);
    expect(
      await run(
        `${STR}\nexport function test(): string { const a = getStrs(true); const r = a?.[0]; return r === undefined ? "UNDEF" : r; }`,
      ),
    ).toBe("x");
  });
});
