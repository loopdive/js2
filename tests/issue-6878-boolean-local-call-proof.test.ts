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

// These incoming-boundary controls extend, rather than replace, the original 29.
describe("#6878 incoming receiver-owned Number call evidence", () => {
  it.each([
    [
      "unknown receiver sharing a declared numeric class method name",
      "class Numeric { result() { return 7; } } function run(foreign) { var actual = foreign.result(); return actual; }",
    ],
    [
      "foreign method sharing an unrelated numeric local function name",
      "function result() { return 7; } function run(foreign) { var actual = foreign.result(); return actual; }",
    ],
    ["String result", "function result() { return '7'; } var actual = result();"],
    ["null result", "function result() { return null; } var actual = result();"],
  ])("declines %s", (_name, source) => {
    expect(analyze(source).numeric).toBe(false);
  });

  it.each([
    [
      "a freshly constructed receiver's own numeric method",
      "class Numeric { result() { return 7; } } var receiver = new Numeric(); var actual = receiver.result();",
    ],
    [
      "a fresh literal receiver's own numeric method",
      "var receiver = { result() { return 7; } }; var actual = receiver.result();",
    ],
  ])("retains %s", (_name, source) => {
    expect(analyze(source).numeric).toBe(true);
  });
});

// A member's original declaration does not certify a later replacement.
describe("#6878 incoming mutable member Number evidence", () => {
  it.each([
    [
      "direct replacement with a Boolean-returning function",
      "class Numeric { result() { return 7; } } function flag() { return true; } var receiver = new Numeric(); receiver.result = flag; var actual = receiver.result();",
    ],
    [
      "aliased replacement with a Boolean-returning function",
      "class Numeric { result() { return 7; } } function flag() { return true; } var receiver = new Numeric(); var alias = receiver; alias.result = flag; var actual = receiver.result();",
    ],
  ])("declines %s", (_name, source) => {
    expect(analyze(source).numeric).toBe(false);
  });
});

// These effects are outside the named-write pool; only the new local proof declines.
describe("#6878 incoming unobserved member effects", () => {
  it.each([
    ["computed replacement", "var key = 'result'; receiver[key] = flag;"],
    ["computed deletion", "var key = 'result'; delete receiver[key];"],
    ["Object.defineProperty replacement", "Object.defineProperty(receiver, 'result', { value: flag });"],
    ["Reflect.set replacement", "Reflect.set(receiver, 'result', flag);"],
    ["aliased Reflect.set replacement", "var write = Reflect.set; write(receiver, 'result', flag);"],
  ])("declines %s", (_name, mutation) => {
    const { numeric, verdicts } = analyze(`
      class Numeric { result() { return 7; } }
      function flag() { return true; }
      var receiver = new Numeric();
      ${mutation}
      var actual = receiver.result();
    `);
    expect(numeric).toBe(false);
    expect(verdicts.numericFunctions.has("result")).toBe(true);
  });

  it("declines an opaque mutator call without changing the arithmetic verdict", () => {
    const { numeric, verdicts } = analyze(`
      class Numeric { result() { return 7; } }
      function run(mutator) {
        var receiver = new Numeric();
        mutator(receiver);
        var actual = receiver.result();
        return actual;
      }
    `);
    expect(numeric).toBe(false);
    expect(verdicts.numericFunctions.has("result")).toBe(true);
  });
});

// A real host projection of the existing cross-module authority, not a fake verdict.
function analyzeOpenWorldMember(certified: boolean) {
  const fileName = "issue-6878-open-world-member.js";
  const sourceFile = ts.createSourceFile(
    fileName,
    "class Numeric { result() { return 7; } } var receiver = new Numeric(); var actual = receiver.result();",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const options: ts.CompilerOptions = { allowJs: true, noEmit: true };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName ? sourceFile : originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const oracle = createTypeOracle(ts.createProgram([fileName], options, host).getTypeChecker(), "checker");
  const method = (sourceFile.statements[0] as ts.ClassDeclaration).members[0] as ts.MethodDeclaration;
  const actual = (sourceFile.statements[2] as ts.VariableStatement).declarationList.declarations[0]!;
  expect(ts.isIdentifier(actual.name) && actual.name.text).toBe("actual");
  let certificateQueries = 0;
  const verdicts = analyzeNumericPropertyNames(
    {
      oracle,
      openWorldPropertyReads: true,
      ...(certified
        ? {
            provenNumericCallReturn: (call: ts.CallExpression) => {
              const declarations = oracle.declarationsOf(call.expression);
              const result = declarations.length === 1 && declarations[0] === method;
              if (result) certificateQueries++;
              return result;
            },
          }
        : {}),
    },
    [sourceFile],
  );
  return { numeric: verdicts.isNumericLocal(actual.name, "actual"), verdicts, certificateQueries };
}

describe("#6878 incoming open-world member authority", () => {
  it("declines an otherwise owned member when peer writes are unseen", () => {
    const { numeric, verdicts } = analyzeOpenWorldMember(false);
    expect(numeric).toBe(false);
    expect(verdicts.numericFunctions.has("result")).toBe(true);
  });

  it("retains a stronger exact declaration-resolved Number call certificate", () => {
    const { numeric, certificateQueries } = analyzeOpenWorldMember(true);
    expect(certificateQueries).toBeGreaterThan(0);
    expect(numeric).toBe(true);
  });
});

function analyzeTyped(source: string) {
  const fileName = "issue-6878-overload-proof.ts";
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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

// Exact source ownership must survive neither callable nor constructor rebinding.
describe("#6878 completed source-call effects", () => {
  it.each([
    [
      "a rebound source mutator",
      `class Numeric { result() { return 7; } }
      function mutate(value) {} mutate = external;
      var receiver = new Numeric(); mutate(receiver); var actual = receiver.result();`,
    ],
    [
      "a rebound constructor",
      `class Numeric { result() { return 7; } }
      Numeric = external; var receiver = new Numeric(); var actual = receiver.result();`,
    ],
  ])("declines %s", (_name, source) => {
    expect(analyze(source).numeric).toBe(false);
  });

  it.each([
    [
      "instance",
      `class Numeric {
      result(value: number): number;
      result(value: any) { return 7; }
    } var receiver = new Numeric(); var actual = receiver.result(0);`,
    ],
    [
      "static",
      `class Numeric {
      static result(value: number): number;
      static result(value: any) { return 7; }
    } var actual = Numeric.result(0);`,
    ],
  ])("retains the exact %s overload binding", (_name, source) => {
    expect(analyzeTyped(source).numeric).toBe(true);
  });
});

// AwaitUsing's composite flag must not classify a plain const as a disposal effect.
it("#6878 retains an actually fresh const receiver", () => {
  expect(
    analyze("class Numeric { result() { return 7; } } const receiver = new Numeric(); var actual = receiver.result();")
      .numeric,
  ).toBe(true);
});
