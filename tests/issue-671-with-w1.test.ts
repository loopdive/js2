// #671 W1 — direct DeleteBinding through an ES5 `with` target.
//
// The W1 contract is decided in IR before allocation: a direct `delete name`
// needs the open-object MOP in both lanes so the runtime `HasBinding` /
// `DeleteBinding` path and later static-looking `target.name` reads observe the
// same identity. This deliberately does not claim aliases or broader escaping
// shapes; those remain explicit refusals for a later slice.
import { describe, expect, it } from "vitest";
import {
  bindingHasIrPlannedOpenWithTarget,
  bindingUsesOnlyIrPlannedOpenObjectOperations,
} from "../src/codegen/declarations/dynamic-with-shape.js";
import { planIrWithTarget } from "../src/ir/with-environment.js";
import { compile } from "../src/index.js";
import { forEachChild, ts } from "../src/ts-api.js";
import { wrapExports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

function withStatements(source: string): ts.WithStatement[] {
  const sourceFile = ts.createSourceFile("issue-671-w1.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found: ts.WithStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isWithStatement(node)) found.push(node);
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  return found;
}

function firstWithStatement(source: string): ts.WithStatement {
  const [found] = withStatements(source);
  if (!found) throw new Error("expected a with statement");
  return found;
}

function checkerFor(source: string): { sourceFile: ts.SourceFile; checker: ts.TypeChecker } {
  const fileName = "issue-671-w1-preclaim.js";
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
  };
  const program = ts.createProgram([fileName], { noLib: true, allowJs: true, checkJs: false, strict: false }, host);
  return { sourceFile: program.getSourceFile(fileName)!, checker: program.getTypeChecker() };
}

function declarationNamed(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  if (!found) throw new Error(`expected declaration for ${name}`);
  return found;
}

function isDirectPropertyReceiver(id: ts.Identifier): boolean {
  return ts.isPropertyAccessExpression(id.parent) && id.parent.expression === id;
}

async function run(
  source: string,
  target?: "standalone",
  deferTopLevelInit = false,
): Promise<Record<string, () => number>> {
  const result: any = await compile(source, {
    fileName: "issue-671-w1.ts",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    hostBridge: "always",
    ...(deferTopLevelInit ? { deferTopLevelInit: true } : {}),
    ...(target ? { target } : {}),
  } as any);
  expect(result.success, result.errors.map((error: { message: string }) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  if (deferTopLevelInit) {
    (instance.exports as { __module_init?: () => void }).__module_init?.();
  }
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#671 W1 — IR-owned direct DeleteBinding planning", () => {
  it("opens only a simple identifier target with a directly executing bare delete", () => {
    expect(planIrWithTarget(firstWithStatement("with ((target)) { delete (p); }"))).toEqual({
      representation: "open-object",
      reasons: ["runtime-has-binding", "runtime-delete-binding"],
    });

    expect(planIrWithTarget(firstWithStatement("with (target) { delete target.p; }"))).toEqual({
      representation: "closed-fields",
      reasons: [],
    });
    expect(planIrWithTarget(firstWithStatement("with (target) { function later() { delete p; } }"))).toEqual({
      representation: "closed-fields",
      reasons: [],
    });
    expect(planIrWithTarget(firstWithStatement("with (getTarget()) { delete p; }"))).toEqual({
      representation: "closed-fields",
      reasons: [],
    });

    // The inner DeleteBinding can cascade to the outer object environment, so
    // each synchronously active target needs the same open-object plan.
    expect(withStatements("with (outer) { with (inner) { delete p; } }").map(planIrWithTarget)).toEqual([
      { representation: "open-object", reasons: ["runtime-has-binding", "runtime-delete-binding"] },
      { representation: "open-object", reasons: ["runtime-has-binding", "runtime-delete-binding"] },
    ]);
  });
});

describe("#671 W1 — pre-allocation capture refusal", () => {
  it.each([
    ["nested ordinary function", "function later() { return target.p; }"],
    ["nested class method", "class Later { value() { return target.p; } }"],
  ])("declines a function-local target captured by a %s", (_kind, nestedUse) => {
    const { sourceFile, checker } = checkerFor(`
      function outer() {
        var target = { p: 1 };
        with (target) { delete p; }
        ${nestedUse}
      }
    `);
    const target = declarationNamed(sourceFile, "target");
    const outer = sourceFile.statements.find(ts.isFunctionDeclaration);
    expect(outer?.body).toBeDefined();
    const statements = outer!.body!.statements;

    // The language-level W1 trigger is present; only the pre-allocation ABI
    // proof rejects this capture shape.
    expect(bindingHasIrPlannedOpenWithTarget(statements, checker, target.name as ts.Identifier)).toBe(true);
    expect(
      bindingUsesOnlyIrPlannedOpenObjectOperations(
        checker,
        statements,
        target.name as ts.Identifier,
        isDirectPropertyReceiver,
        () => false,
      ),
    ).toBe(false);
  });

  it("allows a module target through its shared carrier in a nested ordinary function", () => {
    const { sourceFile, checker } = checkerFor(`
      var target = { p: 1 };
      function mutate() { with (target) { delete p; } }
      target.p;
    `);
    const target = declarationNamed(sourceFile, "target");

    expect(bindingHasIrPlannedOpenWithTarget(sourceFile.statements, checker, target.name as ts.Identifier)).toBe(true);
    expect(
      bindingUsesOnlyIrPlannedOpenObjectOperations(
        checker,
        sourceFile.statements,
        target.name as ts.Identifier,
        isDirectPropertyReceiver,
        () => false,
      ),
    ).toBe(true);
  });

  it("declines a for-in target consumer that W1 does not yet route through the open MOP", () => {
    const { sourceFile, checker } = checkerFor(`
      var target = { p: 1 };
      for (var key in target) {
        with (target) { delete p; }
      }
    `);
    const target = declarationNamed(sourceFile, "target");

    expect(bindingHasIrPlannedOpenWithTarget(sourceFile.statements, checker, target.name as ts.Identifier)).toBe(true);
    expect(
      bindingUsesOnlyIrPlannedOpenObjectOperations(
        checker,
        sourceFile.statements,
        target.name as ts.Identifier,
        isDirectPropertyReceiver,
        () => false,
      ),
    ).toBe(false);
  });
});

describe("#671 W1 — direct DeleteBinding readback", () => {
  const sameNameShadowSource = `
    function consume(value: { n: number }): number { return value.n; }
    function mutate(): number {
      var target = { p1: 1, p3: 3 };
      with (target) { delete p3; }
      return target.p3 === undefined ? 1 : 0;
    }
    export function test(): number {
      var target = { n: 7 };
      return mutate() * 10 + consume(target);
    }
  `;

  it.each([undefined, "standalone"] as const)(
    "does not widen an unrelated same-named struct consumer in the %s lane",
    async (target) => {
      const exports = await run(sameNameShadowSource, target);
      expect(exports.test()).toBe(17);
    },
  );

  const source = `
    export function test(): number {
      var target = {
        p1: 7,
        p2: "kept",
        p3: "deleted",
        valueOf: function (): number { return 29; },
        hook: function (n: number): number { return n + 31; },
      };
      var deleted = false;
      with (target) {
        p1 = 11;
        p2 = "changed";
        hook = function (n: number): number { return n + 41; };
        deleted = delete p3;
      }
      target.p2 = "directly changed";
      target.hook = function (n: number): number { return n + 47; };
      return deleted &&
        target.p1 === 11 &&
        target.p2 === "directly changed" &&
        target.p3 === undefined &&
        target.valueOf === target.valueOf &&
        target.valueOf() === 29 &&
        target.hook === target.hook &&
        target.hook(2) === 49
        ? 1
        : 0;
    }
  `;

  it.each([undefined, "standalone"] as const)("keeps a single open target identity in the %s lane", async (target) => {
    const exports = await run(source, target);
    expect(exports.test()).toBe(1);
  });

  const moduleTargetSource = `
    var target = {
      p1: 7,
      p2: "kept",
      p3: "deleted",
      valueOf: function (): number { return 29; },
      eval: function (): number { return 37; },
      hook: function (n: number): number { return n + 41; },
    };
    function mutate(): boolean {
      var deleted = false;
      with (target) {
        p1 = 11;
        p2 = "changed";
        hook = function (n: number): number { return n + 43; };
        deleted = delete p3;
      }
      return deleted;
    }
    export function test(): number {
      var mutated = mutate();
      target.p2 = "directly changed";
      target.hook = function (n: number): number { return n + 47; };
      return mutated &&
        target.p1 === 11 &&
        target.p2 === "directly changed" &&
        target.p3 === undefined &&
        target.valueOf === target.valueOf &&
        target.valueOf() === 29 &&
        target.eval === target.eval &&
        target.eval() === 37 &&
        target.hook === target.hook &&
        target.hook(2) === 49
        ? 1
        : 0;
    }
  `;

  it.each([undefined, "standalone"] as const)(
    "keeps a module target open when a nested ordinary function executes the with body in the %s lane",
    async (target) => {
      const exports = await run(moduleTargetSource, target);
      expect(exports.test()).toBe(1);
    },
  );

  const deferredModuleInitSource = `
    var target = {
      p1: "before",
      p2: "kept",
      p3: "deleted",
      hook: function (n: number): number { return n + 41; },
    };
    var deleted = false;
    var status = 0;
    with (target) {
      p1 = "after";
      p2 = "changed";
      hook = function (n: number): number { return n + 43; };
      deleted = delete p3;
    }
    target.p2 = "directly changed";
    target.hook = function (n: number): number { return n + 47; };
    status = deleted &&
      target.p1 === "after" &&
      target.p2 === "directly changed" &&
      target.p3 === undefined &&
      target.hook === target.hook &&
      target.hook(2) === 49
      ? 1
      : 0;
    export function test(): number { return status; }
  `;

  it.each([undefined, "standalone"] as const)(
    "keeps post-with strings and callable identity dynamic during deferred module init in the %s lane",
    async (target) => {
      const exports = await run(deferredModuleInitSource, target, true);
      expect(exports.test()).toBe(1);
    },
  );

  it("flips an authentic ES5 function-context DeleteBinding control on the host lane", async () => {
    const result = await runTest262File(
      "test262/test/language/statements/with/S12.10_A1.2_T1.js",
      "language/statements/with",
      120_000,
    );
    expect(result.status).toBe("pass");
  });
});
