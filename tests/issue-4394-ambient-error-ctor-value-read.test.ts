// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — a BARE reference to an ambient builtin constructor must resolve to
 * the real host constructor in the JS-host/GC lane.
 *
 * `Error`/`TypeError`/`RangeError`/`SyntaxError`/`ReferenceError` were listed in
 * both `LIB_GLOBALS` (the gate that decides whether `collectDeclaredGlobals`
 * runs at all) and `AMBIENT_BUILTIN_CTORS` (the loop that registers
 * `env.global_<Name>`). Their siblings `EvalError`/`URIError`/`AggregateError`
 * — plus `BigInt`/`Proxy`/`SharedArrayBuffer`/`Atomics` — were in neither, so a
 * bare value read lowered to `ref.null.extern`.
 *
 * `new EvalError()` was never affected: it goes through the `__new_EvalError`
 * host import and produces a genuine host EvalError. Only the *identifier* was
 * null, which is exactly what makes the bug quiet — every identity comparison
 * against the constructor answered `false` instead of throwing. test262's
 * `assert.throws` is built on `thrown.constructor !== expectedErrorConstructor`
 * and then reads `expectedErrorConstructor.name` off the null.
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

describe("#4394 — bare ambient builtin constructor value reads", () => {
  // Each name is compiled on its own so the test also covers the `LIB_GLOBALS`
  // gate: a module mentioning ONLY `EvalError` used to skip declared-global
  // collection entirely. Mixing them into one module would hide that half.
  const NAMES = [
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "EvalError",
    "URIError",
    "AggregateError",
    "BigInt",
    "Proxy",
  ];

  for (const name of NAMES) {
    it(`resolves bare \`${name}\` to the host global`, async () => {
      const logged = await runJs(`console.log("same: " + (${name} === globalThis.${name}));`);
      expect(logged).toContain("same: true");
    });
  }

  it("matches `thrown.constructor` for every NativeError subtype", async () => {
    const logged = await runJs(`
function ctorOf(make) {
  try { make(); } catch (thrown) { return thrown.constructor; }
  return null;
}
console.log("Error: " + (ctorOf(function () { throw new Error(); }) === Error));
console.log("EvalError: " + (ctorOf(function () { throw new EvalError(); }) === EvalError));
console.log("URIError: " + (ctorOf(function () { throw new URIError(); }) === URIError));
`);
    expect(logged).toContain("Error: true");
    expect(logged).toContain("EvalError: true");
    expect(logged).toContain("URIError: true");
  });

  it("runs the harness `assert.throws` shape against a native EvalError", async () => {
    // Condensed from test262/harness/assert.js — the exact sequence that used
    // to dereference the null constructor.
    const logged = await runJs(`
function assertThrows(expectedErrorConstructor, func) {
  try {
    func();
  } catch (thrown) {
    if (thrown.constructor !== expectedErrorConstructor) {
      return "wrong: expected " + expectedErrorConstructor.name + " got " + thrown.constructor.name;
    }
    return "ok";
  }
  return "none";
}
console.log("evalerror: " + assertThrows(EvalError, function () { throw new EvalError(); }));
console.log("urierror: " + assertThrows(URIError, function () { throw new URIError(); }));
console.log("mismatch: " + assertThrows(EvalError, function () { throw new URIError(); }));
`);
    expect(logged).toContain("evalerror: ok");
    expect(logged).toContain("urierror: ok");
    expect(logged).toContain("mismatch: wrong: expected EvalError got URIError");
  });
});
