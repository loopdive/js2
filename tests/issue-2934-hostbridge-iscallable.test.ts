// #2934 host-bridge Work Items A + C (spec in the issue's Implementation Plan):
//
//   A. `isKnownNonCallable` (array-methods.ts) now recognises a plain OBJECT
//      type with no call/construct signatures (`arr.map(new Object())`), so
//      `emitCallbackTypeCheck` throws the §23.1.3.18 step-3 TypeError at the
//      right time instead of falling to the host callback bridge — which
//      leaked `env::__call_1_f64` into standalone AND mis-typed the element
//      arg ("call[1] expected f64, found array.get of externref", the
//      `__closure_2` cluster, map/15.4.4.19-4-7).
//   B. (deferred — standalone-native dynamic dispatch, see the issue spec.)
//   C. `bridgeElemConvertInstrs`: the bridge element conversion now handles
//      BOXED-ANY (externref) elements (unbox via `__unbox_number` → ToNumber)
//      and packed i8/i16 (widened i32 → convert), not just i32
//      (filter/create-species-poisoned.js `__closure_4` cluster).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262 = process.env.TEST262_ROOT ?? join(REPO_ROOT, "test262");

const FIXED = [
  "test/built-ins/Array/prototype/map/15.4.4.19-4-7.js",
  "test/built-ins/Array/prototype/filter/create-species-poisoned.js",
  "test/built-ins/Array/prototype/map/create-species-poisoned.js",
];

async function compileStandalone(source: string) {
  return compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
}

describe("#2934 host-bridge A+C — non-callable callback + boxed-any bridge elems", () => {
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

  it("map(new Object()) throws TypeError before iterating (§23.1.3.18 step 3)", async () => {
    const r = await compileStandalone(`
      export function test(): number {
        var arr = new Array(10);
        try {
          arr.map(new Object());
          return 0;
        } catch (e) {
          return ("" + e).indexOf("TypeError") >= 0 ? 1 : 2;
        }
      }
    `);
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("normal function callbacks are untouched (map/filter/reduce)", async () => {
    const r = await compileStandalone(`
      export function test(): number {
        const a = [1, 2, 3, 4];
        const m = a.map(function (x) { return x * 2; });
        const f = a.filter(function (x) { return x % 2 === 0; });
        const s = a.reduce(function (acc, x) { return acc + x; }, 0);
        return m[3] + f.length + s;
      }
    `);
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(8 + 2 + 10);
  });
});
