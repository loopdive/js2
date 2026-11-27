// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { compile } from "../src/test262/test262-prepared-entry.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";
import { unchangedUndeclaredGlobal } from "../src/ir/builtin-global-binding.js";
import { expect, it } from "vitest";
import { agreesWithNode, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";

it("reads inherited global methods as the same function objects as ordinary inherited methods", async () => {
  await agreesWithNode(
    "var o={};var out=typeof hasOwnProperty+','+(o.hasOwnProperty===hasOwnProperty)+','+(o.isPrototypeOf===isPrototypeOf)+','+(o.propertyIsEnumerable===propertyIsEnumerable);",
    true,
    runnerOptions(),
  );
}, 60000);

it("resolves a shadowing parameter first", async () => {
  await agreesWithNode("function f(hasOwnProperty){return typeof hasOwnProperty;}var out=f(1);", true, runnerOptions());
}, 60000);

it.each(["valueOf", "constructor", "toLocaleString", "$262"])(
  "keeps the realm or host name %s distinct from an absent name",
  async (name) => {
    expect(await refusal("if(typeof " + name + "!=='function')throw 1;", runnerOptions())).toContain(
      'identifier "' + name + '" is not in scope',
    );
  },
);

it("leaves an inherited name unresolved when the program might replace its property", async () => {
  expect(
    await refusal("var o={};if(typeof hasOwnProperty==='function')o.hasOwnProperty=1;", runnerOptions()),
  ).toContain('identifier "hasOwnProperty" is not in scope');
});

it("still evaluates typeof of a genuinely missing name", async () => {
  await agreesWithNode("var out=typeof nameMissingFromThisRealm;", true, runnerOptions());
}, 60000);

it.each([
  ["", true],
  ["var o={};o.other=7;", true],
  ["Object.prototype.foo=1;", false],
  ["var p=Object.prototype;p['foo']=1;", false],
  ["Object.defineProperty(Object.prototype,'foo',{value:undefined});", false],
  ["function install(key){this[key]=1;}", false],
])("checks whether the program can install a missing global before folding typeof: %s", (setup, expected) => {
  const ast = analyzeMultiSource({ "./entry.js": setup + "typeof foo;" }, "./entry.js", undefined, { allowJs: true });
  const stmt = ast.entryFile.statements.at(-1)!;
  if (
    !ts.isExpressionStatement(stmt) ||
    !ts.isTypeOfExpression(stmt.expression) ||
    !ts.isIdentifier(stmt.expression.expression)
  )
    throw new Error("expected a typeof identifier probe");
  expect(unchangedUndeclaredGlobal(stmt.expression.expression, ast.checker, ast.sourceFiles)).toBe(expected);
});

it.each(["Object.prototype.foo=1;", "Object.prototype[key]=1;"])(
  "keeps a possible prototype addition visible to typeof: %s",
  async (write) => {
    const source = "var out=typeof foo;function install(key){" + write + "}";
    const result = await compile(source, runnerOptions());
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message)).toContainEqual(
      expect.stringContaining('identifier "foo" is not in scope'),
    );
  },
);
