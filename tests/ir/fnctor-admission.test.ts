// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildIrUnitInventory } from "../../src/ir/identity.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../../src/ir/planning-identity.js";
import { ts } from "../../src/ts-api.js";
import { makeIrFnctorAdmissionResolver } from "../../src/codegen/ir-fnctor-admission.js";
import type { CodegenContext } from "../../src/codegen/context/types.js";

function fixture(text: string): {
  checker: ts.TypeChecker;
  file: ts.SourceFile;
  identity: IrPlanningIdentityContext;
} {
  const files = new Map([
    ["/repo/a.ts", text],
    ["/repo/lib.d.ts", "declare var undefined: undefined;"],
  ]);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noImplicitAny: false,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const source = files.get(fileName);
      return source === undefined
        ? undefined
        : ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(["/repo/a.ts"], options, host);
  const file = program.getSourceFile("/repo/a.ts")!;
  return {
    checker: program.getTypeChecker(),
    file,
    identity: buildIrPlanningIdentityContext(
      buildIrUnitInventory([file], { checker: program.getTypeChecker(), entrySource: file }),
    ),
  };
}

function findNew(file: ts.SourceFile): ts.NewExpression {
  let found: ts.NewExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isNewExpression(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error("fixture has no new expression");
  return found;
}

function resolverFor(text: string) {
  const { checker, file, identity } = fixture(text);
  const site = findNew(file);
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "Parser",
  )!;
  const gate = {
    approved: new Set([site]),
    approvedNames: new Set(["Parser"]),
    ctorDeclByName: new Map([["Parser", declaration]]),
    provenance: { refusedNames: [] },
  } as unknown as CodegenContext["fnctorEscapeGate"];
  const ctx = {
    fnctorEscapeGate: gate,
    fnctorReservedTypeIdx: new Map([["Parser", 7]]),
    structMap: new Map([["__fnctor_Parser", 7]]),
  } as unknown as CodegenContext;
  return { resolve: makeIrFnctorAdmissionResolver(ctx, checker, identity), site };
}

describe("#3521 source-qualified fnctor admission", () => {
  it("admits only the exact string-input constructor proof", () => {
    const { resolve, site } = resolverFor(`
      function Parser(input: string) { this.input = input; }
      function run(): string { return new Parser("x").input; }
    `);
    const admission = resolve(site);
    expect(admission?.constructorSite).toBe(site);
    expect(admission?.shape).toEqual({ kind: "fnctor-shape", fields: [{ name: "input", type: "string" }] });
    expect(admission?.proof.fixedUnconditionalInput).toBe(true);
  });

  it.each([
    ["conditional write", `function Parser(input: string) { if (input) this.input = input; }`],
    ["alias write", `function Parser(input: string) { const value = input; this.input = value; }`],
    ["additional field", `function Parser(input: string) { this.input = input; this.extra = 1; }`],
  ])("rejects %s", (_label, constructorBody) => {
    const { resolve, site } = resolverFor(`${constructorBody} function run() { return new Parser("x"); }`);
    expect(resolve(site)).toBeUndefined();
  });

  it("rejects a value that escapes through a call argument", () => {
    const { resolve, site } = resolverFor(`
      function Parser(input: string) { this.input = input; }
      function consume(value: unknown) { return value; }
      function run() { const parser = new Parser("x"); return consume(parser); }
    `);
    expect(resolve(site)).toBeUndefined();
  });

  it("does not forget an invalid use before a later member read", () => {
    const { resolve, site } = resolverFor(`
      function Parser(input: string) { this.input = input; }
      function consume(value: unknown) { return value; }
      function run() { const parser = new Parser("x"); consume(parser); return parser.input; }
    `);
    expect(resolve(site)).toBeUndefined();
  });

  it("ignores unrelated sibling functions while checking a local binding", () => {
    const { resolve, site } = resolverFor(`
      function Parser(input: string) { this.input = input; }
      function unrelated() { return 1; }
      function run() { const parser = new Parser("x"); return parser.input; }
    `);
    expect(resolve(site)).toBeDefined();
  });

  it.each([
    ["a default parameter", `function Parser(input: string = "x") { this.input = input; }`],
    [
      "a missing constructor argument",
      `function Parser(input: string) { this.input = input; } function run() { return new Parser().input; }`,
    ],
    [
      "a spread constructor argument",
      `function Parser(input: string) { this.input = input; } function run() { return new Parser(...["x"]).input; }`,
    ],
  ])("rejects %s", (_label, source) => {
    const { resolve, site } = resolverFor(
      source.includes("function run") ? source : `${source} function run() { return new Parser("x").input; }`,
    );
    expect(resolve(site)).toBeUndefined();
  });

  it("rejects a value captured by a nested function", () => {
    const { resolve, site } = resolverFor(`
      function Parser(input: string) { this.input = input; }
      function run() { const parser = new Parser("x"); return () => parser.input; }
    `);
    expect(resolve(site)).toBeUndefined();
  });
});
