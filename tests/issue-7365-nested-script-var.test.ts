// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7365 slice 1 — a `var` nested in top-level code (a block, `if`, loop, `try`, `switch` or label of a script) on
// the Prepared whole-program path. It belongs to the script scope wherever its statement is, so it has the same
// global as a top-level `var` (slice H's home): `undefined` from instantiation, visible after its block and to
// every function. A top-level `for (;;)` head keeps the typed home when every read follows it. Slice 1b: a repeated
// script `var` is one binding.
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparedScriptRefusal, runPreparedScript } from "./helpers/prepared-script-run.js";

afterEach(() => vi.restoreAllMocks());

/** Node's verdict on the same sloppy script. */
function nodeVerdict(source: string): "returned" | "threw" {
  try {
    runInNewContext(source);
    return "returned";
  } catch {
    return "threw";
  }
}

describe("#7365 slice 1 — a var nested in top-level code", () => {
  // Each program runs with node's answer (returns) and a wrong one (throws); node is asked both times too.
  it.each([
    ["in a taken branch", "if (true) { var x = 1; }", "x !== 1", "x !== 2"],
    ["in a branch never taken", "if (false) { var y = 1; }", "y !== undefined", "y !== 1"],
    ["in a block", "{ var b = 5; }", "b !== 5", "b !== 6"],
    ["in a try block", "try { var t = 2; } catch (e) {}", "t !== 2", "t !== undefined"],
    ["in a catch block", "try { throw 1; } catch (e) { var c = 3; }", "c !== 3", "c !== undefined"],
    ["in a finally block", "try {} finally { var f = 4; }", "f !== 4", "f !== undefined"],
    ["in a switch case", "switch (1) { case 1: var s = 3; }", "s !== 3", "s !== undefined"],
    ["in a switch case not taken", "var v = 2; switch (v) { case 1: var s = 3; }", "s !== undefined", "s !== 3"],
    ["in a labelled block", "L: { var q = 1; break L; }", "q !== 1", "q !== undefined"],
    ["in a while body", "var n = 0; while (n < 2) { var k = n; n++; }", "k !== 1", "k !== 0"],
    [
      "bare in a loop, kept across iterations",
      "var n = 0; while (n < 2) { if (n === 1 && k !== 0) throw 2; var k; k = n; n++; }",
      "k !== 1",
      "k !== undefined",
    ],
    ["as a for head", "for (var i = 0; i < 3; i++) {}", "i !== 3", "i !== 2"],
    ["as a two-name for head", "for (var a = 0, b = 5; a < b; a++) {}", "a !== 5 || b !== 5", "a !== 4"],
    ["as a for head nested in a block", "{ for (var j = 0; j < 2; j++) {} }", "j !== 2", "j !== undefined"],
    [
      "read by a function before and after its block runs",
      "function g() { return z; } var r = g(); { var z = 4; }",
      "r !== undefined || g() !== 4",
      "r !== 4",
    ],
    [
      "read by a function before a for head runs",
      "function h() { return i; } var e = h(); for (var i = 0; i < 3; i++) {}",
      "e !== undefined || h() !== 3",
      "h() !== 2",
    ],
    [
      "written by a function and read at top level",
      "function w() { m = 7; } w(); if (false) { var m; }",
      "m !== 7",
      "m !== undefined",
    ],
    [
      "beside a top-level var declared after it",
      "var a0 = 1; if (true) { var x = 2; } var b0 = 3;",
      "a0 + b0 !== 4 || x !== 2",
      "x !== 1",
    ],
  ])("%s", async (_, program, holds, fails) => {
    for (const [check, verdict] of [
      [holds, "returned"],
      [fails, "threw"],
    ] as const) {
      const source = `${program} if (${check}) throw 1;`;
      expect(nodeVerdict(source), source).toBe(verdict);
      expect(await runPreparedScript(source), source).toBe(verdict);
    }
  });

  // Slice 1b: a repeated script `var` is one binding with one global, the first declarator's; each later
  // declarator's initializer is a write and a bare one is a no-op.
  it.each([
    ["declared twice with initializers", "var x = 1; var x = 2;", "x !== 2", "x !== 1"],
    ["declared again bare", "var x = 1; var x;", "x !== 1", "x !== undefined"],
    ["assigned, then declared again bare", "var x; x = 1; var x;", "x !== 1", "x !== undefined"],
    ["declared as ±0", "var x = +0; var x = -0;", "1 / x !== -Infinity", "1 / x !== Infinity"],
    ["as the head of two loops", "for (var i = 0; i < 1; i++) {} for (var i = 0; i < 2; i++) {}", "i !== 2", "i !== 1"],
    [
      "bare in two script loops",
      "var r; for (var i = 0; i < 1; i++) { var g; g = 5; } for (var j = 0; j < 1; j++) { var g; r = g; }",
      "r !== 5",
      "r !== undefined",
    ],
    ["first in a block, then at top level", "{ var x = 1; } var x;", "x !== 1", "x !== undefined"],
    ["at top level, then in a block", "var x = 1; { var x = 2; }", "x !== 2", "x !== 1"],
    [
      "read by a function before both declarations run",
      "function f() { return x; } var a = f(); var x = 1; { var x = 2; }",
      "a !== undefined || f() !== 2",
      "f() !== 1",
    ],
  ])("a var %s", async (_, program, holds, fails) => {
    for (const [check, verdict] of [
      [holds, "returned"],
      [fails, "threw"],
    ] as const) {
      const source = `${program} if (${check}) throw 1;`;
      expect(nodeVerdict(source), source).toBe(verdict);
      expect(await runPreparedScript(source), source).toBe(verdict);
    }
  });

  // Not built here; each refuses by name instead of compiling to a wrong answer.
  it.each([
    [
      "a var redeclaring its catch parameter (Annex B.3.5)",
      "try { throw 1; } catch (e) { var e = 2; } if (e !== undefined) throw 1;",
      "module-init unit contains a nested var declaration",
    ],
    [
      "a pattern in a nested var",
      "if (true) { var [p] = [1]; } if (p !== 1) throw 1;",
      "whole-program binding pattern requires the existing destructuring producer",
    ],
    [
      "a for-in head var",
      'for (var key in [1]) {} if (key !== "0") throw 1;',
      "module-init unit contains a nested var declaration",
    ],
  ])("refuses %s by name", async (_, program, message) => {
    expect(await preparedScriptRefusal(program)).toContain(message);
  });
});
