// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — an async function EXPRESSION / arrow must return a Promise and must
 * turn a synchronous throw into a rejection, even when the CALL SITE cannot
 * prove the callee is async.
 *
 * Async-ness used to be applied entirely at the call site, so an INDIRECT call
 * — `res = func()` on an untyped parameter, which is exactly what
 * `assert.throwsAsync` does — got neither the `Promise.resolve` wrap nor the
 * throw→reject conversion. Measured before this: `async function () { return 1; }`
 * invoked that way returned the NUMBER `1`, and `async function () { throw x; }`
 * threw SYNCHRONOUSLY.
 *
 * Two separate compilations of the same AST needed the envelope: the lifted
 * closure (`compileClosureCore`, signature decided in `computeClosureWrapperSig`
 * so the dynamic-dispatch candidate pre-scan agrees) and the `__make_callback`
 * trampoline (`__cb_N`), which is what an INLINE async fn-expr argument becomes.
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
    // Let the microtask queue drain so `.then` handlers run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.log = originalLog;
  }
  return logged;
}

/** The `assert.throwsAsync` shape: the callee is reached through a parameter. */
const INDIRECT = `
function callIndirect(func) {
  var res;
  try { res = func(); } catch (e) { return "threw sync"; }
  return res && typeof res.then === "function" ? "thenable" : "plain " + typeof res;
}
`;

describe("#4394 — callee-side Promise envelope for async fn-expressions", () => {
  it("returns a thenable through an indirect call, for every spelling", async () => {
    const logged = await runJs(`${INDIRECT}
var held = async function () { return 1; };
console.log("inline-value: " + callIndirect(async function () { return 1; }));
console.log("held-value: " + callIndirect(held));
console.log("inline-arrow: " + callIndirect(async () => 1));
console.log("inline-throw: " + callIndirect(async function () { throw new Error("x"); }));
console.log("held-throw: " + callIndirect(async function () { throw new Error("y"); }));
`);
    expect(logged).toContain("inline-value: thenable");
    expect(logged).toContain("held-value: thenable");
    expect(logged).toContain("inline-arrow: thenable");
    expect(logged).toContain("inline-throw: thenable");
    expect(logged).toContain("held-throw: thenable");
  });

  it("settles with the right value and reason", async () => {
    const logged = await runJs(`${INDIRECT}
function settle(label, func) {
  var p = func();
  p.then(function (v) { console.log(label + " resolved: " + v); },
         function (e) { console.log(label + " rejected: " + e); });
}
settle("value", async function () { return 42; });
settle("empty", async function () {});
settle("arrow", async () => 7);
settle("throw", async function () { throw new TypeError("t"); });
`);
    expect(logged).toContain("value resolved: 42");
    // §27.7.5.1: falling off the end fulfils with `undefined`, not `null`.
    expect(logged).toContain("empty resolved: undefined");
    expect(logged).toContain("arrow resolved: 7");
    expect(logged).toContain("throw rejected: TypeError: t");
  });

  it("drives assert.throwsAsync's contract with an inline argument", async () => {
    const logged = await runJs(`${INDIRECT}
function throwsAsync(ctor, func) {
  var res;
  try { res = func(); } catch (e) { return "threw synchronously"; }
  if (res === null || typeof res !== "object" || typeof res.then !== "function") return "not a thenable";
  return "ok";
}
console.log("inline: " + throwsAsync(Error, async function () { throw new Error(); }));
console.log("arrow: " + throwsAsync(Error, async () => { throw new Error(); }));
`);
    expect(logged).toContain("inline: ok");
    expect(logged).toContain("arrow: ok");
  });

  it("leaves an awaiting body and a try body on the legacy lowering", async () => {
    // Neither is claimed by this envelope (see `asyncClosureNeedsPromiseWrap`);
    // the assertion is only that they still compile and run unchanged.
    const logged = await runJs(`${INDIRECT}
var awaiting = async function () { var p = Promise.resolve(3); return await p; };
console.log("awaiting: " + typeof awaiting());
var trying = async function () { try { return 1; } finally { } };
console.log("trying: " + typeof trying());
`);
    expect(logged.some((l) => l.startsWith("awaiting: "))).toBe(true);
    expect(logged.some((l) => l.startsWith("trying: "))).toBe(true);
  });
});
