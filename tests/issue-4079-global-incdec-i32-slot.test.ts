import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #4079 — `++`/`--` on a module global whose Wasm slot is **i32** emitted
// `global.get` (i32) straight into `f64.add`, so the module failed validation:
//
//     __module_init failed: f64.add[0] expected type f64,
//                           found global.get of type i32
//
// and never instantiated — the file loses 100% of its assertions.
//
// `var x = false` gives the global an i32 (boolean) slot. The *comparison*
// path already inserted `f64.convert_i32_s` when reading that global; the
// *update* path did not. `unary-updates.ts` had EIGHT hand-rolled copies of
// "read global / compute ±1 / store back" (prefix++ , prefix-- , postfix++ ,
// postfix-- × moduleGlobals, capturedGlobals), each with its own type-case
// list, and every one of them handled `externref` and `ref`/`ref_null` and
// forgot `i32`.
//
// A correct implementation already existed a few hundred lines up in the same
// file: `compileStaticPropIncDec` (#2019) converts i32→f64 on read and
// f64→i32 on store. It was only wired to static-property globals. The fix
// generalises it to `compileGlobalIncDec` and routes all eight fallbacks
// through it, so there is one type-case list instead of eight.

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

async function runInit(binary: Uint8Array) {
  const { instance } = await WebAssembly.instantiate(binary, {});
  const exports = instance.exports as Record<string, CallableFunction>;
  exports.__module_init?.();
  return exports;
}

describe("#4079 — ++/-- on an i32-slot module global", () => {
  // The reduced form of test262 S11.3.1_A3_T1 CHECK#1.
  it("postfix ++ on a boolean-initialised global validates", async () => {
    const binary = await compileStandalone(`var x = false;\nx++;\n`);
    expect(WebAssembly.validate(binary)).toBe(true);
  });

  // Validation is not correctness. `false++` must leave `x === 1`, so the
  // guard below must NOT throw. If the i32→f64→i32 round-trip were dropped or
  // truncated the wrong way this would trap during __module_init.
  it("postfix ++ on a boolean global yields ToNumber(false) + 1 === 1", async () => {
    const binary = await compileStandalone(`
var x = false;
x++;
if (x !== 0 + 1) {
  throw new Error("x was not 1");
}
`);
    await expect(runInit(binary)).resolves.toBeDefined();
  });

  it("prefix -- on a boolean global yields ToNumber(true) - 1 === 0", async () => {
    const binary = await compileStandalone(`
var y = true;
--y;
if (y !== 1 - 1) {
  throw new Error("y was not 0");
}
`);
    expect(WebAssembly.validate(binary)).toBe(true);
    await expect(runInit(binary)).resolves.toBeDefined();
  });

  // The plain f64-slot global must be unchanged by the re-routing — this is
  // the path all eight call sites already handled correctly.
  it("++/-- on an ordinary numeric global still works", async () => {
    const binary = await compileStandalone(`
var n = 41;
n++;
var m = 43;
m--;
if (n !== 42) {
  throw new Error("n");
}
if (m !== 42) {
  throw new Error("m");
}
`);
    expect(WebAssembly.validate(binary)).toBe(true);
    await expect(runInit(binary)).resolves.toBeDefined();
  });

  // Postfix must still evaluate to the OLD value and prefix to the NEW one;
  // the shared helper is what now decides that, so pin it.
  it("postfix returns the old value and prefix the new one", async () => {
    const binary = await compileStandalone(`
var a = 5;
var post = a++;
var b = 5;
var pre = ++b;
if (post !== 5) {
  throw new Error("postfix returned the new value");
}
if (pre !== 6) {
  throw new Error("prefix returned the old value");
}
`);
    await expect(runInit(binary)).resolves.toBeDefined();
  });
});
