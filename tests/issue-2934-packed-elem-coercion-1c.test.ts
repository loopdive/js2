// #2934 slice 1c — the `TypedArray.prototype.set` / `Uint8Array.toBase64`
// standalone invalid-Wasm cluster. The original triage suspected a DCE
// type-index remap; instrumentation disproved that (the bad instructions exist
// at DCE-entry, and remapTypeIdxInBody has the #1302/#2564 double-remap
// guards). The real mechanisms were three packed-element coercion gaps:
//
//   1. `coerceType` (type-coercion.ts) normalized packed i8/i16 kinds ONLY for
//      the numeric short-circuit pairs; every other arm tests the raw
//      `from.kind`/`to.kind`, so i8 → externref matched NO arm and fell to the
//      lossy drop+null fallback, and externref → i8 emitted NO unbox — an
//      un-coerced externref reaching a packed `array.set` ("array.set[2]
//      expected i32, found array.get of externref"). Entry now rewrites packed
//      side(s) to the true stack kind (i32) and falls through to the real
//      box/unbox arms.
//   2. `emitVecToVecBody` (type-coercion.ts) read a packed source with plain
//      `array.get` ("Array type N has packed type i8").
//   3. The `new TypedArray(arrayLike)` copy loop (expressions/new-super.ts)
//      had an element-conversion matrix that only knew f64↔int — an externref
//      (any[]) source element flowed raw into the packed `array.set`. It now
//      unboxes (ToNumber) then truncates for integer storage.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262 = process.env.TEST262_ROOT ?? join(REPO_ROOT, "test262");

const FIXED = [
  "test/built-ins/TypedArray/prototype/set/array-arg-value-conversion-resizes-array-buffer.js",
  "test/built-ins/Uint8Array/prototype/toBase64/results.js",
  "test/built-ins/TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-other-type-conversions-sab.js",
];

async function compileStandalone(source: string) {
  return compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
}

describe("#2934 1c — packed-element coercion produces valid standalone Wasm", () => {
  for (const rel of FIXED) {
    const abs = join(TEST262, rel);
    const present = existsSync(abs);
    it.skipIf(!present)(`compiles ${rel} to valid standalone Wasm`, async () => {
      const src = readFileSync(abs, "utf-8");
      const wrapped = wrapTest(src, parseMeta(src)).source;
      const r = await compileStandalone(wrapped);
      expect(r.success).toBe(true);
      await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
    });
  }

  const SEMANTIC: Array<{ name: string; src: string; expected: number }> = [
    {
      name: "new Uint8Array([...]) copies literal elements",
      src: "const u = new Uint8Array([102, 111]); return u[0] + u[1];",
      expected: 213,
    },
    {
      name: "new Int8Array([200]) wraps to -56 (width truncation on packed store)",
      src: "const u = new Int8Array([200]); return u[0];",
      expected: -56,
    },
    {
      name: "new Float64Array(uint8Array) widens packed source",
      src: "const u = new Uint8Array([7, 9]); const f = new Float64Array(u); return f[0] + f[1];",
      expected: 16,
    },
    {
      name: "new Uint8Array(int16Array) truncates wide source",
      src: "const s = new Int16Array([300]); const u = new Uint8Array(s); return u[0];",
      expected: 44,
    },
    {
      name: "new Uint8Array(numberArray) truncates fractional values",
      src: "const a = [1.9, 250.2]; const u = new Uint8Array(a); return u[0] + u[1];",
      expected: 251,
    },
  ];

  for (const { name, src, expected } of SEMANTIC) {
    it(name, async () => {
      const r = await compileStandalone(`export function test(): number { ${src} }`);
      expect(r.success).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      expect((instance.exports.test as () => number)()).toBe(expected);
    });
  }
});
