import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #4089 — dynamic `new RegExp(pattern, flags)` cast its arguments instead of
// calling ToString, so an OBJECT argument null-dereferenced during top-level
// evaluation and killed the module:
//
//     new RegExp("abc{1}", { toString() { return ""; } })
//       → RuntimeError: dereferencing a null pointer in __module_init()
//
// §22.2.3.1 steps 5/7 require ToString, which must call the object's own
// `toString()`. The correct conversion already existed in the same file —
// `emitRegexSearchCall` routes every `.test`/`.exec` subject through the
// runtime `__extern_toString` (#3724) — so two sites needed the identical
// conversion and only one had it (the #4080 shape). `emitArgAsNativeString` is
// now the single owner.

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

describe("#4089 — RegExp constructor arguments go through ToString", () => {
  // Before the fix `__module_init` trapped with a null-pointer dereference.
  // Note the module ALWAYS validated — the failure was at run time, so
  // `WebAssembly.validate` alone would not have caught this.
  it("an object flags argument no longer traps during module init", async () => {
    const binary = await compileStandalone(`
var flagsObj = { toString: function () { return ""; } };
var re = new RegExp("a", flagsObj);
`);
    expect(WebAssembly.validate(binary)).toBe(true);
    await expect(runInit(binary)).resolves.toBeDefined();
  });

  // Verify by VALUE that the object's own toString() was honoured: "g" must
  // produce a global regex. If ToString were skipped (or answered
  // "[object Object]") this would throw on invalid flags instead.
  it("the object's own toString() supplies the flags (value check)", async () => {
    const binary = await compileStandalone(`
var flagsObj = { toString: function () { return "g"; } };
var got = 0;
try {
  var re = new RegExp("a", flagsObj);
  got = re.global === true ? 1 : 2;
} catch (e) {
  got = 3;
}
export function probe(): number { return got; }
`);
    const exports = await runInit(binary);
    expect(exports.probe!()).toBe(1);
  });

  // An object PATTERN argument takes the same path (§22.2.3.1 step 5).
  it("an object pattern argument goes through ToString too", async () => {
    const binary = await compileStandalone(`
var patObj = { toString: function () { return "a"; } };
var got = 0;
try {
  var re = new RegExp(patObj, "");
  got = re.source === "a" ? 1 : 2;
} catch (e) {
  got = 3;
}
export function probe(): number { return got; }
`);
    const exports = await runInit(binary);
    expect(exports.probe!()).toBe(1);
  });

  // The plain string path must be unchanged — this is what every ordinary
  // `new RegExp(s, "g")` uses.
  it("string pattern and flags still work", async () => {
    const binary = await compileStandalone(`
var re = new RegExp("a", "g");
var ok = re.global === true && re.ignoreCase === false ? 1 : 2;
export function probe(): number { return ok; }
`);
    const exports = await runInit(binary);
    expect(exports.probe!()).toBe(1);
  });
});
