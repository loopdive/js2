// #2875 Slice A — reflective `String.prototype.<m>.call(<non-string primitive>)`
// ToString(this) fidelity on the standalone lane. Two root causes fixed:
//
// 1. `ensureAnyToStringHelper` box-struct ordering hazard: `__any_to_string`'s
//    boxed-primitive recovery arm reads `ctx.nativeBox{Number,Boolean}TypeIdx`
//    but never ensured them. When a 0-arg reflective glue (the trim family,
//    which — unlike char/search bodies — never calls `unboxArgToI32`) was the
//    FIRST `__any_to_string` consumer, both idxs were -1 and the arm baked (and
//    module-cached) the "[object Object]" fallback, so `trim.call(false)` gave
//    "[object Object]" instead of "false". Fixed by ensuring the union native
//    funcs (which register the box structs) up front, mirroring #3216.
// 2. `emitStringTrimMemberBody` missing the `__str_flatten` the DIRECT path
//    (`string-ops.ts`) performs before `__str_trim*`.
//
// These fix boolean/number receiver ToString across ALL reflective String
// methods, and the trim family end-to-end.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile standalone, assert host-free, instantiate, run `test()` (returns i32). */
async function runI32(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2875 Slice A — reflective String proto non-string ToString (standalone)", () => {
  describe("trim family: non-string primitive receivers stringify correctly", () => {
    for (const m of ["trim", "trimStart", "trimEnd"] as const) {
      it(`${m}.call(false) === "false" (was "[object Object]")`, async () => {
        expect(await runI32(`return (String.prototype.${m}.call(false as any) as string) === "false" ? 1 : 0;`)).toBe(
          1,
        );
      });
      it(`${m}.call(123) === "123"`, async () => {
        expect(await runI32(`return (String.prototype.${m}.call(123 as any) as string) === "123" ? 1 : 0;`)).toBe(1);
      });
    }

    it("trim.call trims a non-string primitive that stringifies with padding: (' x ' via string) — string receiver still trims", async () => {
      expect(await runI32(`return (String.prototype.trim.call("  hi  ") as string) === "hi" ? 1 : 0;`)).toBe(1);
    });

    it("trim.call(true) === 'true'", async () => {
      expect(await runI32(`return (String.prototype.trim.call(true as any) as string) === "true" ? 1 : 0;`)).toBe(1);
    });

    it("trim.call(+Infinity) === 'Infinity' (the corpus 15.5.4.20-2-10 shape)", async () => {
      expect(
        await runI32(`return (String.prototype.trim.call(Infinity as any) as string) === "Infinity" ? 1 : 0;`),
      ).toBe(1);
    });
  });

  describe("box-struct ordering: trim glue as FIRST any-to-string consumer", () => {
    it("trim.call(false) is correct ALONE (no prior number-method call to register the box structs)", async () => {
      // Regression guard for the ordering hazard: the fix must make this work
      // WITHOUT any preceding char/search glue that would pull in the union funcs.
      expect(await runI32(`return (String.prototype.trim.call(false as any) as string).length;`)).toBe(5);
    });

    it("charAt still stringifies non-string primitives correctly (unchanged)", async () => {
      expect(await runI32(`return (String.prototype.charAt.call(false as any, 0) as string) === "f" ? 1 : 0;`)).toBe(1);
    });
  });

  describe("no regression: string receivers and null RequireObjectCoercible", () => {
    it("trim.call(null) throws TypeError (null IS ref.null)", async () => {
      expect(
        await runI32(
          `try { String.prototype.trim.call(null as any); return 0; } catch (e) { return e instanceof TypeError ? 2 : 1; }`,
        ),
      ).toBe(2);
    });

    it("direct '  x  '.trim() === 'x'", async () => {
      expect(await runI32(`return "  x  ".trim() === "x" ? 1 : 0;`)).toBe(1);
    });
  });
});
