// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — an object-literal argument that OMITS optional fields the parameter
 * declares must still arrive as an object, not `null`.
 *
 * Under `allowJs` the checker types a JSDoc'd parameter, so
 *
 *   \/** @param {object} [options]
 *    *  @param {boolean} [options.label]
 *    *  @param {boolean} [options.restore] *\/
 *   function verifyProperty(obj, name, desc, options) { … }
 *   verifyProperty(obj, prop, desc, { restore: true });   // propertyHelper.js
 *
 * lowered the argument to `struct.new <{restore}>` plus a call-boundary guarded
 * downcast to `<{label,restore}>`. A guarded cast that misses yields `ref.null`,
 * so `options` arrived NULL and `options && options.restore` was false — which
 * is why test262's `verifyProperty(..., { restore: true })` silently restored
 * nothing.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Compile as JS with `allowJs` so JSDoc `@param` types are honoured — the
 *  configuration the test262 original-harness lane uses. */
async function runJs(source: string): Promise<string[]> {
  const result = await compile(source, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const logged: string[] = [];
  const imports = buildImports(result.imports, undefined, result.stringPool) as any;
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const { instance } = await WebAssembly.instantiate(result.binary!, imports);
    imports.setInstance?.(instance);
    imports.setExports?.(instance.exports);
    const exports = instance.exports as Record<string, unknown>;
    if (typeof exports.__module_init === "function") (exports.__module_init as () => void)();
  } finally {
    console.log = originalLog;
  }
  return logged;
}

describe("#4394 — object-literal argument omitting optional fields", () => {
  it("passes a partial literal as an object, not null", async () => {
    const logged = await runJs(`
/**
 * @param {object} [options]
 * @param {boolean} [options.label]
 * @param {boolean} [options.restore]
 */
function f(options) {
  return "isNull=" + (options === null) + " restore=" + (options && options.restore ? "y" : "n");
}
console.log("partial: " + f({ restore: true }));
console.log("other: " + f({ label: true }));
console.log("full: " + f({ label: false, restore: true }));
`);
    expect(logged).toContain("partial: isNull=false restore=y");
    expect(logged).toContain("other: isNull=false restore=n");
    expect(logged).toContain("full: isNull=false restore=y");
  });

  it("reproduces the propertyHelper.js restore contract", async () => {
    const logged = await runJs(`
var __defineProperty = Object.defineProperty;
var __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
/**
 * @param {object} obj
 * @param {string|symbol} name
 * @param {object} [options]
 * @param {boolean} [options.label]
 * @param {boolean} [options.restore]
 */
function verify(obj, name, options) {
  var originalDesc = __getOwnPropertyDescriptor(obj, name);
  delete obj[name];
  if (options && options.restore) {
    __defineProperty(obj, name, originalDesc);
  }
  return true;
}
var obj = {};
__defineProperty(obj, "prop", { enumerable: true, configurable: true, writable: true, value: 42 });
verify(obj, "prop", { restore: true });
console.log("restored: " + __hasOwnProperty(obj, "prop"));
console.log("value: " + obj["prop"]);
`);
    expect(logged).toContain("restored: true");
    expect(logged).toContain("value: 42");
  });
});
