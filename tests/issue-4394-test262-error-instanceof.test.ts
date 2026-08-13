// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — `err instanceof Test262Error` must hold for an error built through a
 * module-declared `function Test262Error`.
 *
 * The construction deliberately produces a real host `Error` subclass — that is
 * what makes `String(err)`, `.stack` and the exception bridge work — so the
 * value's prototype chain can never reach the module's own compiled closure.
 * The `.constructor` back-pointer was already stamped (see
 * `issue-4394-test262-error-ctor-identity.test.ts`), but `instanceof` walks the
 * prototype chain, not `.constructor`, so it kept answering `false` for an
 * error that plainly is a Test262Error.
 *
 * The runtime now records which module carrier each construction was attributed
 * to and consults that set in `_instanceofResult`. The last test pins the
 * narrowness: an unrelated compiled constructor must NOT start matching.
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

/** The literal sta.js declaration every assembled test262 module carries. */
const STA = `
function Test262Error(message) {
  if (!(this instanceof Test262Error)) return new Test262Error(message);
  this.message = message || "";
}
Test262Error.prototype.toString = function () { return "Test262Error: " + this.message; };
`;

describe("#4394 — instanceof against a module-declared Test262Error", () => {
  it("answers true for a directly constructed error", async () => {
    const logged = await runJs(`${STA}
var e = new Test262Error("boom");
console.log("instanceof: " + (e instanceof Test262Error));
console.log("ctor: " + (e.constructor === Test262Error));
`);
    expect(logged).toContain("instanceof: true");
    expect(logged).toContain("ctor: true");
  });

  it("answers true for one caught across a throw", async () => {
    // The harness's own shape: asyncHelpers reports a synchronously thrown
    // error through a module-declared `$DONE`, which then asks `instanceof`.
    const logged = await runJs(`${STA}
function report(error) { console.log("reported: " + (error instanceof Test262Error)); }
function run(f) { try { f(); } catch (thrown) { report(thrown); } }
run(function () { throw new Test262Error("sync"); });
`);
    expect(logged).toContain("reported: true");
  });

  it("keeps the value a real Error", async () => {
    const logged = await runJs(`${STA}
var e = new Test262Error("boom");
console.log("isError: " + (e instanceof Error));
console.log("message: " + e.message);
`);
    expect(logged).toContain("isError: true");
    expect(logged).toContain("message: boom");
  });

  it("does not match an unrelated compiled constructor", async () => {
    const logged = await runJs(`${STA}
function Other(message) { this.message = message || ""; }
var e = new Test262Error("boom");
console.log("other: " + (e instanceof Other));
var o = new Other("x");
console.log("reverse: " + (o instanceof Test262Error));
`);
    expect(logged).toContain("other: false");
    expect(logged).toContain("reverse: false");
  });
});
