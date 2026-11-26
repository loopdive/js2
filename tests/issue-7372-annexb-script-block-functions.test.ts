// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7372 slice 2a-2 — Annex B block functions of a sloppy script on the Prepared whole-program path (§B.3.2.2,
// §B.3.3): a block binding made when its scope (a Block, a switch's CaseBlock, an `if` clause) is entered, and,
// where no early error forbids it, a script `var` of the same name, `undefined` until the declaration is evaluated,
// then the block binding's current value. Every program is run in node too, with a wrong twin that must throw.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { preparedScriptRefusal, runPreparedScript, TEST262_SCRIPT } from "./helpers/prepared-script-run.js";

/** Node's verdict on the same sloppy script. */
function nodeVerdict(source: string): "returned" | "threw" {
  try {
    runInNewContext(source);
    return "returned";
  } catch {
    return "threw";
  }
}

describe("#7372 2a-2 — Annex B block functions of a script", () => {
  it.each([
    [
      "is undefined before its block",
      "var before = f; { function f() { return 2; } }",
      "before !== undefined",
      "before !== 2",
    ],
    ["is the function after its block", "{ function f() { return 2; } }", "f() !== 2", "f() !== 3"],
    [
      "is callable in its block before its statement",
      "var r; { r = f(); function f() { return 2; } }",
      "r !== 2",
      "r !== undefined",
    ],
    [
      "keeps its block binding apart from the var (block-scoping)",
      "var i, c, v; { function f() { i = f; f = 123; c = f; return 'd'; } } v = f; f();",
      "i() !== 'd' || c !== 123 || v() !== 'd'",
      "c !== 'd'",
    ],
    [
      "in an if clause",
      "if (true) function f() { return 7; } else function g() {}",
      "f() !== 7 || g !== undefined",
      "f() !== 8",
    ],
    [
      // A read of `f` after the switch draws the front end's CaseBlock-leak warning (#1805), which this helper
      // counts; the var write a later clause skips is covered by annexB/language/global-code/switch-*-update.js.
      "in a switch, made at CaseBlock entry before any clause runs",
      "var r; switch (2) { case 1: function f() { return 5; } case 2: r = f(); }",
      "r !== 5",
      "r !== undefined",
    ],
    [
      "in two blocks, the later evaluation wins",
      "{ function f() { return 'a'; } } { function f() { return 'b'; } }",
      "f() !== 'b'",
      "f() !== 'a'",
    ],
    [
      "under a catch parameter of its name, written by identity, not into the parameter",
      "var inner; try { throw null; } catch (f) { { function f() { return 3; } } inner = f; }",
      "inner !== null || f() !== 3",
      "inner === null",
    ],
    [
      "beside a script let of its name: no var binding",
      "let f = 123; { function f() { return 1; } }",
      "f !== 123",
      "typeof f !== 'function'",
    ],
  ])("a block function %s", async (_, program, holds, fails) => {
    for (const [check, verdict] of [
      [holds, "returned"],
      [fails, "threw"],
    ] as const) {
      const source = `${program} if (${check}) throw 1;`;
      expect(nodeVerdict(source), source).toBe(verdict);
      expect(await runPreparedScript(source, "test.js", TEST262_SCRIPT), source).toBe(verdict);
    }
  });

  // Not modelled in 2a; each refuses by name instead of compiling to a wrong value.
  it.each([
    ["a script var of the same name", "var f; { function f() {} }", "shares its name with a var or function"],
    ["a top-level function of the same name", "function f() {} { function f() {} }", "shares its name"],
    ["a built-in global's name", "{ function parseInt() {} }", "shadows a built-in global"],
    ["a loop body", "for (var i = 0; i < 1; i++) { function f() {} }", "is in a loop body"],
    ["two declarations in one block", "{ function f() {} function f() {} }", "is declared twice in one scope"],
    ["a typed-default parameter", "{ function f(a = 1) {} }", "is outside the dynamic closure subset"],
    [
      "a read outside its block where a let cancels the var",
      "{ let f = 1; { function f() {} } } var t = f;",
      "is read where no binding of it exists",
    ],
  ])("refuses %s", async (_, source, reason) => {
    expect(await preparedScriptRefusal(source, "test.js", TEST262_SCRIPT)).toContain(reason);
  });
});
