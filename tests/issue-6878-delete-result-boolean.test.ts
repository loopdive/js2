// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { analyzeNumericPropertyNames } from "../src/codegen/numeric-property-analysis.js";
import { ts } from "../src/ts-api.js";

const controls = [
  [
    "successful member delete through externref",
    `
    var obj: any = { p: 17 };
    var actual: any = delete obj.p;
    if (!booleanResult(actual, true)) return 11;
    if ("p" in obj || obj.p !== undefined) return 12;
  `,
  ],
  [
    "refused member delete through externref",
    `
    var obj: any = {};
    Object.defineProperty(obj, "p", { value: 17, configurable: false });
    var actual: any = delete obj.p;
    if (!booleanResult(actual, false)) return 21;
    if (!("p" in obj) || obj.p !== 17) return 22;
  `,
  ],
  [
    "successful computed delete through externref",
    `
    var obj: any = { p: 17 };
    var key: any = "p";
    var actual: any = delete obj[key];
    if (!booleanResult(actual, true)) return 31;
    if ("p" in obj || obj.p !== undefined) return 32;
  `,
  ],
  [
    "refused computed delete through externref",
    `
    var obj: any = {};
    Object.defineProperty(obj, "p", { value: 17, configurable: false });
    var key: any = "p";
    var actual: any = delete obj[key];
    if (!booleanResult(actual, false)) return 41;
    if (!("p" in obj) || obj.p !== 17) return 42;
  `,
  ],
  [
    "missing property delete stays Boolean and preserves siblings",
    `
    var obj: any = { sibling: 17 };
    var actual: any = delete obj.missing;
    if (!booleanResult(actual, true)) return 51;
    if ("missing" in obj || obj.sibling !== 17) return 52;
  `,
  ],
  [
    "side-effecting operand is evaluated exactly once",
    `
    var obj: any = { p: 17 };
    var count = 0;
    function receiver(): any { count++; return obj; }
    var actual: any = delete receiver().p;
    if (!booleanResult(actual, true) || count !== 1) return 61;
    if ("p" in obj) return 62;
  `,
  ],
  [
    "strict nonconfigurable delete retains TypeError identity",
    `
    "use strict";
    var obj: any = {};
    Object.defineProperty(obj, "p", { value: 17, configurable: false });
    var caught = false;
    try { delete obj.p; } catch (error) {
      caught = error instanceof TypeError && error.constructor === TypeError;
    }
    if (caught !== true || obj.p !== 17 || !("p" in obj)) return 71;
  `,
  ],
  [
    "receiver and computed key retain their once-only evaluation order",
    `
    var obj: any = { p: 17 };
    var trace = 0;
    function receiver(): any { trace = trace * 10 + 1; return obj; }
    function key(): string { trace = trace * 10 + 2; return "p"; }
    var actual: any = delete receiver()[key()];
    if (!booleanResult(actual, true) || trace !== 12) return 81;
    if ("p" in obj) return 82;
  `,
  ],
  [
    "bare with-identifier delete retains its existing Boolean brand",
    `
    var env: any = { p: 17 };
    var actual: any;
    with (env) { actual = delete p; }
    if (!booleanResult(actual, true) || "p" in env) return 91;
  `,
  ],
  [
    "pre-RHS reference capture writes Boolean while outer binding stays undefined",
    `
    var obj: any = { test262id: 1 };
    with (obj) { var test262id: any = delete obj.test262id; }
    if (!booleanResult(obj.test262id, true)) return 101;
    if (test262id !== undefined) return 102;
  `,
  ],
  [
    "a property created by the RHS cannot retarget the captured binding",
    `
    var env: any = {};
    with (env) { var actual: any = (env.actual = 17, delete env.missing); }
    if (!booleanResult(actual, true)) return 111;
    if (env.actual !== 17 || "missing" in env) return 112;
  `,
  ],
  [
    "nested with and unscopables preserve binding choice and Boolean result",
    `
    var outer: any = { result: 17 };
    var inner: any = { result: 23, p: 29 };
    inner[Symbol.unscopables] = { result: true };
    with (outer) { with (inner) { result = delete inner.p; } }
    if (!booleanResult(outer.result, true)) return 121;
    if (inner.result !== 23 || "p" in inner) return 122;
  `,
  ],
] as const;

async function run(body: string, target: "host" | "standalone"): Promise<unknown> {
  const result = await compile(
    `
    function booleanResult(value: any, expected: boolean): boolean {
      return value === expected && typeof value === "boolean";
    }
    function test(): number { ${body} return 1; }
    var controlResult = test();
    if (controlResult !== 1) throw new Error("Control result: " + controlResult);
  `,
    {
      fileName: "issue-6878-delete-result-boolean.ts",
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: false,
      deferTopLevelInit: true,
      ...(target === "standalone" ? { target: "standalone" as const } : {}),
    },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.binary.length).toBeGreaterThan(0);
  const binary = new Uint8Array(result.binary);
  expect(WebAssembly.validate(binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(binary, imports);
  // Bind the genuine instance so host struct operations have decoding authority.
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  expect(typeof instance.exports.__module_init).toBe("function");
  (instance.exports.__module_init as () => void)();
  return 1;
}

describe.each(["host", "standalone"] as const)("#6878 delete Boolean completion (%s)", (target) => {
  it.each(controls)("%s", async (_name, body) => {
    expect(await run(body, target)).toBe(1);
  });
});

// These are additional phase-II controls, not replacements for the frozen twelve bodies above.
function analyze(source: string) {
  const fileName = "issue-6878-carrier-analysis.ts";
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const options: ts.CompilerOptions = { noLib: true, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName ? sourceFile : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  const declarations: ts.VariableDeclaration[] = [];
  let deletes = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "actual") {
      declarations.push(node);
    }
    if (ts.isDeleteExpression(node)) {
      deletes++;
      expect(checker.getTypeAtLocation(node).flags & ts.TypeFlags.BooleanLike).not.toBe(0);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  expect(deletes).toBeGreaterThan(0);
  const verdicts = analyzeNumericPropertyNames(
    {
      oracle: {
        typeFactOf: (node) => {
          const flags = checker.getTypeAtLocation(node).flags;
          return {
            kind: flags & ts.TypeFlags.NumberLike ? "number" : flags & ts.TypeFlags.BooleanLike ? "boolean" : "any",
          };
        },
      },
    },
    [sourceFile],
  );
  return { declarations, verdicts };
}

describe("#6878 phase-II real carrier analysis", () => {
  it.each(["delete obj.p", "(delete obj.p)", "(delete obj.p) as any"])(
    "withholds a numeric local for %s",
    (initializer) => {
      const { declarations, verdicts } = analyze(
        `function test(obj: any) { var actual: any = ${initializer}; return actual; }`,
      );
      expect(declarations).toHaveLength(1);
      expect(verdicts.isNumericLocal(declarations[0]!, "actual")).toBe(false);
    },
  );

  it("withholds a mixed number/delete local", () => {
    const { declarations, verdicts } = analyze(
      "function test(obj: any) { var actual: any = 7; actual = delete obj.p; return actual; }",
    );
    expect(declarations).toHaveLength(1);
    expect(verdicts.isNumericLocal(declarations[0]!, "actual")).toBe(false);
  });

  it("retains the genuine number produced by unary plus over delete", () => {
    const { declarations, verdicts } = analyze(
      "function test(obj: any) { var actual = +(delete obj.p); return actual; }",
    );
    expect(declarations).toHaveLength(1);
    expect(verdicts.isNumericLocal(declarations[0]!, "actual")).toBe(true);
  });

  it("keeps same-spelled numeric and delete locals in separate function frames", () => {
    const { declarations, verdicts } = analyze(`
      function numeric() { var actual = 7; return actual; }
      function boolean(obj: any) { var actual: any = delete obj.p; return actual; }
    `);
    expect(declarations).toHaveLength(2);
    expect(declarations.map((node) => verdicts.isNumericLocal(node, "actual"))).toEqual([true, false]);
  });
});

const adjacentControls = [
  [
    "property-write delete preserves strict Boolean identity",
    `
    var obj: any = { p: 17 };
    var holder: any = { result: 23 };
    holder.result = delete obj.p;
    if (!booleanResult(holder.result, true)) return 131;
    if ("p" in obj) return 132;
  `,
  ],
  [
    "ordinary return and parameter keep delete Boolean identity",
    `
    function remove(value: any): any { return delete value.p; }
    function identity(value: any): any { return value; }
    var obj: any = { p: 17 };
    var actual: any = identity(remove(obj));
    if (!booleanResult(actual, true)) return 141;
    if ("p" in obj) return 142;
  `,
  ],
  [
    "successful and refused delete still support numeric arithmetic",
    `
    var obj: any = { p: 17 };
    Object.defineProperty(obj, "fixed", { value: 23, configurable: false });
    var yes: any = delete obj.p;
    var no: any = delete obj.fixed;
    if (!booleanResult(yes, true) || !booleanResult(no, false)) return 151;
    var one = +yes;
    var zero = +no;
    if (one !== 1 || zero !== 0 || typeof one !== "number" || typeof zero !== "number") return 152;
    if (yes + 0 !== 1 || no + 0 !== 0 || obj.fixed !== 23 || !("fixed" in obj)) return 153;
  `,
  ],
] as const;

describe.each(["host", "standalone"] as const)("#6878 phase-II adjacent runtime (%s)", (target) => {
  it.each(adjacentControls)("%s", async (_name, body) => {
    expect(await run(body, target)).toBe(1);
  });
});
