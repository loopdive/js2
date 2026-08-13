// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — `Object.defineProperty(globalThis, …)` must not take the compiled
 * struct fast path.
 *
 * The global object is a host value in the JS-host lane and has no WasmGC
 * struct representation. But a single earlier VALUE use of `globalThis` — the
 * test262 harness prefix's `var $262 = { global: globalThis }`, which sits in
 * front of *every* test — makes the checker mint a struct for
 * `typeof globalThis`. `compileObjectDefineProperty` then resolved a struct
 * name for the receiver and emitted the struct arm, whose guarded
 * `ref.test` / `ref.cast` can never match a host externref: the cast yielded
 * `ref.null`, and the receiver null-guard threw
 * "TypeError: Object method called on null or undefined" for a receiver that
 * was never null.
 *
 * The trigger is the earlier value use, not the define itself — which is why
 * the first test below pairs them and the second shows the define alone was
 * always fine.
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

describe("#4394 — defineProperty on the global object", () => {
  it("defines on globalThis after globalThis was used as a value", async () => {
    const logged = await runJs(`
var $262 = { global: globalThis };
Object.defineProperty(globalThis, "issue4394a", { configurable: true, value: 7 });
console.log("value: " + globalThis.issue4394a);
var d = Object.getOwnPropertyDescriptor(globalThis, "issue4394a");
console.log("configurable: " + (d && d.configurable));
`);
    expect(logged).toContain("value: 7");
    expect(logged).toContain("configurable: true");
  });

  it("defines on a script's top-level `this` after the same value use", async () => {
    const logged = await runJs(`
var $262 = { global: this };
Object.defineProperty(this, "issue4394b", { configurable: true, value: 8 });
console.log("value: " + this.issue4394b);
`);
    expect(logged).toContain("value: 8");
  });

  it("redefines an existing global binding to its own current value", async () => {
    // The literal shape of harness/verifyProperty-configurable-object.js.
    const logged = await runJs(`
var $262 = { global: globalThis };
Object.defineProperty(globalThis, "Object", { configurable: true, value: Object });
var d = Object.getOwnPropertyDescriptor(globalThis, "Object");
console.log("configurable: " + (d && d.configurable));
console.log("still usable: " + (typeof Object.keys === "function"));
`);
    expect(logged).toContain("configurable: true");
    expect(logged).toContain("still usable: true");
  });

  it("still uses the struct path for an ordinary object receiver", async () => {
    // The exclusion must be scoped to the global object — a genuinely
    // struct-typed receiver keeps its fast path and its semantics.
    const logged = await runJs(`
var o = { a: 1 };
Object.defineProperty(o, "a", { value: 5, writable: false, configurable: false });
console.log("value: " + o.a);
o.a = 99;
console.log("after write: " + o.a);
`);
    expect(logged).toContain("value: 5");
    expect(logged).toContain("after write: 5");
  });
});
