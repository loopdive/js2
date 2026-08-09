import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  makeIrModuleBindingResolver,
  type IrLegacyModuleBindingResolver,
  type IrStableFunctionCallPlan,
} from "../src/ir/module-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { buildTypeMap } from "../src/ir/propagate.js";
import { planIrCompilation } from "../src/ir/select.js";
import { ts } from "../src/ts-api.js";

const MODULE_OPTIONS = {
  numberStorage: "f64",
  allowHostExterns: false,
  allowBuiltinMapExtern: false,
} as const;

const FINISH_NODE_AT = `
function finishNodeAt(node: any, type: any, pos: number, loc: any): any {
  node.type = type;
  node.end = pos;
  if (this.options.locations) {
    node.loc.end = loc;
  }
  if (this.options.ranges) {
    node.range[1] = pos;
  }
  return node;
}

export function finishNode(node: any, type: any, pos: number, loc: any): any {
  return finishNodeAt.call(this, node, type, pos, loc);
}

export function finishNodeAtWrapper(node: any, type: any, pos: number, loc: any): any {
  return finishNodeAt.call(this, node, type, pos, loc);
}
`;

interface Fixture {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly resolver: IrLegacyModuleBindingResolver;
}

function fixture(source: string, numberStorage: "f64" | "i32" = "f64", strict = false): Fixture {
  const fileName = "/repo/issue-3797.ts";
  const options: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    strict,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
    getSourceFile: (name, languageVersion) =>
      name === fileName ? ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.TS) : undefined,
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    directoryExists: (name) => name === "/repo",
    realpath: (name) => name,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName)!;
  const checker = program.getTypeChecker();
  return {
    sourceFile,
    checker,
    resolver: makeIrModuleBindingResolver(checker, { ...MODULE_OPTIONS, numberStorage }),
  };
}

function declaration(sourceFile: ts.SourceFile, name = "finishNodeAt"): ts.FunctionDeclaration {
  const node = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!node) throw new Error(`missing ${name}`);
  return node;
}

function stablePlan(
  source: string,
  numberStorage: "f64" | "i32" = "f64",
  strict = false,
): IrStableFunctionCallPlan | undefined {
  const graph = fixture(source, numberStorage, strict);
  return graph.resolver.stableFunctionCallPlan(declaration(graph.sourceFile));
}

function selectionFor(
  source: string,
  stableFunctionCallIntegrationBuildable = false,
): { readonly funcs: ReadonlySet<string>; readonly reason?: string } {
  const graph = fixture(source);
  const selection = planIrCompilation(
    graph.sourceFile,
    {
      experimentalIR: true,
      trackFallbacks: true,
      dynamicRuntimeBuildable: true,
      dynMemberReadBuildable: true,
      stableFunctionCallIntegrationBuildable,
      resolveModuleBinding: graph.resolver,
    },
    buildTypeMap(graph.sourceFile, graph.checker),
  );
  return {
    funcs: selection.funcs,
    reason: selection.fallbacks?.find((fallback) => fallback.name === "finishNodeAt")?.reason,
  };
}

describe("#3797 stable .call target proof", () => {
  it("certifies the exact four-parameter target and its complete two-site population", () => {
    const graph = fixture(FINISH_NODE_AT);
    const target = declaration(graph.sourceFile);
    const plan = graph.resolver.stableFunctionCallPlan(target);
    expect(plan).toBeDefined();
    expect(plan).toMatchObject({ declaration: target, targetName: "finishNodeAt", arity: 4 });
    expect(plan!.signature.getParameters()).toHaveLength(4);
    expect(plan!.callSites).toHaveLength(2);
    for (const site of plan!.callSites) {
      expect(site.call.arguments).toHaveLength(5);
      expect(site.receiver.kind).toBe(ts.SyntaxKind.ThisKeyword);
      expect(site.arguments).toHaveLength(4);
      expect(graph.resolver.stableFunctionCallPlan(site.call)?.declaration).toBe(target);
    }
  });

  it("is non-fast only", () => {
    expect(stablePlan(FINISH_NODE_AT, "f64")).toBeDefined();
    expect(stablePlan(FINISH_NODE_AT, "i32")).toBeUndefined();
  });

  it("attaches the exact Program inventory identities in production mode", () => {
    const graph = fixture(FINISH_NODE_AT);
    const target = declaration(graph.sourceFile);
    const inventory = buildIrUnitInventory([graph.sourceFile], {
      checker: graph.checker,
      entrySource: graph.sourceFile,
    });
    const context = buildIrPlanningIdentityContext(inventory);
    const resolver = makeIrModuleBindingResolver(graph.checker, MODULE_OPTIONS, context);
    const plan = resolver.stableFunctionCallPlan(target);
    expect(plan?.targetUnitId).toBe(context.unitIdByDeclaration.get(target));
    expect(plan?.sourceId).toBe(context.sourceIdBySourceFile.get(graph.sourceFile));
    for (const site of plan?.callSites ?? []) {
      expect(resolver.stableFunctionCallPlan(site.call)?.targetUnitId).toBe(plan!.targetUnitId);
    }
  });

  it("rejects an exported target because source-local scanning is not whole-program proof", () => {
    expect(
      stablePlan(FINISH_NODE_AT.replace("function finishNodeAt(", "export function finishNodeAt(")),
    ).toBeUndefined();
  });

  it("rejects a target exported through an export list", () => {
    expect(stablePlan(`${FINISH_NODE_AT}\nexport { finishNodeAt };`)).toBeUndefined();
  });

  it("rejects a global-script target whose reference population can extend across files", () => {
    expect(
      stablePlan(`
        function finishNodeAt(node: any, type: any, pos: number, loc: any): any {
          if (this.options.locations) node.loc.end = loc;
          return node;
        }
        function wrapper(node: any, type: any, pos: number, loc: any): any {
          return finishNodeAt.call(this, node, type, pos, loc);
        }
      `),
    ).toBeUndefined();
  });

  it("rejects a strict nullable receiver instead of trusting narrowed checker output", () => {
    expect(
      stablePlan(
        `
        function finishNodeAt(node: any, type: any, pos: number, loc: any): any {
          if (this.options.locations) node.loc.end = loc;
          return node;
        }
        export function wrapper(
          receiver: { options: { locations: boolean } } | null,
          node: any,
          type: any,
          pos: number,
          loc: any,
        ): any {
          return finishNodeAt.call(receiver, node, type, pos, loc);
        }
      `,
        "f64",
        true,
      ),
    ).toBeUndefined();
  });

  it("rejects an unconstrained type-parameter receiver", () => {
    expect(
      stablePlan(`
        function finishNodeAt(node: any, type: any, pos: number, loc: any): any {
          if (this.options.locations) node.loc.end = loc;
          return node;
        }
        export function wrapper<T>(receiver: T, node: any, type: any, pos: number, loc: any): any {
          return finishNodeAt.call(receiver, node, type, pos, loc);
        }
      `),
    ).toBeUndefined();
  });

  it.each([
    ["alias", `const alias = finishNodeAt;`],
    ["bare call", `finishNodeAt(node, type, pos, loc);`],
    ["reassignment", `finishNodeAt = function (node, type, pos, loc) { return node; };`],
    ["spread", `finishNodeAt.call(this, ...[node, type, pos, loc]);`],
    ["optional", `finishNodeAt.call?.(this, node, type, pos, loc);`],
    ["arity mismatch", `finishNodeAt.call(this, node, type, pos);`],
    ["bare call property", `const invoke = finishNodeAt.call;`],
    ["nullable receiver", `finishNodeAt.call(null, node, type, pos, loc);`],
    ["asserted-null receiver", `finishNodeAt.call(null as unknown as {}, node, type, pos, loc);`],
    [
      "nested asserted-null receiver",
      `const receiver: { parser: {} } | null = null; finishNodeAt.call((receiver as { parser: {} }).parser, node, type, pos, loc);`,
    ],
    [
      "non-null-asserted receiver",
      `const receiver: { options: {} } | null = null; finishNodeAt.call(receiver!, node, type, pos, loc);`,
    ],
    [
      "optional-chain receiver segment",
      `const receiver: { parser?: {} } = {}; finishNodeAt.call(receiver?.parser, node, type, pos, loc);`,
    ],
  ])("rejects %s references from the complete source population", (_label, reference) => {
    expect(
      stablePlan(`
        function finishNodeAt(node: any, type: any, pos: number, loc: any): any {
          if (this.options.locations) node.loc.end = loc;
          return node;
        }
        export function wrapper(node: any, type: any, pos: number, loc: any): any {
          ${reference}
          return node;
        }
      `),
    ).toBeUndefined();
  });

  it.each([
    ["bare this value", `const receiver = this;`],
    ["ambient-this write", `this.options = node;`],
    ["optional ambient-this read", `if (this?.options) node.type = type;`],
    ["nested optional ambient-this read", `if (this.options?.locations) node.type = type;`],
  ])("rejects %s outside admitted dynamic member-read roots", (_label, bodyUse) => {
    expect(
      stablePlan(`
        function finishNodeAt(node: any, type: any, pos: number, loc: any): any {
          ${bodyUse}
          return node;
        }
        export function wrapper(node: any, type: any, pos: number, loc: any): any {
          return finishNodeAt.call(this, node, type, pos, loc);
        }
      `),
    ).toBeUndefined();
  });
});

describe("#3797 finishNodeAt selector preclaim", () => {
  it("keeps the proof inert when the executable integration capability is absent", () => {
    const selected = selectionFor(FINISH_NODE_AT);
    expect(selected.funcs.has("finishNodeAt")).toBe(false);
    expect(selected.reason).toBeDefined();
  });

  it("admits the exact named and nested element stores without counting an integrated 33rd function", () => {
    const selected = selectionFor(FINISH_NODE_AT, true);
    expect(selected.funcs.has("finishNodeAt"), selected.reason).toBe(true);
  });

  it.each([
    ["assignment as value", `return (node.type = type);`],
    ["compound write", `node.end += pos; return node;`],
    ["optional write", `node?.type = type; return node;`],
    ["nullable receiver", `node.type = type; return node;`, `node: any | null`],
    ["unsupported receiver", `makeNode().type = type; return node;`],
  ])("rejects %s before claim", (_label, statement, firstParameter = "node: any") => {
    const selected = selectionFor(
      `
      function makeNode(): any { return {}; }
      function finishNodeAt(${firstParameter}, type: any, pos: number, loc: any): any {
        if (this.options.locations) node.loc.end = loc;
        ${statement}
      }
      export function wrapper(node: any, type: any, pos: number, loc: any): any {
        return finishNodeAt.call(this, node, type, pos, loc);
      }
    `,
      true,
    );
    expect(selected.funcs.has("finishNodeAt")).toBe(false);
    expect(selected.reason).toBeDefined();
  });

  it.each(["gc", "standalone"] as const)(
    "does not prematurely claim the target in a production %s compile",
    async (target) => {
      const result = await compile(
        `${FINISH_NODE_AT}
        export function knownIrPositive(value: number): number {
          return value + 1;
        }`,
        {
          fileName: `issue-3797-production-gate-${target}.ts`,
          target,
          skipSemanticDiagnostics: true,
          trackIrOutcomes: true,
        },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(result.irCompiledFuncs ?? []).toContain("knownIrPositive");
      expect(result.irCompiledFuncs ?? []).not.toContain("finishNodeAt");
    },
  );
});
