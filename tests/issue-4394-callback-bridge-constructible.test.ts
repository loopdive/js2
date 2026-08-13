// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — a compiled ordinary function that crosses to the host must keep its
 * [[Construct]].
 *
 * `__make_callback`'s host bridge is an ARROW, and an arrow has no
 * [[Construct]]. So every compiled callable handed to a host API was rejected
 * by `Reflect.construct` / `new`, whatever it was written as. The harness's
 * `isConstructor` is built on `Reflect.construct(function () {}, [], f)` — its
 * *target* is an inline function expression, so the probe threw before it ever
 * looked at `f` and the helper answered `false` for everything, in all 644
 * test262 files that include it.
 *
 * The compiler now routes an ordinary function definition to
 * `__make_callback_ctor`, whose bridge is a plain `function`. Arrows,
 * generators, async functions and accessor callbacks stay on the arrow bridge —
 * they are correctly non-constructible, and the test below pins that so the
 * repair cannot be widened into "everything is a constructor".
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

describe("#4394 — host callback bridge constructibility", () => {
  it("lets Reflect.construct use a compiled function expression as its target", async () => {
    const logged = await runJs(`
try {
  var o = Reflect.construct(function () {}, []);
  console.log("target: " + (typeof o === "object"));
} catch (e) {
  console.log("target threw: " + e);
}
`);
    expect(logged).toContain("target: true");
  });

  it("reproduces the harness isConstructor probe over host constructors", async () => {
    const logged = await runJs(`
function isConstructor(f) {
  if (typeof f !== "function") { throw new Error("isConstructor invoked with a non-function value"); }
  try { Reflect.construct(function () {}, [], f); } catch (e) { return false; }
  return true;
}
console.log("Array: " + isConstructor(Array));
console.log("Object: " + isConstructor(Object));
console.log("map: " + isConstructor(Array.prototype.map));
`);
    expect(logged).toContain("Array: true");
    expect(logged).toContain("Object: true");
    // A builtin prototype method has no [[Construct]] — the probe must still
    // say so, i.e. the repair must not make construction succeed universally.
    expect(logged).toContain("map: false");
  });

  it("keeps an arrow non-constructible across the same bridge", async () => {
    // The negative half of the repair: both callables reach the host through
    // the callback maker, and only the ordinary function may gain
    // [[Construct]]. Without this, "make the bridge a function" would silently
    // turn every arrow into a constructor.
    const logged = await runJs(`
try { Reflect.construct(() => {}, []); console.log("arrow: constructed"); }
catch (e) { console.log("arrow: refused"); }
try { Reflect.construct(function () {}, []); console.log("fn: constructed"); }
catch (e) { console.log("fn: refused"); }
`);
    expect(logged).toContain("arrow: refused");
    expect(logged).toContain("fn: constructed");
  });

  it("still calls a constructible-bridge callback normally", async () => {
    // The bridge changed shape from arrow to `function`; ordinary invocation,
    // arguments and the return value must be untouched.
    const logged = await runJs(`
var out = [3, 1, 2].map(function (v, i) { return v * 10 + i; });
console.log("map: " + out.join(","));
var total = [1, 2, 3].reduce(function (a, b) { return a + b; }, 0);
console.log("reduce: " + total);
`);
    expect(logged).toContain("map: 30,11,22");
    expect(logged).toContain("reduce: 6");
  });
});
