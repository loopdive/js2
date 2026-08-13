// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — `new TypeError()` must construct the USER's `TypeError` when one is
 * in scope.
 *
 * `tryCompileBuiltinGlobalNew` claimed the NativeError names by NAME with no
 * scope check, so a shadowing declaration produced the intrinsic while the
 * identifier of the same name read the user's binding. Measured before the fix:
 * `e.constructor === TypeError` false, `e.constructor === intrinsicTypeError`
 * true — which is exactly the collision
 * `harness/assert-throws-custom-typeerror.js` exists to detect.
 *
 * The guard is syntactic and deliberately conservative: every case it misses
 * keeps the previous behaviour. `Test262Error` is excluded on purpose — the
 * harness always declares it, and the ctor-carrying lowering exists to
 * reconcile that rather than to decline it.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

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

describe("#4394 — a shadowed intrinsic Error constructor", () => {
  it("constructs the user's TypeError inside an IIFE", async () => {
    // The literal shape of harness/assert-throws-custom-typeerror.js.
    const logged = await runJs(`
var intrinsicTypeError = TypeError;
(function () {
  function TypeError() {}
  var e = new TypeError();
  console.log("local: " + (e.constructor === TypeError));
  console.log("intrinsic: " + (e.constructor === intrinsicTypeError));
})();
`);
    expect(logged).toContain("local: true");
    expect(logged).toContain("intrinsic: false");
  });

  it("does NOT yet honour a TOP-LEVEL shadow (known limitation)", async () => {
    // Pinned as a limitation, not a success. `errorCtorNameIsUserShadowed`
    // reports this correctly, but a top-level `function RangeError() {…}` is
    // claimed by a different `new` path before the guarded arm is consulted, so
    // the user's body never runs. The harness cases that matter
    // (assert-throws-custom-typeerror) all shadow inside an IIFE, which the
    // arm above does fix. Recorded so a later repair has a failing-to-passing
    // signal to aim at instead of a silent behaviour change.
    const logged = await runJs(`
var calls = 0;
function RangeError() { calls++; }
var e = new RangeError();
console.log("calls: " + calls);
`);
    expect(logged).toContain("calls: 0");
  });

  it("honours a shadowing parameter", async () => {
    const logged = await runJs(`
function make(Error) { return new Error(); }
function Custom() { this.tag = "param"; }
console.log("tag: " + make(Custom).tag);
`);
    expect(logged).toContain("tag: param");
  });

  it("still builds the intrinsic when nothing shadows it", async () => {
    const logged = await runJs(`
var e = new TypeError("boom");
console.log("ctor: " + (e.constructor === TypeError));
console.log("name: " + e.name);
console.log("message: " + e.message);
console.log("isError: " + (e instanceof Error));
`);
    expect(logged).toContain("ctor: true");
    expect(logged).toContain("name: TypeError");
    expect(logged).toContain("message: boom");
    expect(logged).toContain("isError: true");
  });

  it("leaves a module-declared Test262Error on the ctor-carrying path", async () => {
    // Excluded from the guard on purpose — declining here would undo the
    // constructor-identity repair the harness depends on.
    const logged = await runJs(`
function Test262Error(message) { this.message = message || ""; }
var e = new Test262Error("boom");
console.log("ctor: " + (e.constructor === Test262Error));
console.log("instanceof: " + (e instanceof Test262Error));
`);
    expect(logged).toContain("ctor: true");
    expect(logged).toContain("instanceof: true");
  });
});
