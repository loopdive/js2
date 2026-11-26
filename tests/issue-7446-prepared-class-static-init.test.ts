// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7446 — the Prepared path's `<module-init>` lowers the script's statements, not its class definitions, so a
// top-level class's static block or static field initializer was neither run nor refused: the program compiled and
// gave a wrong answer. The inventory already records the select-stage refusal (`static-class-initialization` on
// `<module-init>`); the Prepared producer now honours it.
import { describe, expect, it } from "vitest";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { preparedOptions, runPrepared } from "./helpers/prepared-node-agreement.js";

const refusal = async (source: string, unlowerableBodies: "abort" | "refuse") => {
  const result = await compile(source, preparedOptions() as Test262CompileOptions, undefined, unlowerableBodies);
  return { success: result.success, codes: result.errors.map((error) => error.code) };
};

describe("#7446 — Prepared path refuses class static initialization by name", () => {
  // Each program returns under node only if the static code ran; on main each compiled and threw or returned wrongly.
  it.each([
    ["an assignment to an outer var", "var n = 2; class C { static { n = 7; } } if (n !== 7) throw 0;"],
    ["a throw", "class C { static { throw 1; } }"],
    [
      "several blocks in order",
      "var s = ''; class C { static { s += 'a'; } static { s += 'b'; } } if (s !== 'ab') throw 0;",
    ],
    [
      "a block beside static fields",
      "var s = ''; class C { static x = (s += 'f'); static { s += 'b'; } } if (s !== 'fb') throw 0;",
    ],
    ["a block that reads this", "var t; class C { static { t = this; } } if (t !== C) throw 0;"],
    [
      "a nested class with its own block",
      "var s = ''; class A { static { s += 'a'; class B { static { s += 'b'; } } } } if (s !== 'ab') throw 0;",
    ],
    ["a static field initializer", "var n = 0; class C { static x = (n = 5); } if (n !== 5) throw 0;"],
    [
      "a call the path refuses elsewhere",
      "var o = {}; class C { static { Object.defineProperty(o, 'x', { value: 1 }); } } if (o.x !== 1) throw 0;",
    ],
  ])("%s", async (_label, source) => {
    for (const policy of ["abort", "refuse"] as const)
      expect(await refusal(source, policy)).toEqual({ success: false, codes: ["static-class-initialization"] });
  });

  // A class expression is not a class definition the inventory hoists: from-ast meets it in its statement and refuses.
  it("refuses a class expression with a static block", async () => {
    const result = await refusal("var n = 0; var K = class { static { n = 3; } }; if (n !== 3) throw 0;", "refuse");
    expect(result.success).toBe(false);
  });

  // A class whose definition only installs members runs no code, so the program still compiles and runs.
  it.each([
    ["an empty class", "var n = 1; class C {} if (n !== 1) throw 0;"],
    ["a static field without initializer", "var n = 1; class C { static x; } if (n !== 1) throw 0;"],
  ])("still runs %s", { timeout: 120_000 }, async (_label, source) => {
    expect(await runPrepared(source)).toBe("returned");
  });
});
