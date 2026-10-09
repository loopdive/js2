// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { createTypeOracle } from "../src/checker/oracle-backend.js";
import { analyzeNumericPropertyNames } from "../src/codegen/numeric-property-analysis.js";
import { compile } from "../src/index.js";

function analyze(source: string) {
  const fileName = "issue-6878-local-proof.js";
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const options: ts.CompilerOptions = { allowJs: true, noEmit: true };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName ? sourceFile : originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  const oracle = createTypeOracle(checker, "checker");
  const verdicts = analyzeNumericPropertyNames({ oracle }, [sourceFile]);
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "actual") {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  expect(declarations).toHaveLength(1);
  const declaration = declarations[0]!;
  expect(declaration.getSourceFile()).toBe(sourceFile);
  return { numeric: verdicts.isNumericLocal(declaration.name, "actual"), verdicts };
}

const identity = "function identity(value) { return value; }";
const remove = "function remove(value) { return delete value.p; }";

describe("#6878 L — Number-only call evidence for receiving locals", () => {
  it.each([
    ["direct delete return", `${remove} function run(obj) { var actual = remove(obj); return actual; }`],
    [
      "one identity hop",
      `${remove} ${identity} function run(obj) { var actual = identity(remove(obj)); return actual; }`,
    ],
    [
      "two identity hops",
      `${remove} ${identity} function forward(value) { return identity(value); }
       function run(obj) { var actual = forward(remove(obj)); return actual; }`,
    ],
    ["comparison return", "function predicate(x) { return x > 0; } var actual = predicate(1);"],
    ["Boolean literal return", "function predicate() { return true; } var actual = predicate();"],
    ["mixed Number/Boolean return", "function mixed(x) { if (x) return 7; return false; } var actual = mixed(1);"],
    ["unknown return", "function unknown(obj) { return obj.result(); } var actual = unknown({});"],
    ["return cycle", "function left() { return right(); } function right() { return left(); } var actual = left();"],
    ["fallthrough", "function maybe(value) { if (value) return 7; } var actual = maybe(false);"],
    [
      "same-spelled declarations in different scopes",
      `function first() { function result() { return 7; } var actual = result(); return actual; }
       function second() { function result() { return true; } return result(); }`,
    ],
    [
      "unknown identity argument alongside a numeric seed",
      `${identity} function run(obj) { identity(7); var actual = identity(obj.result()); return actual; }`,
    ],
    [
      "shadowed callable parameter",
      "function numeric() { return 7; } function run(numeric) { var actual = numeric(); return actual; }",
    ],
    ["reassigned declaration", "function numeric() { return 7; } numeric = unknown; var actual = numeric();"],
    [
      "duplicate declarations",
      "function numeric() { return 7; } function numeric() { return true; } var actual = numeric();",
    ],
    ["conditional block declaration", "if (condition) { function numeric() { return 7; } } var actual = numeric();"],
    ["standalone block declaration", "{ function numeric() { return 7; } } var actual = numeric();"],
  ])("declines %s", (_name, source) => {
    expect(analyze(source).numeric).toBe(false);
  });

  it.each([
    ["literal Number return", "function result() { return 7; } var actual = result();"],
    [
      "direct function-body declaration",
      "function run() { function numeric() { return 7; } var actual = numeric(); return actual; }",
    ],
    ["genuine Number conversion", "var actual = Number('7');"],
    ["Number identity", `${identity} var actual = identity(7);`],
    [
      "two Number identity hops",
      `${identity} function forward(value) { return identity(value); } var actual = forward(7);`,
    ],
    [
      "numeric accumulator through a call",
      "function next() { return 7; } function run() { var actual = 0; actual = actual + next(); return actual; }",
    ],
  ])("retains %s", (_name, source) => {
    expect(analyze(source).numeric).toBe(true);
  });

  it("does not globally filter the arithmetic-compatible function verdict", () => {
    const { numeric, verdicts } = analyze("function predicate() { return true; } var actual = predicate();");
    expect(numeric).toBe(false);
    // No excludeFunctionNames supplied: the pre-existing publication contract
    // keeps this arithmetic-compatible name. Only the local proof declines it.
    expect(verdicts.numericFunctions).toContain("predicate");
  });
});

function bodyOf(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `);
  expect(start, `missing real function ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = start; index < wat.length; index++) {
    if (wat[index] === "(") depth++;
    else if (wat[index] === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`incomplete real function ${name}`);
}

describe.each(["host", "standalone"] as const)("#6878 L live Boolean identity (%s)", (target) => {
  it.each([
    ["direct return", "remove(obj)"],
    ["one identity hop", "identity(remove(obj))"],
    ["two identity hops", "forward(remove(obj))"],
  ])("preserves %s in the actual receiving local", async (_name, expression) => {
    const source = `
      function booleanResult(value: any, expected: boolean): boolean {
        return value === expected && typeof value === "boolean";
      }
      function test(): number {
        function remove(value: any): any { return delete value.p; }
        function identity(value: any): any { return value; }
        function forward(value: any): any { return identity(value); }
        var obj: any = { p: 17 };
        var actual: any = ${expression};
        if (!booleanResult(actual, true)) return 141;
        if ("p" in obj) return 142;
        return 1;
      }
      var controlResult = test();
      if (controlResult !== 1) throw new Error("Control result: " + controlResult);
    `;
    const result = await compile(source, {
      fileName: "issue-6878-delete-result-boolean.ts",
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: false,
      deferTopLevelInit: true,
      emitWat: true,
      ...(target === "standalone" ? { target: "standalone" as const } : {}),
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
    const binary = new Uint8Array(result.binary);
    expect(WebAssembly.validate(binary)).toBe(true);
    const body = bodyOf(result.wat!, "test");
    expect(body).toMatch(/\(local \$actual externref\)/);
    expect(body).not.toMatch(/\(local \$actual f64\)/);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(binary, imports);
    (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect(typeof instance.exports.__module_init).toBe("function");
    expect(() => (instance.exports.__module_init as () => void)()).not.toThrow();
  });
});
