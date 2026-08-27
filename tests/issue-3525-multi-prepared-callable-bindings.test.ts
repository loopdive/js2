// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeMultiSource } from "../src/checker/index.js";
import { generateMultiModule } from "../src/codegen/index.js";
import { resolvePreparedFunctionBodyRoute } from "../src/codegen/declarations.js";
import { compileMulti } from "../src/index.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import {
  buildIrProgramCallableBindingGraph,
  IrProgramCallableBindingInvariantError,
} from "../src/ir/program-callable-bindings.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

interface GraphFixture {
  readonly ast: ReturnType<typeof analyzeMultiSource>;
  readonly identity: IrPlanningIdentityContext;
  readonly graph: ReturnType<typeof buildIrProgramCallableBindingGraph>;
}

function makeGraph(files: Record<string, string>, entryFile: string): GraphFixture {
  const ast = analyzeMultiSource(files, entryFile);
  const inventory = buildIrUnitInventory(ast.sourceFiles, {
    checker: ast.checker,
    entrySource: ast.entryFile,
  });
  const identity = buildIrPlanningIdentityContext(inventory);
  const graph = buildIrProgramCallableBindingGraph({
    checker: ast.checker,
    sourceFiles: ast.sourceFiles,
    identityContext: identity,
  });
  return { ast, identity, graph };
}

function functionUnitId(fixture: GraphFixture, fileName: string, name: string): string {
  const normalizedFileName = fileName.replace(/^\/+/, "");
  const source = fixture.ast.sourceFiles.find(
    (candidate) => candidate.fileName === fileName || candidate.fileName.replace(/^\.?\//, "") === normalizedFileName,
  );
  expect(source).toBeDefined();
  const declaration = source!.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && (statement.name?.text ?? "default") === name && !!statement.body,
  );
  expect(declaration).toBeDefined();
  return fixture.identity.unitIdByDeclaration.get(declaration!)!;
}

function useSignature(fixture: GraphFixture): readonly string[] {
  return fixture.graph.uses.map((use) => {
    const callee = use.node.expression.getText();
    return `${use.sourceId}|${use.ownerUnitId}|${callee}|${use.targetUnitId}|${use.bindingId}|${use.canonicalBindingId}`;
  });
}

const ALIAS_FILES = {
  "./a.ts": `
    export function same(value: number): number { return value; }
    export function only(value: number): number { return value + 1; }
    export default function (value: number): number { return value + 2; }
    export { same as renamed };
  `,
  "./b.ts": `
    import defaultFn, { same as localSame, renamed as reexported } from "./a";
    import * as ns from "./a";
    export { renamed as chained } from "./a";
    export * from "./a";
    export function same(value: number): number { return value + 100; }
    export function invoke(value: number): number {
      return localSame(value) + defaultFn(value) + ns.same(value) + reexported(value);
    }
  `,
  "./entry.ts": `
    import { invoke as call, chained, same as entrySame } from "./b";
    export function entry(value: number): number {
      return call(value) + chained(value) + entrySame(value);
    }
  `,
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#3525 whole-program callable binding graph", () => {
  it("prepares one exact cross-source component before direct bodies", async () => {
    const files = {
      "./dep.ts": `
        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
      "./entry.ts": `
        import { add as plus } from "./dep";
        export function run(value: number): number {
          return plus(value, 2);
        }
      `,
    };
    const options = {
      experimentalIR: true,
      nativeStrings: true,
      target: "standalone" as const,
      trackIrOutcomes: true,
    };
    const fixture = makeGraph(files, "./entry.ts");
    const expectedUnitIds = new Set([
      functionUnitId(fixture, "/dep.ts", "add"),
      functionUnitId(fixture, "/entry.ts", "run"),
    ]);
    const generated = generateMultiModule(analyzeMultiSource(files, "./entry.ts"), options);
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    expect(generated.multiPreparedProgramAudit?.bodyPlan.reservations).toHaveLength(2);
    expect(new Set(generated.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ unitId }) => unitId))).toEqual(
      expectedUnitIds,
    );
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "add,run");
    const ir = await compileMulti(files, "./entry.ts", options);
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "");
    const legacy = await compileMulti(files, "./entry.ts", {
      experimentalIR: false,
      nativeStrings: true,
      target: "standalone",
    });
    expect(ir.success, ir.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(legacy.success, legacy.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(new Set(ir.irCompiledFuncs ?? [])).toEqual(new Set(["add", "run"]));
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    const preparedOutcomes = ir.irOutcomes?.filter((outcome) => outcome.irBodyEmitted) ?? [];
    const preparedUnitIds = new Set(preparedOutcomes.map((outcome) => outcome.unitId));
    expect(preparedOutcomes).toHaveLength(2);
    expect(preparedUnitIds).toEqual(expectedUnitIds);
    expect(new Set(preparedOutcomes.map((outcome) => outcome.preparedComponentId)).size).toBe(1);
    expect(preparedOutcomes[0]?.preparedComponentId).toMatch(/^prepared-component:/);
    expect(
      ir.irBodyRouteAudit?.legacyEntries.filter(
        (entry) => entry.unitId !== undefined && preparedUnitIds.has(entry.unitId),
      ),
    ).toEqual([]);
    expect(
      ir.irBodyRouteAudit?.dispositions
        .filter((entry) => preparedUnitIds.has(entry.unitId))
        .every((entry) => entry.disposition === "terminal-ir"),
    ).toBe(true);
    const irExports = (await instantiateWithRuntime(ir)).exports as unknown as { run(value: number): number };
    const legacyExports = (await instantiateWithRuntime(legacy)).exports as unknown as { run(value: number): number };
    expect(irExports.run(5)).toBe(legacyExports.run(5));
    expect(irExports.run(5)).toBe(7);
  }, 120_000);

  it("honors an explicit env=0 direct route and preserves clean runtime parity", async () => {
    const files = {
      "./dep.ts": `
        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
      "./entry.ts": `
        import { add as plus } from "./dep";
        export function run(value: number): number {
          return plus(value, 2);
        }
      `,
    };
    const options = {
      experimentalIR: true,
      nativeStrings: true,
      target: "standalone" as const,
      trackIrOutcomes: true,
    };
    vi.stubEnv("JS2WASM_MULTI_PREPARED_CALLABLE_COMPONENT_CUTOVER", "0");
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "add,run");
    const poisoned = await compileMulti(files, "./entry.ts", options);
    const poisonMessages = poisoned.errors.map((error) => error.message).join("\n");
    expect(poisoned.success).toBe(false);
    expect(poisonMessages).toContain("injected direct function-body poison: add");
    expect(poisonMessages).toContain("injected direct function-body poison: run");

    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "");
    const direct = await compileMulti(files, "./entry.ts", options);
    const legacy = await compileMulti(files, "./entry.ts", {
      experimentalIR: false,
      nativeStrings: true,
      target: "standalone",
    });
    expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(legacy.success, legacy.errors.map((error) => error.message).join("\n")).toBe(true);
    const directExports = (await instantiateWithRuntime(direct)).exports as unknown as {
      run(value: number): number;
    };
    const legacyExports = (await instantiateWithRuntime(legacy)).exports as unknown as {
      run(value: number): number;
    };
    expect(directExports.run(5)).toBe(legacyExports.run(5));
    expect(directExports.run(5)).toBe(7);
  }, 120_000);

  it("rejects a matching legacy name when the source-qualified unit projection disagrees", () => {
    const reservedUnit = "unit:source-a:shared" as IrUnitId;
    const foreignUnit = "unit:source-b:shared" as IrUnitId;
    const routing = {
      skipBodyUnitIds: new Set([reservedUnit]),
      preserveSkippedBodyUnitIds: new Set([reservedUnit]),
      skippedUnitIds: [],
    };
    expect(
      resolvePreparedFunctionBodyRoute({
        sourceFileName: "source-a.ts",
        functionName: "shared",
        unitId: reservedUnit,
        skipBodies: new Set(["shared"]),
        preserveSkippedBodies: new Set(["shared"]),
        routing,
      }),
    ).toEqual({ skip: true, preserve: true });
    expect(() =>
      resolvePreparedFunctionBodyRoute({
        sourceFileName: "source-b.ts",
        functionName: "shared",
        unitId: foreignUnit,
        skipBodies: new Set(["shared"]),
        preserveSkippedBodies: new Set(["shared"]),
        routing,
      }),
    ).toThrow(/routing disagrees/);
  });

  it("resolves renamed/default/namespace/re-export calls to exact units", () => {
    const fixture = makeGraph(ALIAS_FILES, "./entry.ts");
    const aSame = functionUnitId(fixture, "/a.ts", "same");
    const aDefault = functionUnitId(fixture, "/a.ts", "default");
    const bSame = functionUnitId(fixture, "/b.ts", "same");
    const bInvoke = functionUnitId(fixture, "/b.ts", "invoke");
    const entry = functionUnitId(fixture, "/entry.ts", "entry");

    expect(fixture.graph.schema).toBe("ir-program-callable-binding-graph-v1");
    expect(fixture.graph.sourceIds).toEqual(fixture.identity.inventory.sources.map((source) => source.id));
    expect(
      fixture.graph.records.filter((record) => record.kind === "source").map((record) => record.targetUnitId),
    ).toEqual([aSame, functionUnitId(fixture, "/a.ts", "only"), aDefault, bSame, bInvoke, entry]);

    const bUses = fixture.graph.uses.filter((use) => use.ownerUnitId === bInvoke);
    expect(bUses).toHaveLength(4);
    expect(bUses.map((use) => [use.node.expression.getText(), use.targetUnitId])).toEqual([
      ["localSame", aSame],
      ["defaultFn", aDefault],
      ["ns.same", aSame],
      ["reexported", aSame],
    ]);

    const entryUses = fixture.graph.uses.filter((use) => use.ownerUnitId === entry);
    expect(entryUses).toHaveLength(3);
    expect(entryUses.map((use) => [use.node.expression.getText(), use.targetUnitId])).toEqual([
      ["call", bInvoke],
      ["chained", aSame],
      ["entrySame", bSame],
    ]);

    const localSameUse = bUses.find((use) => use.node.expression.getText() === "localSame")!;
    expect(fixture.graph.resolveCall(localSameUse.node, bInvoke)).toBe(localSameUse);
    expect(fixture.graph.resolveCall(localSameUse.node, entry)).toBeUndefined();
    expect(new Set(fixture.graph.records.map((record) => record.bindingId)).size).toBe(fixture.graph.records.length);
    expect(Object.isFrozen(fixture.graph)).toBe(true);
    expect(Object.isFrozen(fixture.graph.records)).toBe(true);
    expect(Object.isFrozen(fixture.graph.uses)).toBe(true);
  });

  it("keeps record and use order independent of caller source insertion order", () => {
    const first = makeGraph(ALIAS_FILES, "./entry.ts");
    const reversedAst = analyzeMultiSource(
      {
        "./entry.ts": ALIAS_FILES["./entry.ts"],
        "./b.ts": ALIAS_FILES["./b.ts"],
        "./a.ts": ALIAS_FILES["./a.ts"],
      },
      "./entry.ts",
    );
    const reversedInventory = buildIrUnitInventory(reversedAst.sourceFiles, {
      checker: reversedAst.checker,
      entrySource: reversedAst.entryFile,
    });
    const reversedIdentity = buildIrPlanningIdentityContext(reversedInventory);
    const second = buildIrProgramCallableBindingGraph({
      checker: reversedAst.checker,
      sourceFiles: [...reversedAst.sourceFiles].reverse(),
      identityContext: reversedIdentity,
    });

    expect(second.sourceIds).toEqual(first.graph.sourceIds);
    expect(second.records).toEqual(first.graph.records);
    expect(useSignature({ ast: reversedAst, identity: reversedIdentity, graph: second })).toEqual(useSignature(first));
  });

  it("declines mutable, value-escaped, optional, dynamic, and overloaded call sites", () => {
    const fixture = makeGraph(
      {
        "./dep.ts": `
          export function mutable(value: number): number { return value; }
          mutable = (value: number) => value + 1;
          export function overloaded(value: number): number;
          export function overloaded(value: string): number;
          export function overloaded(value: number | string): number { return 1; }
        `,
        "./entry.ts": `
          import { mutable, overloaded } from "./dep";
          import * as ns from "./dep";
          const escaped = overloaded;
          export function entry(value: number): number {
            return mutable?.(value) + ns["mutable"](value) + escaped(value) + overloaded(value);
          }
        `,
      },
      "./entry.ts",
    );
    const entry = functionUnitId(fixture, "/entry.ts", "entry");
    expect(fixture.graph.uses.filter((use) => use.ownerUnitId === entry)).toEqual([]);
    expect(fixture.graph.records.filter((record) => record.kind === "import-alias")).toEqual([]);
  });

  it("rejects a copied SourceFile population instead of guessing a join", () => {
    const fixture = makeGraph({ "./entry.ts": "export function entry(): number { return 1; }" }, "./entry.ts");
    const foreignSource = ts.createSourceFile(
      fixture.ast.entryFile.fileName,
      fixture.ast.entryFile.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let caught: unknown;
    try {
      buildIrProgramCallableBindingGraph({
        checker: fixture.ast.checker,
        sourceFiles: [foreignSource],
        identityContext: fixture.identity,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IrProgramCallableBindingInvariantError);
    expect(caught).toMatchObject({ code: "source-record-mismatch" });
  });
});
