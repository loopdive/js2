// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4660 — an ambient host global must not hijack a user function shadow.
 *
 * `ctx.declaredGlobals` is name-keyed and module-wide, and every arm above it in
 * `compileIdentifierCore` that models shadowing is name-keyed too (and the first
 * is per-FunctionContext). So a `function TypeError() {}` hoisted into a body
 * the driven async lowering re-hosts into `$__async_resume_*` was invisible to
 * all of them, the read fell through to `env.global_TypeError`, and the
 * shadowing declaration read back as the INTRINSIC.
 *
 * The discriminator is a nested ASYNC function that captures the shadow and is
 * actually invoked — not a bare `await`. Measured before the fix:
 * `TypeError === intrinsicTypeError` was `true` in the first two cases below.
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
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.log = originalLog;
  }
  return logged;
}

describe("#4660 — a user function shadowing an ambient global", () => {
  it("reads as the user's binding inside a frame-driven async body", async () => {
    const logged = await runJs(`
var intrinsicTypeError = TypeError;
async function driven() {
  function TypeError() {}
  var pending = (async function () { throw new TypeError(); })();
  console.log("shadowed: " + (TypeError === intrinsicTypeError));
  try { await pending; } catch (e) {}
}
driven();
`);
    expect(logged).toContain("shadowed: false");
  });

  it("reads as the user's binding when the capturing async fn is called via a variable", async () => {
    const logged = await runJs(`
var intrinsicTypeError = TypeError;
async function driven() {
  function TypeError() {}
  var inner = async function () { throw new TypeError(); };
  var pending = inner();
  console.log("shadowed: " + (TypeError === intrinsicTypeError));
  try { await pending; } catch (e) {}
}
driven();
`);
    expect(logged).toContain("shadowed: false");
  });

  it("keeps an UNSHADOWED ambient read on the host global", async () => {
    // The guard must not disturb the ordinary case: with no shadow in scope,
    // `TypeError` is still the ambient intrinsic.
    const logged = await runJs(`
var intrinsicTypeError = TypeError;
async function driven() {
  await Promise.resolve(1);
  console.log("same: " + (TypeError === intrinsicTypeError));
}
driven();
`);
    expect(logged).toContain("same: true");
  });
});
