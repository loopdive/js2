// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 lever S1 — a script `var` whose JS file declares properties on it is
// still one binding. The checker records the target of
// `Object.defineProperty(o, "p", …)` as a declaration of `o`, exactly as it
// records the expando target of `o.p = v`; both are the same `__mod_o` slot.
// (A `var` merged with a same-named function has no home: legacy's
// `scriptVarHome` declines it, which this resolver-level fixture stubs.)

import { describe, expect, it } from "vitest";

import { makeIrModuleBindingResolver } from "../src/ir/module-bindings.js";
import { ts } from "../src/ts-api.js";

/** The resolver's answer for the first top-level `var <name>` of a script, its legacy home `dynamic`. */
function resolvesScriptVar(source: string, name: string): boolean {
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, target: ts.ScriptTarget.ES2022 };
  const file = ts.createSourceFile("test.js", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (fileName) => (fileName === "test.js" ? file : undefined);
  const checker = ts.createProgram(["test.js"], options, host).getTypeChecker();
  const resolver = makeIrModuleBindingResolver(checker, {
    numberStorage: "f64",
    allowHostExterns: false,
    allowBuiltinMapExtern: false,
    scriptVarHome: () => "dynamic",
  });
  const declaration = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
  return resolver(declaration!.name as ts.Identifier) !== undefined;
}

describe("#7106 lever S1 — a JS property declaration is not a second binding", () => {
  it("binds a var that only declares itself", () => {
    expect(resolvesScriptVar("var obj = {};", "obj")).toBe(true);
  });
  it("binds a var with an expando property (`obj.p = v`)", () => {
    expect(resolvesScriptVar("var obj = {};\nobj.p = 1;", "obj")).toBe(true);
  });
  it("binds a var that is `Object.defineProperty`'s target", () => {
    expect(resolvesScriptVar('var obj = {};\nObject.defineProperty(obj, "length", { value: 1 });', "obj")).toBe(true);
  });
  it("binds a var with both spellings", () => {
    const source = 'var obj = {};\nObject.defineProperty(obj, "0", { value: 1 });\nobj[1] = 2;';
    expect(resolvesScriptVar(source, "obj")).toBe(true);
  });
  it("refuses a var that `Object.defineProperty(globalThis, …)` rebinds", () => {
    const source = 'var obj = {};\nObject.defineProperty(globalThis, "obj", { value: 1 });';
    expect(resolvesScriptVar(source, "obj")).toBe(false);
  });
});
