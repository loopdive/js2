import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #4082 — the #3992 transferred-native-proto dispatch arm in
// `__call_fn_method_N` copied the generic arm's `call_ref` but NOT its result
// boxing, so a borrowed native-prototype method returning a non-reference blew
// up Wasm validation:
//
//     __call_fn_method_0 failed:
//       local.set[0] expected type externref, found call_ref of type i32
//
// `RegExp.prototype.test` returns i32 (boolean). The arm sank the raw i32 into
// the externref `resultSaveLocal`, the module never instantiated, and the file
// lost 100% of its assertions.
//
// The missing half was asserted in a COMMENT rather than in code — the
// function's own doc said "each arm pushes exactly one externref (the
// `call_ref` result)", which is true only for reference-returning closures. An
// invariant that exists only as prose is not an invariant.
//
// Fix: `buildClosureResultBoxing` in `closure-exports.ts` owns the
// call_ref-result → externref decision for every arm of this ABI; the
// transferred-native-proto arm receives it as `boxResult`.

async function compileStandalone(source: string) {
  const result = await compile(source, {
    allowJs: true,
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  if (!result.success || result.errors.some((e) => e.severity === "error")) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  return result.binary;
}

async function probe(binary: Uint8Array, name: string): Promise<unknown> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  const exports = instance.exports as Record<string, CallableFunction>;
  exports.__module_init?.();
  return exports[name]!();
}

describe("#4082 — borrowed native-proto methods box their call_ref result", () => {
  // The reduced form of test262 S15.10.6.3_A2_T1. Before the fix
  // `WebAssembly.validate` was false and the module never instantiated.
  it("a borrowed i32-returning proto method produces a VALID module", async () => {
    const binary = await compileStandalone(`
var inst = new Object();
inst.test = RegExp.prototype.test;
try { inst.test("message"); } catch (e) { }
`);
    expect(WebAssembly.validate(binary)).toBe(true);
    await expect(WebAssembly.instantiate(binary, {})).resolves.toBeDefined();
  });

  // Validation is not correctness. This is what the 9 flipped test262 files
  // actually assert: calling a borrowed `RegExp.prototype.test` on a receiver
  // that is not a RegExp must throw a *TypeError*. Verified by value — the
  // probe returns 2 only when a genuine TypeError was caught.
  it("throws a real TypeError on a non-RegExp receiver (value check)", async () => {
    const binary = await compileStandalone(`
var inst = new Object();
inst.test = RegExp.prototype.test;
var caught = 0;
try {
  inst.test("message");
  caught = 1;            // returned instead of throwing
} catch (e) {
  caught = e instanceof TypeError ? 2 : 3;
}
export function probeCaught(): number { return caught; }
`);
    expect(await probe(binary, "probeCaught")).toBe(2);
  });

  // Reference-returning borrowed methods took the previously-correct path.
  // Pin them so re-pointing the two generic arms at the shared helper cannot
  // regress the case that already worked.
  it("a borrowed reference-returning proto method still validates", async () => {
    const binary = await compileStandalone(`
var box = new String("hello");
box.grab = String.prototype.charAt;
try { box.grab(1); } catch (e) { }
`);
    expect(WebAssembly.validate(binary)).toBe(true);
    await expect(WebAssembly.instantiate(binary, {})).resolves.toBeDefined();
  });

  // KNOWN RESIDUAL — tracked as #4083, deliberately NOT asserted as correct.
  //
  // When the borrowed method runs on a receiver its arm's exact-identity guard
  // does not match, the outer dispatch falls through to `ref.null.extern` and
  // the call answers `null` instead of the boolean. That is the #3992 coverage
  // gap this fix makes *observable* (base crashed before reaching it), not a
  // regression — measured on `var re = /a/; re.borrowed = RegExp.prototype.test`.
  //
  // Asserting the wrong value here would pin the bug and manufacture exactly
  // the vacuous pass the residual is about, so this test records only that the
  // module is well-formed. #4083 upgrades it to `=== true` / `=== false`.
  it("a borrowed method on a regex literal receiver at least validates", async () => {
    const binary = await compileStandalone(`
var re = /a/;
re.borrowed = RegExp.prototype.test;
var hit = re.borrowed("banana");
`);
    expect(WebAssembly.validate(binary)).toBe(true);
  });
});
