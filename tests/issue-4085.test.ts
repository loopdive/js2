/**
 * #4085 — `JSON.stringify` emitted the literal `null` for ordinary arrays in
 * standalone.
 *
 * `json-codec-native.ts`'s value dispatch ref-tests `$Object`, `$ObjVec`,
 * `$AnyString`, the boxed primitives and `$AnyValue`. A real standalone JS array
 * is a `__vec_<elemKind>` struct subtyping `$__vec_base` (#2186), and `$ObjVec`
 * is the enumeration-RESULT vector — a DIFFERENT type. So an ordinary array
 * matched no arm, fell through to "unsupported ref ⇒ undefined serialisation",
 * and the root arm rendered the JSON literal `null`:
 *
 *   JSON.stringify([10, 20, 30])   // was "null", spec says "[10,20,30]"
 *
 * That is silently CORRUPT OUTPUT for ordinary user code — no compile error, no
 * host-import leak, nothing downstream can detect it. Only an EMPTY array and a
 * LITERAL plain object serialised correctly, i.e. exactly the two shapes a smoke
 * test is most likely to try.
 *
 * Fix: normalise a `$__vec_base` receiver into a `$ObjVec` (elements read via
 * `__extern_get_idx`, already vec-aware since #2190) and reuse the EXISTING
 * array arm, instead of duplicating its element/replacer/indent logic.
 *
 * Results are compared IN-WASM against the spec-correct literal so no native
 * string crosses the boundary.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile standalone, assert ZERO env imports, instantiate import-free, run test(). */
async function runHostFree(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) return undefined;
  const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(envImports, `unexpected env imports: ${envImports.join(",")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, unknown> & { test?: () => unknown; _start?: () => void };
  exports._start?.();
  return exports.test?.();
}

/** 1 iff `JSON.stringify(<carrier>)` equals `want` exactly, compared in-Wasm. */
async function stringifiesTo(carrier: string, want: string): Promise<unknown> {
  return runHostFree(
    `export function test(): number {
       ${carrier}
       const s: any = JSON.stringify(v);
       return s === ${JSON.stringify(want)} ? 1 : 0;
     }`,
  );
}

describe("#4085 standalone JSON.stringify over vec carriers", () => {
  it("serialises a number array", async () => {
    expect(await stringifiesTo(`const v: any = [10,20,30];`, `[10,20,30]`)).toBe(1);
  });

  it("serialises a string array (elements quoted)", async () => {
    expect(await stringifiesTo(`const v: any = ["a","b"];`, `["a","b"]`)).toBe(1);
  });

  it("serialises nested arrays (recursion re-enters the vec arm)", async () => {
    expect(await stringifiesTo(`const v: any = [[1],[2]];`, `[[1],[2]]`)).toBe(1);
  });

  it("serialises an array held by an object (recursion from the object arm)", async () => {
    expect(await stringifiesTo(`const v: any = {a:[1,2]};`, `{"a":[1,2]}`)).toBe(1);
  });

  it("serialises a boolean/null mix", async () => {
    expect(await stringifiesTo(`const v: any = [true,false,null];`, `[true,false,null]`)).toBe(1);
  });

  it("empty array still serialises (no regression)", async () => {
    // One of only two shapes that worked before the fix — guard it explicitly.
    expect(await stringifiesTo(`const v: any = [];`, `[]`)).toBe(1);
  });

  it("literal plain object still serialises (no regression)", async () => {
    // The other pre-fix working shape.
    expect(await stringifiesTo(`const v: any = {a:1,b:2};`, `{"a":1,"b":2}`)).toBe(1);
  });

  it("a nested empty array is not confused with the null render", async () => {
    // `[[]]` vs the old failure mode `null` / `[null]` — distinguishes "fixed"
    // from "still rendering the undefined-serialisation sentinel".
    expect(await stringifiesTo(`const v: any = [[]];`, `[[]]`)).toBe(1);
  });
});
