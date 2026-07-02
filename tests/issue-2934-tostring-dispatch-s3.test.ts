// #2934 slice 3 — the object-toString string-coercion invalid-Wasm family
// ("not enough arguments on the stack", S15.5.4.6_A4_T2), three mechanisms:
//
//   1. `ensureNativeStringExternBridge` (native-strings.ts) queued its three
//      late imports and baked their indices into the helper bodies WITHOUT
//      closing the deferred batch — the eventual flush bumps every `funcIdx >=
//      importsBefore`, unable to distinguish the freshly-baked (final) import
//      refs from stale defined-func refs, so `__str_to_extern`'s
//      `call __str_from_mem` (arity 2) landed on `__str_copy_tree` (arity 3).
//      This ALSO broke plain `console.log("ab".concat("cd"))` standalone on
//      main once #2473 made the bridge emission reachable for that shape.
//   2. `tryStructToString`'s `normaliseToString` (type-coercion.ts) pushed
//      nothing for a NO-RESULT dispatched method (always-throwing / void
//      toString) then fed `$__any_to_string` — 0 operands for a 1-arg call.
//      Per §7.1.1 OrdinaryToPrimitive that path ends in TypeError; the throw
//      leaves the stack polymorphic, so the arm validates.
//   3. `compileNativeStringMethodCall`'s receiver (string-ops.ts): a
//      reflective `String.prototype.concat.call(obj, …)` receiver compiles to
//      a concrete object struct ref — §22.1.3.x requires ToString(this)
//      (dispatching the object's own toString) before the native helper.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262 = process.env.TEST262_ROOT ?? join(REPO_ROOT, "test262");

async function compileStandalone(source: string) {
  return compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
}

describe("#2934 s3 — object-toString string coercion is valid standalone Wasm", () => {
  it("plain console.log(concat) — the bridge over-shift regression shape", async () => {
    const r = await compileStandalone(`console.log("ab".concat("cd"));`);
    expect(r.success).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });

  it("S15.5.4.6_A4_T2 compiles to valid standalone Wasm", async () => {
    const abs = join(TEST262, "test/built-ins/String/prototype/concat/S15.5.4.6_A4_T2.js");
    if (!existsSync(abs)) return;
    const src = readFileSync(abs, "utf-8");
    const wrapped = wrapTest(src, parseMeta(src)).source;
    const r = await compileStandalone(wrapped);
    expect(r.success).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });

  it("throwing toString in concat arg propagates its exception", async () => {
    const r = await compileStandalone(`
      export function test(): number {
        var o = { toString: function (): never { throw "x"; } };
        try {
          "a".concat(o as any);
          return 0;
        } catch (e) {
          return e === "x" ? 1 : 2;
        }
      }
    `);
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("throwing toString in template/plus-concat contexts stays valid", async () => {
    for (const shape of [
      `var o = { toString: function() { throw "x"; } }; let s = "?"; try { s = "a" + (o as any); } catch (e) { s = String(e); } s;`,
      `var o = { toString: function() { throw "x"; } }; let s = "?"; try { s = \`a\${o as any}\`; } catch (e) { s = String(e); } s;`,
    ]) {
      const r = await compileStandalone(shape);
      expect(r.success).toBe(true);
      await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
    }
  });

  it("reflective concat.call with object receiver dispatches receiver toString", async () => {
    const r = await compileStandalone(`
      export function test(): number {
        var inst = { toString: function (): never { throw "intostring"; } };
        try {
          String.prototype.concat.call(inst as any, "b");
          return 0;
        } catch (e) {
          return e === "intostring" ? 1 : 2;
        }
      }
    `);
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("returning toString still stringifies (no regression)", async () => {
    const r = await compileStandalone(`
      export function test(): number {
        var o = { toString: function () { return "y"; } };
        return "a".concat(o as any) === "ay" ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });
});
