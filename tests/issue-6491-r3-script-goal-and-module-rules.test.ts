// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6491 round 3 — the Script-goal signal, and six more early-error rules.
//
// Round 2 left 15 rows unfixed; 13 of them fall to the rules below. The one
// structural addition is `scriptGoal`: round 2 could not implement the three
// Script-goal rules because `moduleGoal === false` is ALSO what every product
// compile leaves behind, so the negation would reject valid `export`s. The
// runner is the one caller that knows the goal, and it now says so explicitly.
//
// Every case is a PAIR — the violating source rejected, a legal sibling clean.

import { describe, expect, it } from "vitest";

import { ts } from "../src/ts-api.js";
import { detectEarlyErrors } from "../src/compiler/early-errors/index.js";
import { isModuleGoal, isScriptGoal } from "../scripts/test262-module-goal.mjs";

function errorsFor(source: string, opts: { moduleGoal?: boolean; scriptGoal?: boolean } = {}): string[] {
  const sf = ts.createSourceFile("t.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return detectEarlyErrors(sf, opts)
    .filter((e) => e.severity !== "warning")
    .map((e) => e.message);
}

const rejects = (source: string, opts: { moduleGoal?: boolean; scriptGoal?: boolean } = {}): boolean =>
  errorsFor(source, opts).length > 0;

describe("#6491 r3 — `isScriptGoal` reads METADATA, never syntax", () => {
  it("is not the negation of isModuleGoal, and that is the point", () => {
    // `global-code/export.js` is a SCRIPT test whose body is `export default
    // null;` precisely because that is illegal in a Script. `isModuleGoal`'s
    // syntax fallback calls it a module — so `!isModuleGoal(...)` would answer
    // "not a Script" for the very row the rule exists to catch.
    const src = "export default null;\n";
    expect(isModuleGoal("language/global-code", { flags: [] }, src)).toBe(true);
    expect(isScriptGoal("language/global-code", { flags: [] })).toBe(true);
  });

  it("declines for module-flagged tests, module-only paths and raw tests", () => {
    expect(isScriptGoal("language/expressions/import.meta", { flags: ["module"] })).toBe(false);
    expect(isScriptGoal("language/module-code", { flags: [] })).toBe(false);
    expect(isScriptGoal("language/import", { flags: [] })).toBe(false);
    expect(isScriptGoal("language/export", { flags: [] })).toBe(false);
    expect(isScriptGoal("language/statements", { flags: ["raw"] })).toBe(false);
  });
});

describe("#6491 r3 — ModuleItems in a Script (§16.1.1 / §13.3.12.1)", () => {
  it("rejects import/export/import.meta ONLY under an explicit script goal", () => {
    for (const source of [
      "export default null;",
      'import v from "./m.js";',
      "import.meta;",
      "export function f() {}",
      "export var x = 1;",
    ]) {
      expect(rejects(source, { scriptGoal: true })).toBe(true);
      // Goal unstated — the state of every product compile. Must stay clean.
      expect(rejects(source, {})).toBe(false);
      expect(rejects(source, { moduleGoal: true })).toBe(false);
    }
  });

  it("leaves a Script's ordinary code alone", () => {
    expect(rejects('var x = 1; function f() { return import("./m.js"); }', { scriptGoal: true })).toBe(false);
  });
});

describe("#6491 r3 — `await`/`arguments` in a class static block (§15.7.1)", () => {
  it("rejects the identifier-shaped cases the AwaitExpression rule cannot see", () => {
    expect(rejects("class C { static { function await() {} } }")).toBe(true);
    expect(rejects("class C { static { ((x = await) => 0); } }")).toBe(true);
    expect(rejects("class C { static { (class { [arguments]() {} }); } }")).toBe(true);
  });

  it("keeps a nested function's own `arguments` legal", () => {
    // An ordinary function inside the block introduces its own `arguments`.
    expect(rejects("class C { static { function f() { return arguments; } } }")).toBe(false);
    expect(rejects("class C { static { let x = 1; } }")).toBe(false);
  });

  it("does NOT reach a function EXPRESSION's own name or parameters", () => {
    // `expressions/generators/static-init-await-binding.js` — legal, and the
    // honest slice caught this as a real regression when the rule flagged it:
    // a function expression's BindingIdentifier is bound inside the function,
    // and its parameters belong to the function, so neither is "contained by"
    // the static block.
    expect(rejects("class C { static { (function * await (await) {}); } }")).toBe(false);
  });
});

describe("#6491 r3 — a generator expression may not be named `yield` (§15.5.1)", () => {
  it("rejects the expression form and leaves declarations and other names alone", () => {
    expect(rejects("var g = function* yield() {};")).toBe(true);
    expect(rejects("(async function* yield() {});")).toBe(true);
    expect(rejects("var g = function* gen() { yield 1; };")).toBe(false);
    // A DECLARATION binds its name in the enclosing scope, where the
    // reservation does not apply — deliberately not flagged.
    expect(rejects("function* yield() {}")).toBe(false);
  });
});

describe("#6491 r3 — module export clauses (§16.2.3.1)", () => {
  it("rejects an export of a name the module does not declare", () => {
    expect(rejects("export { Number };", { moduleGoal: true })).toBe(true);
    expect(rejects("export { unresolvable };", { moduleGoal: true })).toBe(true);
  });

  it("accepts every way a name CAN be declared, and re-exports", () => {
    expect(rejects("var x = 1; function f() {} class C {} export { x, f, C };", { moduleGoal: true })).toBe(false);
    expect(rejects('import { q } from "./m.js"; export { q };', { moduleGoal: true })).toBe(false);
    expect(rejects('import * as ns from "./m.js"; export { ns };', { moduleGoal: true })).toBe(false);
    expect(rejects("let a = 1; const b = 2; export { a as x, b as y };", { moduleGoal: true })).toBe(false);
    // A re-export names the OTHER module's bindings — nothing local to check.
    expect(rejects('export { a, b } from "./m.js";', { moduleGoal: true })).toBe(false);
  });

  it("rejects a string local name without a `from` clause", () => {
    expect(rejects('export { "foo" as "bar" }\nfunction foo() {}', { moduleGoal: true })).toBe(true);
    expect(rejects('export { "foo" as "bar" } from "./m.js";', { moduleGoal: true })).toBe(false);
  });
});

describe("#6491 r3 — `for (let in o)` in strict code (§14.7.5.1)", () => {
  it("rejects the bare `let` reference only in strict code", () => {
    expect(rejects('"use strict"; var o = {}; for (let in o) {}')).toBe(true);
    expect(rejects("var o = {}; for (let in o) {}")).toBe(false);
    expect(rejects('"use strict"; var o = {}; for (let x in o) {}')).toBe(false);
  });
});

describe("#6491 r3 — `using` is a lexical declaration (§14.3.1)", () => {
  it("conflicts with a `var` of the same name in the same block", () => {
    expect(rejects('(function() { "use strict"; { using f = null; var f; } })')).toBe(true);
    expect(rejects('(function() { "use strict"; { using f = null; var g; } })')).toBe(false);
  });

  it("is not miscounted as a VAR name", () => {
    // The negated flag test used to call `using` a VAR. Inside a block that
    // makes `using f` a var-declared name, which would wrongly collide with a
    // `let` of the same name — and would NOT collide with the `var` it really
    // conflicts with. Both directions are checked here.
    expect(rejects("{ using f = null; var f; }")).toBe(true);
    expect(rejects("{ using f = null; var g; }")).toBe(false);
    expect(rejects("{ using f = null; let g = 1; }")).toBe(false);
  });
});
