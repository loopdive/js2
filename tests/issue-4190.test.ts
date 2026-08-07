// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4190 — ES5 §10.4.3 "Entering Function Code": the unbound-receiver `this`.
//
// Two independent defects, both in the ThisKeyword arm of
// `src/codegen/expressions.ts`, both measured on `--target standalone`:
//
//   (A) The terminal fallback emitted `undefined` for EVERY body with no
//       receiver binding. That is right for strict code and wrong for sloppy
//       code, where §10.4.3 binds the global object. So `function f() {
//       return typeof this; } f()` answered "undefined" instead of "object" —
//       the whole `language/function-code/10.4.3-1-*` family, plus every
//       `f.call(null)` / `f.apply(undefined)` sloppy shape.
//
//   (B) The §3365 "Script-goal top-level `this` is the global object" arm keys
//       on `fctx.name === "__module_init"`, which describes the EMITTED
//       function, not the source. A top-level IIFE is inlined into
//       `__module_init` by `compileIIFE`, so its body's `this` took that arm
//       and became the global object even under a `"use strict"` prologue.
//       The tell is that the same callee behaves differently purely by whether
//       it was inlined:
//
//           (function () { "use strict"; return typeof this; })()   // was "object"
//           var f = function () { "use strict"; return typeof this; }; f()  // "undefined"
//
// Measured on the 168-file ES5-label standalone lever (es5id clauses 10.4.3 /
// 15.3.4.3 / 15.3.4.4 / 11.2.3): 0/168 -> 58/168, with 138/138 held on the
// currently-passing control from the same clauses.
//
// STILL BROKEN, deliberately out of scope (see the issue file): `.call` /
// `.apply` / `.bind` do not deliver the thisArg at all when the callee is a
// function EXPRESSION — `src/codegen/named-this-call.ts` (#4025) covers only
// stable named FunctionDeclarations. That is asserted below as a documented
// gap so the follow-up has a canary.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile + run `body` as a sloppy SCRIPT with the exact knobs
 * `runTest262File` uses for the standalone lane.
 *
 * The body must carry NO `export`: a top-level export makes TypeScript call the
 * source a module, and module top-level `this` is legitimately `undefined`,
 * which would silently take these assertions off the Script-goal path they are
 * about. So — exactly like test262's original-harness verdict — the body signals
 * failure by throwing, and completing `__module_init` IS the pass.
 *
 * Returns the thrown value's text, or null on success.
 */
async function runScript(body: string): Promise<string | null> {
  const result = await compile(body, {
    allowJs: true,
    fileName: "issue-4190.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    target: "standalone",
    deferTopLevelInit: true,
    hostBridge: "always",
  } as Parameters<typeof compile>[1]);
  expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  // A standalone module must not need a JS host to answer a `this` question.
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => i.module)).not.toContain("env");
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  try {
    (instance.exports as Record<string, () => void>).__module_init?.();
    return null;
  } catch (error) {
    return String((error as { message?: unknown })?.message ?? error);
  }
}

/** `check(cond, tag)` source helper — throws the tag when `cond` is false. */
const CHECK = `function check(ok, tag) { if (!ok) { throw "FAILED: " + tag; } }\n`;

describe("#4190 ES5 10.4.3 — unbound-receiver `this`", () => {
  it("binds the global object in sloppy function code, `undefined` in strict", async () => {
    expect(
      await runScript(
        CHECK +
          `function sloppy() { return typeof this; }
           var strictf = function () { "use strict"; return typeof this; };
           check(sloppy() === "object", "sloppy() this must be the global object");
           check(strictf() === "undefined", "strict this must be undefined");
           check(sloppy.call(null) === "object", "sloppy .call(null)");
           check(sloppy.call(undefined) === "object", "sloppy .call(undefined)");`,
      ),
    ).toBeNull();
  });

  it("an INLINED top-level IIFE keeps its own strictness, not __module_init's", async () => {
    expect(
      await runScript(
        CHECK +
          `check((function () { "use strict"; return typeof this; })() === "undefined", "strict IIFE");
           check((function () { return typeof this; })() === "object", "sloppy IIFE");
           check((function () { "use strict"; var g = function () { return typeof this; }; return g(); })() === "undefined", "fn expr inside strict IIFE");
           check((function () { "use strict"; return this; })() === undefined, "strict IIFE identity");`,
      ),
    ).toBeNull();
  });

  it("still binds a genuinely top-level Script `this` to the global object", async () => {
    // #3365 must survive the lexical narrowing: a `this` that really does
    // belong to top-level Script code keeps the global object.
    expect(
      await runScript(
        CHECK +
          `var g = this;
           check(typeof g === "object", "top-level Script this is an object");
           check(g !== null && g !== undefined, "top-level Script this is not nullish");
           check((function () { return this; })() === g, "sloppy fn this === top-level this");`,
      ),
    ).toBeNull();
  });

  // (#4202) CANARY DISCHARGED. This case asserted `.not.toBeNull()` — that a
  // variable-held function EXPRESSION still LOST its `.call` receiver — as a
  // tripwire for the follow-up slice, with the standing instruction "when the
  // follow-up lands … this expectation flips to `toBeNull()`".
  //
  // #4192 landed that slice (`closure-receiver-install.ts`) and did not flip
  // the canary, so `tests/issue-4190.test.ts` has been RED on `origin/main`
  // ever since — verified here by A/B, running this exact file against
  // `origin/main`'s `named-this-call.ts` + `sloppy-this-global.ts`: still red,
  // so the flip is discharging #4192's tripwire and is unrelated to #4202's
  // own change. Both forms now deliver the receiver, so both are asserted
  // positively and the case becomes an ordinary regression guard.
  it("both a function DECLARATION and a function EXPRESSION deliver the .call thisArg", async () => {
    const PRELUDE = `var o = { tag: 7 };
       function decl() { return this; }
       var expr = function () { return this; };\n`;
    expect(await runScript(CHECK + PRELUDE + `check(decl.call(o) === o, "decl");`)).toBeNull();
    expect(await runScript(CHECK + PRELUDE + `check(expr.call(o) === o, "expr");`)).toBeNull();
  });
});
