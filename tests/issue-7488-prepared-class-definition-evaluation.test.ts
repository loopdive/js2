// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7488 — the Prepared path's `<module-init>` lowers the script's statements, not its class definitions, so an
// unreferenced top-level class's `extends` expression, computed keys and decorators never ran: the program compiled
// and gave a wrong answer. The Prepared producer now refuses such a class at select, by name.
import { describe, expect, it } from "vitest";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { preparedOptions, runPrepared } from "./helpers/prepared-node-agreement.js";

// Semantic diagnostics off, as the test262 runner compiles: `extends 5` is a TypeScript type error, not an early error.
const options = (fileName = "test.js"): Test262CompileOptions => ({
  ...preparedOptions(),
  skipSemanticDiagnostics: true,
  fileName,
});

const refusal = async (source: string, unlowerableBodies: "abort" | "refuse", fileName?: string) => {
  const result = await compile(source, options(fileName), undefined, unlowerableBodies);
  return { success: result.success, codes: result.errors.map((error) => error.code) };
};

describe("#7488 — Prepared path refuses a top-level class definition that runs code", () => {
  // Each program's answer depends on code the class definition runs; on main each compiled and gave a wrong answer.
  it.each([
    ["an extends literal that throws, with no other code", "class C extends 5 {}"],
    ["an extends call", "var n = 0; function B() {} function g() { n = 1; return B; } class C extends g() {}"],
    ["an extends sequence to Object", "var n = 0; class C extends (n = 7, Object) {} if (n !== 7) throw 0;"],
    ["an extends sequence to null", "var n = 0; class C extends (n = 7, null) {} if (n !== 7) throw 0;"],
    ["an extends built-in", "class S extends Symbol {}"],
    ["a static field's computed key", "var n = 0; class C { static [(n = 1, 'x')]; } if (n !== 1) throw 0;"],
    ["an instance field's computed key", "var n = 0; class C { [(n = 1, 'x')]; } if (n !== 1) throw 0;"],
    ["a method's computed key", "var n = 0; class C { [(n = 1, 'x')]() {} } if (n !== 1) throw 0;"],
    ["a decorator", "var n = 0; function d() { n = 1; return () => {}; } @d() class C {} if (n !== 1) throw 0;"],
    ["a default-exported class with extends", "export default class extends (0, Object) {}"],
    // Crashes on main (#7500): the refusal runs before the export alias is planned.
    ["a named-exported class with extends", "export class C extends Object {}"],
  ])("%s", async (_label, source) => {
    for (const policy of ["abort", "refuse"] as const)
      expect(await refusal(source, policy)).toEqual({ success: false, codes: ["class-definition-evaluation"] });
  });

  it("names the class and what it evaluates", async () => {
    const result = await compile("class C extends (0, Object) {}", options(), undefined, "refuse");
    expect(result.errors[0]?.message).toContain("class C evaluates its extends clause at its definition");
  });

  // A class definition that runs no code still compiles and runs.
  it.each([
    ["an empty class", "var n = 1; class C {} if (n !== 1) throw 0;"],
    ["a static field without initializer", "var n = 1; class C { static x; } if (n !== 1) throw 0;"],
    ["literal computed keys", "var n = 1; class C { ['x']; static [1]; [`y`]; } if (n !== 1) throw 0;"],
  ])("still runs %s", { timeout: 120_000 }, async (_label, source) => {
    expect(await runPrepared(source, options())).toBe("returned");
  });

  // TypeScript-only forms that evaluate nothing: `implements` and `declare` classes.
  it.each([
    ["an implements clause", "interface I {} class C implements I {} var n = 1; if (n !== 1) throw 0;"],
    ["declare classes", "declare class B {} declare class C extends B {} var n = 1; if (n !== 1) throw 0;"],
  ])("still runs %s", { timeout: 120_000 }, async (_label, source) => {
    expect(await runPrepared(source, options("test.ts"))).toBe("returned");
  });
});
