// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice T — a write to a named function expression's own name. The name is an immutable binding (§9.1.1.1.5):
// sloppy code ignores the write, strict code throws a TypeError. from-ast took such a write for a broken promise of
// the mutation pre-pass and threw an Error out of compile() (`var f = function nm(){ nm = 1; }; f();` on the base; and,
// once IIFEs ran, `(function nm(){ nm = 1; })();`). It is now refused by name: the function's abort body under the
// test262 entry, never an exception and never a wrong value.
import { describe, expect, it } from "vitest";
import { abortBodies, refusal } from "./helpers/prepared-node-agreement.js";

const NAME = (name: string) => `ir/from-ast: write to the function expression name "${name}"`;

describe("#7354 T — a write to a function expression's own name", () => {
  it.each([
    ["an assignment, sloppy", "nm = 1;"],
    ["an assignment, strict", '"use strict"; nm = 1;'],
    ["a compound assignment", "nm += 1;"],
    ["an increment", "nm++;"],
  ])("refuses %s by name, through a variable and as an IIFE", async (_label, write) => {
    const body = `${write} return typeof nm;`;
    expect(await refusal(`var f = function nm() { ${body} };\nvar out = f();\n`)).toContain(NAME("nm"));
    expect(await refusal(`var out = (function nm() { ${body} })();\n`)).toContain(NAME("nm"));
  });

  it("gives the function the abort body under the test262 entry; the rest of the program compiles", async () => {
    expect(
      await abortBodies('var out = "";\n(function nm() { nm = 1; out = typeof nm; })();\nout = out + "!";'),
    ).toEqual([`<module-init>__closure_0: ${NAME("nm")}`]);
  });
});
