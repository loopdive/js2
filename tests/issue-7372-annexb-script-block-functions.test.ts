// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7372 slice 2a-2 — Annex B block functions of a sloppy script on the Prepared whole-program path (§B.3.2.2,
// §B.3.3): a block binding made when its scope (a Block, a switch's CaseBlock, an `if` clause) is entered, and,
// where no early error forbids it, a script `var` of the same name, `undefined` until the declaration is evaluated,
// then the block binding's current value. Every program is run in node too, with a wrong twin that must throw.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { compile, requiredPreparedEmission } from "../src/test262/test262-prepared-entry.js";
import {
  preparedScriptOptions,
  preparedScriptRefusal,
  runPreparedScript,
  TEST262_SCRIPT,
} from "./helpers/prepared-script-run.js";

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

  // 2a-3: the script already declares the name. The evaluation writes that declaration's home: a `var`'s dynamic
  // home, or F1b's home of a top-level function, which every call of the name then reads.
  it.each([
    [
      "a var declared after the block (existing-var-update)",
      "{ function f() { return 'fd'; } } var t = typeof f, r = f(); var f = 123;",
      "t !== 'function' || r !== 'fd' || f !== 123",
      "r !== 123",
    ],
    [
      "a var initialized before the block (existing-var-no-init)",
      "var f = 123; var before = f; { function f() {} }",
      "before !== 123 || typeof f !== 'function'",
      "typeof f !== 'number'",
    ],
    [
      "a top-level function, replaced at the block (existing-fn-update)",
      "{ function f() { return 'inner'; } } function f() { return 'outer'; }",
      "f() !== 'inner'",
      "f() !== 'outer'",
    ],
    [
      "a top-level function, called before the block (existing-fn-no-init)",
      "var before = f(); { function f() { return 'inner'; } } function f() { return 'outer'; }",
      "before !== 'outer' || f() !== 'inner'",
      "before !== 'inner'",
    ],
    [
      "a top-level function called from another function and a closure",
      "function g() { return f(); } var a = g(); { function f() { return 'inner'; } } var k = function () { return f(); }; function f() { return 'outer'; }",
      "a !== 'outer' || g() !== 'inner' || k() !== 'inner'",
      "g() !== 'outer'",
    ],
    [
      "a top-level function read as a value before the block",
      "var g; function f() { return 1; } g = f; { function f() { return 2; } }",
      "g() !== 1 || f() !== 2",
      "g() !== 2",
    ],
    [
      "a top-level function and an if-clause declaration",
      "var before = f(); if (true) function f() { return 'inner'; } function f() { return 'outer'; }",
      "before !== 'outer' || f() !== 'inner'",
      "f() !== 'outer'",
    ],
  ])("a block function beside %s", async (_, program, holds, fails) => {
    for (const [check, verdict] of [
      [holds, "returned"],
      [fails, "threw"],
    ] as const) {
      const source = `${program} if (${check}) throw 1;`;
      expect(nodeVerdict(source), source).toBe(verdict);
      expect(await runPreparedScript(source, "test.js", TEST262_SCRIPT), source).toBe(verdict);
    }
  });

  it("refuses a script var of its name whose home is typed (a TypeScript annotation)", async () => {
    expect(await preparedScriptRefusal("var f: number = 1; { function f() {} }", "test.ts", TEST262_SCRIPT)).toContain(
      "shares its name with a script binding that has no dynamic home",
    );
  });

  // Review RV7466. B1: inside its block the name is the block binding, also under a local of the name (a catch
  // parameter). B2: a block home's storage key is one no source identifier can spell.
  it.each([
    [
      "is the block binding inside its block under a catch parameter of its name (call)",
      "var i; try { throw 'p'; } catch (f) { { function f() { return 3; } i = f(); } }",
      "i !== 3",
      "i !== 'p'",
    ],
    [
      "is the block binding inside its block under a catch parameter of its name (typeof)",
      "var i; try { throw 'p'; } catch (f) { { function f() {} i = typeof f; } }",
      "i !== 'function'",
      "i !== 'string'",
    ],
    [
      "in an if clause under a catch parameter of its name, reads its block binding inside its body only",
      "var i, j; try { throw 'p'; } catch (f) { if (true) function f() { return typeof f; } i = f; j = typeof f; }",
      "i !== 'p' || j !== 'string'",
      "i === 'p'",
    ],
    [
      "keeps its storage apart from a script var spelled like an internal name",
      "var f$block0 = 'u'; var f$block1 = 'v'; { function g() {} } { function f() { return 1; } } var res = f$block0 + f$block1 + typeof f;",
      "res !== 'uvfunction'",
      "res !== 'uvundefined'",
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

  // Review RV7466 B3: a reference with no checker symbol inside a function that binds the name itself is no reference
  // to the script's binding. Function-level Annex B is slice 2b: the function ends at its abort, never with the
  // script's value (node: "undefined").
  it("does not resolve a nested function's own block function to the script's", async () => {
    const source =
      "{ function f() { return 1; } } function g() { if (false) { function f() { return 2; } } return typeof f; } var res = g();";
    expect(runInNewContext(`${source} res`)).toBe("undefined");
    const result = await compile(source, preparedScriptOptions("test.js", TEST262_SCRIPT));
    expect(requiredPreparedEmission(result)).toBeDefined();
    expect(() => (instantiatePreparedArtifact(result).instance.exports.__module_init as () => void)()).toThrow(
      "unreachable",
    );
  });

  // Not modelled in 2a; each refuses by name instead of compiling to a wrong value.
  it.each([
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
