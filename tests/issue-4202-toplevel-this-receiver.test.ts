// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4202 — `f.call(this)` / `f.apply(this)` at Script top level must install the
// GLOBAL OBJECT as the callee's receiver.
//
// `named-this-call.ts` (#3796/#4025 `.call`, #3983 `.apply`) already reserves a
// receiver-installing trampoline for a stable named FunctionDeclaration, and it
// works — `f.call(o) === o` is true today. Its admission gate refused a `this`
// receiver outright unless the CALLING function reads `__current_this`:
//
//     if (inner.kind === ts.SyntaxKind.ThisKeyword) return fctx.readsCurrentThis === true;
//
// At Script top level the caller is `__module_init`, whose own `this` takes the
// #3365 arm and compiles straight to the global object without ever touching
// `__current_this`. So the flag is false, a provably non-null receiver was
// refused, and the call fell into the legacy lowering that evaluates `thisArg`
// and DROPS it. That is `language/function-code/10.4.3-1-{70,75}{-s,gs}`.
//
// ── Why this file uses #4190's no-export harness ──────────────────────────
// A top-level `export` makes TypeScript call the source a MODULE, and module
// top-level `this` is legitimately `undefined`. Under that goal `f.call(this)
// === this` reads `undefined === undefined` and passes on unfixed main — a
// VACUOUS green. So the body carries no export, signals failure by throwing,
// and completing `__module_init` IS the pass; `inferModuleStrictArguments:
// false` pins the Script goal exactly as `runTest262File` does.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Compile + run `body` as a sloppy SCRIPT. Returns the thrown text, or null. */
async function runScript(body: string, standalone: boolean): Promise<string | null> {
  const result = await compile(body, {
    allowJs: true,
    fileName: "issue-4202.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    ...(standalone ? { target: "standalone" as const, deferTopLevelInit: true, hostBridge: "always" } : {}),
  } as Parameters<typeof compile>[1]);
  expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  expect(WebAssembly.validate(result.binary), "module must be valid Wasm").toBe(true);
  if (standalone) {
    // A standalone module must not need a JS host to answer a `this` question.
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => i.module)).not.toContain("env");
  }
  const imports = standalone
    ? {}
    : (buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as never);
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  try {
    (instance.exports as Record<string, () => void>).__module_init?.();
    return null;
  } catch (error) {
    return String((error as { message?: unknown })?.message ?? error);
  }
}

/** Assert the probe completes on the JS-host lane AND on `--target standalone`. */
async function expectBoth(body: string): Promise<void> {
  expect(await runScript(CHECK + body, false), "JS-host lane").toBeNull();
  expect(await runScript(CHECK + body, true), "standalone lane").toBeNull();
}

/** `check(cond, tag)` source helper — throws the tag when `cond` is false. */
const CHECK = `function check(ok, tag) { if (!ok) { throw "FAILED: " + tag; } }\n`;

describe("#4202 top-level `this` as a .call/.apply receiver", () => {
  // ── RED on origin/main ───────────────────────────────────────────────
  it("a strict callee sees the global object through .call(this) (10.4.3-1-75-s)", async () => {
    await expectBoth(`
      function f() { "use strict"; return this; }
      check(f.call(this) === this, "f.call(this) must be the global object");
    `);
  });

  it("a strict callee sees the global object through .apply(this) (10.4.3-1-70-s)", async () => {
    await expectBoth(`
      function f() { "use strict"; return this; }
      check(f.apply(this) === this, "f.apply(this) must be the global object");
    `);
  });

  it("the installed receiver is an object, not undefined", async () => {
    await expectBoth(`
      function f() { "use strict"; return typeof this; }
      check(f.call(this) === "object", "typeof this in the callee");
    `);
  });

  it("carries positional args alongside the top-level `this` receiver", async () => {
    await expectBoth(`
      function f(a, b) { "use strict"; return (this === undefined ? 0 : 1) + a + b; }
      check(f.call(this, 10, 100) === 111, "receiver installed AND args positional");
    `);
  });

  it("the install is a save/restore pair, not a one-way write", async () => {
    await expectBoth(`
      function f() { "use strict"; return this; }
      var o = {};
      check(f.call(this) === this, "before");
      check(f.call(o) === o, "explicit object receiver between two installs");
      check(f.call(this) === this, "after");
    `);
  });

  // ── PRECONDITIONS: green on origin/main AND on this branch ───────────
  it("PRECONDITION: a SLOPPY callee already answered the global object", async () => {
    // Green on unfixed main, and not by accident: the receiver is still
    // dropped there, but a sloppy callee's *unbound* fallback is the global
    // object (#4190), so the right answer arrives for the wrong reason. It is
    // a precondition, not evidence — only the strict cases above can
    // distinguish "installed" from "fell back".
    await expectBoth(`
      function f() { return this; }
      check(f.call(this) === this, "sloppy f.call(this)");
    `);
  });

  it("PRECONDITION: an explicit object receiver still binds (#4025 unchanged)", async () => {
    await expectBoth(`
      function f() { "use strict"; return this; }
      var o = {};
      check(f.call(o) === o, "f.call(o)");
      check(f.apply(o) === o, "f.apply(o)");
    `);
  });

  it("PRECONDITION: a bare call still takes the #4190 strict/sloppy split", async () => {
    await expectBoth(`
      function sloppy() { return typeof this; }
      function strictf() { "use strict"; return this; }
      check(sloppy() === "object", "sloppy bare call binds the global object");
      check(strictf() === undefined, "strict bare call binds undefined");
    `);
  });

  it("PRECONDITION: a nullish receiver keeps its existing answer", async () => {
    await expectBoth(`
      function sloppy() { return typeof this; }
      check(sloppy.call(null) === "object", "sloppy .call(null)");
      check(sloppy.call(undefined) === "object", "sloppy .call(undefined)");
    `);
  });

  it("PRECONDITION: top-level `this` itself is still the global object (#3365)", async () => {
    await expectBoth(`
      var g = this;
      check(typeof g === "object", "top-level Script this is an object");
      check(g === this, "and it is stable");
    `);
  });

  it("PRECONDITION: an inlined strict IIFE keeps its own strictness (#4190B)", async () => {
    await expectBoth(`
      check((function () { "use strict"; return typeof this; })() === "undefined", "strict IIFE");
      check((function () { return typeof this; })() === "object", "sloppy IIFE");
    `);
  });
});
