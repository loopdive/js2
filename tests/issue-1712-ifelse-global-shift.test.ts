// #1712 (acorn dogfood) — compileIfStatement orphaned the completed
// then-branch buffer while compiling the else branch: the raw
// `fctx.body = []` swap left `thenInstrs` reachable only through a local
// variable, invisible to fixupModuleGlobalIndices. A string constant first
// registered inside the else branch (e.g. a property null-throw TypeError
// message — NOT a source literal, which the module pre-scan would have
// collected) inserts a late `string_constants` import global and shifts every
// module-global index by one, while the then-branch's already-emitted
// `global.get`s stay stale.
//
// Symptom (acorn 8.16.0, __closure_86): `FUNC_STATEMENT | FUNC_NULLABLE_ID`
// read the neighbouring globals — one of them a (ref null $array) — and
// produced invalid Wasm: `f64.trunc[0] expected type f64, found global.get of
// type (ref null 1)`.
//
// The fix parks thenInstrs in fctx.savedBodies for the else window (walked by
// every late-import shifter) and adds the missing ctx.liveBodies walk to
// fixupModuleGlobalIndices (parity with addStringImports/addUnionImports,
// #1384/#779d).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1712 — then-branch module-global reads survive a late string-import shift from the else branch", () => {
  it("module-global bitwise-or in the then branch still validates and computes after an else-branch null-throw string registers late", async () => {
    const src = `
      var FLAG_A = 1, FLAG_B = 2, FLAG_C = 4;

      export function pick(x: number, obj: any): number {
        if (x > 0) {
          return FLAG_A | FLAG_C;
        } else {
          // Property access on \`any\` emits a null-throw TypeError message
          // string unique to this property name — first registered HERE,
          // inside the else branch, triggering the late global-index shift
          // while thenInstrs is detached.
          return obj.uniquePropNameZq77 + 0;
        }
      }
    `;
    const r = await compile(src, { fileName: "issue-1712.ts" });
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    // Pre-fix this threw: "f64.trunc[0] expected type f64, found global.get of type externref"
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
    const importObject = (r as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(r.binary, importObject);
    const pick = instance.exports.pick as (x: number, obj: unknown) => number;
    expect(pick(1, null)).toBe(5); // FLAG_A | FLAG_C = 1 | 4
  });
});
