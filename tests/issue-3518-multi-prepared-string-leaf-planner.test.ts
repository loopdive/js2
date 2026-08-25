// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyzeMultiSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
// Settle the production codegen module graph before importing its extracted planners.
import "../src/codegen/index.js";
import { collectDeclarations } from "../src/codegen/declarations.js";
import { definedFuncAt } from "../src/codegen/func-space.js";
import {
  buildIrOverlayIdentityMaps,
  planIrOverlayByIdentity,
  projectIrIntegrationLoweringPlans,
} from "../src/codegen/ir-overlay-identity.js";
import { buildIrExactFunctionClaimIndex } from "../src/codegen/ir-overlay-safety.js";
import {
  buildMultiIrGraphSafety,
  type MultiPreparedFunctionValuePlan,
  type MultiPreparedFunctionValueSupportReceipt,
} from "../src/codegen/multi-prepared-scalar-leaf.js";
import {
  collectMultiPreparedStringLeafShapes,
  requireCurrentMultiPreparedStringLeafCandidate,
  requireCurrentMultiPreparedStringLeafSupport,
  resolveMultiPreparedStringLeafCandidate,
  type MultiPreparedStringLeafCandidateEvidence,
  type MultiPreparedStringLeafResolverInput,
} from "../src/codegen/multi-prepared-string-leaf.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { planProgramAbiFunctionValue } from "../src/codegen/program-abi-planning.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { ensureFuncClosureSingleton } from "../src/codegen/closures/method-trampolines.js";
import { localGlobalIdx } from "../src/codegen/registry/imports.js";
import { planCountedStringAppend } from "../src/ir/analysis/counted-string-append.js";
import { irSupportGlobalRef } from "../src/ir/abi-bindings.js";
import { irIntrinsicFuncRef, irSupportFuncRef, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrSourceId, type IrUnitId } from "../src/ir/identity.js";
import { irVal } from "../src/ir/nodes.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { createEmptyModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

const ENTRY_PATH = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/string.ts");
const HELPERS_PATH = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/helpers.ts");
const ENTRY_SOURCE = readFileSync(ENTRY_PATH, "utf8");
const HELPERS_SOURCE = readFileSync(HELPERS_PATH, "utf8");
const CARD_CALL = 'addBenchCard(wrap, "String: concat 1k", "wasm:js-string concat per iteration", bench_string);';

interface Fixture {
  readonly input: MultiPreparedStringLeafResolverInput<MultiPreparedFunctionValuePlan>;
  readonly candidate: MultiPreparedStringLeafCandidateEvidence;
}

interface PlannedFixture {
  readonly input: Fixture["input"];
  readonly candidate: MultiPreparedStringLeafCandidateEvidence | undefined;
}

function exactFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declarations = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (declarations.length !== 1 || !declarations[0]?.body) throw new Error(`fixture lost ${name}`);
  return declarations[0];
}

function replaceOnce(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) throw new Error(`missing mutation anchor: ${search}`);
  return source.replace(search, replacement);
}

const CANONICAL_LEAF = `export function bench_string(): number {
  let str = "";
  for (let i = 0; i < 1000; i++) str = str + "abcde";
  return str.length;
}`;

function entryWithLeaf(leaf: string, callbackName = "bench_string"): string {
  return replaceOnce(
    replaceOnce(ENTRY_SOURCE, CANONICAL_LEAF, leaf),
    `"wasm:js-string concat per iteration", bench_string`,
    `"wasm:js-string concat per iteration", ${callbackName}`,
  );
}

function collectShapes(entrySource: string) {
  const ast = analyzeMultiSource({ "helpers.ts": HELPERS_SOURCE, "string.ts": entrySource }, "string.ts");
  return collectMultiPreparedStringLeafShapes({
    proofContext: { checker: ast.checker, oracle: new TsCheckerOracle(ast.checker) },
    sourceFiles: ast.sourceFiles,
  });
}

function planFixture(entrySource = ENTRY_SOURCE, helpersSource = HELPERS_SOURCE): PlannedFixture | undefined {
  const ast = analyzeMultiSource({ "helpers.ts": helpersSource, "string.ts": entrySource }, "string.ts");
  const entryFile = ast.entryFile;
  const inventory = buildIrUnitInventory(ast.sourceFiles, { checker: ast.checker, entrySource: entryFile });
  const identityContext = buildIrPlanningIdentityContext(inventory);
  const mod = createEmptyModule();
  const session = new ProgramAbiSession(inventory, mod);
  const ctx = createCodegenContext(
    mod,
    ast.checker,
    { experimentalIR: true, standalone: true },
    session,
    identityContext,
  );
  ctx.sourceIsModule = true;
  for (const sourceFile of ast.sourceFiles) collectDeclarations(ctx, sourceFile, sourceFile === entryFile);

  const proofContext = { checker: ast.checker, oracle: ctx.oracle };
  const shapes = collectMultiPreparedStringLeafShapes({ proofContext, sourceFiles: ast.sourceFiles });
  const maps = buildIrOverlayIdentityMaps(entryFile, ast.checker, identityContext);
  const identityPlan = planIrOverlayByIdentity(
    entryFile,
    identityContext,
    {
      experimentalIR: true,
      trackFallbacks: true,
      planCountedStringAppend: (loop) =>
        shapes.find((shape) => shape.loop === loop)?.plan ?? planCountedStringAppend(proofContext, loop),
    },
    maps,
  );
  const declaration = shapes.length === 1 ? shapes[0]!.declaration : undefined;
  const legacyName = declaration?.name?.text;
  if (!declaration || !legacyName) throw new Error("fixture lost its sole collected string leaf");
  const unitId = identityContext.unitIdByDeclaration.get(declaration);
  if (!unitId) throw new Error("fixture lost string-leaf UnitId");
  if (
    !identityPlan.identitySelection.funcs.has(unitId) ||
    identityPlan.functionUnitIdByLegacyName.get(legacyName) !== unitId ||
    identityPlan.declarationByLegacyName.get(legacyName) !== declaration
  ) {
    return undefined;
  }
  identityPlan.safeFunctionUnitIds.add(unitId);
  const functionClaimsByUnitId = buildIrExactFunctionClaimIndex(
    entryFile,
    identityContext,
    identityPlan.functionClaims,
  );
  const override = Object.freeze({ params: Object.freeze([]), returnType: irVal({ kind: "f64" }) });
  const overrideMapByUnitId = new Map([[unitId, override]]);
  const overrideMap = new Map([[legacyName, override]]);
  const safeSelection = {
    funcs: new Set([legacyName]),
    classMembers: new Set<string>(),
    classMemberUnitIds: new Set(),
  };
  const plan: MultiPreparedFunctionValuePlan = {
    identityPlan,
    functionClaimsByUnitId,
    overrideMapByUnitId,
    overrideMap,
    selection: identityPlan.selectionProjection.selection,
    classShapes: new Map(),
    classShapesById: new Map(),
  };
  const projectedLoweringPlans = projectIrIntegrationLoweringPlans(
    {
      identityPlan,
      overrideMapByUnitId,
      importedCalls: new Map(),
      topLevelFunctionValues: new Map(),
      hostVoidCallbacks: new Map(),
      promiseDelays: { constructions: new Map(), timers: new Map(), resolves: new Map() },
      suspendingAsyncUnitIds: new Set(),
    },
    safeSelection,
  );
  const input = {
    ctx,
    entrySource: entryFile,
    plan,
    safeSelection,
    projectedLoweringPlans,
    safety: buildMultiIrGraphSafety(ctx, ast.sourceFiles, ast.checker),
    proofContext,
    shapes,
    hasForeignLateProvider: () => false,
  } satisfies MultiPreparedStringLeafResolverInput<MultiPreparedFunctionValuePlan>;
  const beforeResolve = plannerCardinalities(input);
  const candidate = resolveMultiPreparedStringLeafCandidate(input);
  expect(plannerCardinalities(input)).toEqual(beforeResolve);
  return { input, candidate };
}

function buildFixture(entrySource = ENTRY_SOURCE, helpersSource = HELPERS_SOURCE): Fixture {
  const fixture = planFixture(entrySource, helpersSource);
  if (!fixture?.candidate) throw new Error("canonical multi-source string-leaf fixture declined");
  return { input: fixture.input, candidate: fixture.candidate };
}

function candidateForSource(entrySource: string, helpersSource = HELPERS_SOURCE) {
  return planFixture(entrySource, helpersSource)?.candidate;
}

function hiddenMap(owner: object | undefined, key: string): Map<unknown, unknown> {
  const value = owner ? (owner as Record<string, unknown>)[key] : undefined;
  if (!(value instanceof Map)) throw new Error(`fixture lost private ${key} cardinality seam`);
  return value;
}

function plannerCardinalities(input: Fixture["input"]) {
  const { ctx, plan, projectedLoweringPlans } = input;
  const session = ctx.programAbiSession;
  const sourceCallables = ctx.programAbiSourceCallables;
  return {
    functions: ctx.mod.functions.length,
    globals: ctx.mod.globals.length,
    types: ctx.mod.types.length,
    funcMap: ctx.funcMap.size,
    closureGlobals: ctx.funcClosureGlobals.size,
    singletonRows: ctx.funcClosureSingletonKeyByFuncIdx.size,
    irUnitFuncs: ctx.irUnitFuncMap.size,
    selected: plan.selection.funcs.size,
    safe: plan.identityPlan.safeFunctionUnitIds.size,
    lowering: projectedLoweringPlans.countedStringAppends?.size ?? 0,
    programAbiPlans: hiddenMap(session, "drafts").size,
    programAbiLocators: hiddenMap(session, "locators").size,
    programAbiDerivedUnits: [...(session?.derivedUnitRecords() ?? [])].length,
    sourceCallableObservations: hiddenMap(sourceCallables, "observations").size,
    sourceCallableSupports: hiddenMap(sourceCallables, "supports").size,
    sourceCallableFunctionValues: hiddenMap(sourceCallables, "functionValues").size,
  };
}

function expectPlannerDecline(input: Fixture["input"]): void {
  const before = plannerCardinalities(input);
  expect(resolveMultiPreparedStringLeafCandidate(input)).toBeUndefined();
  expect(plannerCardinalities(input)).toEqual(before);
}

function inputWithIdentityContext(fixture: Fixture, identityContext: IrPlanningIdentityContext): Fixture["input"] {
  const registry = fixture.input.ctx.programAbiSourceCallables;
  if (!registry) throw new Error("fixture lost source-callable registry");
  fixture.input.ctx.irPlanningIdentityContext = identityContext;
  Object.assign(registry, { identityContext });
  return {
    ...fixture.input,
    plan: {
      ...fixture.input.plan,
      identityPlan: { ...fixture.input.plan.identityPlan, identityContext },
    },
    projectedLoweringPlans: { ...fixture.input.projectedLoweringPlans, identityContext },
  };
}

function prepareSupport(fixture: Fixture): MultiPreparedFunctionValueSupportReceipt {
  const { ctx } = fixture.input;
  const { candidate } = fixture;
  const targetHandle = ctx.programAbiSourceCallables?.handleForUnit(candidate.unitId);
  if (targetHandle === undefined) throw new Error("fixture lost target handle");
  const singleton = ensureFuncClosureSingleton(ctx, candidate.legacyName, targetHandle, false);
  const trampolineFunction = singleton ? definedFuncAt(ctx, singleton.trampolineFuncIdx) : undefined;
  const cacheGlobal = singleton ? ctx.mod.globals[localGlobalIdx(ctx, singleton.cacheGlobalIdx)] : undefined;
  const targetFunction = ctx.programAbiSourceCallables?.functionForUnit(candidate.unitId);
  if (!singleton || !trampolineFunction || !cacheGlobal || !targetFunction)
    throw new Error("support allocation failed");
  const trampolineRef = irSupportFuncRef(candidate.unitId, "function-value-trampoline", trampolineFunction.name);
  const cacheGlobalRef = irSupportGlobalRef(candidate.unitId, "function-value-cache", cacheGlobal.name);
  if (trampolineRef.binding.kind !== "support" || cacheGlobalRef.binding.kind !== "support") {
    throw new Error("fixture lost support bindings");
  }
  expect(
    planProgramAbiFunctionValue(
      ctx,
      {
        target: irUnitFuncRef({ unitId: candidate.unitId, name: candidate.legacyName }),
        trampoline: trampolineRef,
        cacheGlobal: cacheGlobalRef,
      },
      trampolineFunction,
      cacheGlobal,
    ),
  ).toBe(true);
  return Object.freeze({
    targetFunction,
    targetHandle,
    trampolineFunction,
    trampolineHandle: singleton.trampolineFuncIdx,
    trampolineRef,
    trampolineBindingId: trampolineRef.binding.bindingId,
    cacheGlobal,
    cacheGlobalHandle: singleton.cacheGlobalIdx,
    cacheGlobalRef,
    cacheGlobalBindingId: cacheGlobalRef.binding.bindingId,
  });
}

describe("#3518 dormant multi-source string-leaf planner", () => {
  it("certifies the exact real benchmark graph without mutating allocator or planning state", () => {
    const fixture = buildFixture();
    const before = plannerCardinalities(fixture.input);
    expect(fixture.input.plan.identityPlan.identityContext.inventory.sources.map((row) => row.sourceKey)).toEqual([
      "helpers.ts",
      "string.ts",
    ]);
    expect(fixture.input.plan.identityPlan.identityContext.inventory.allUnits).toHaveLength(6);
    expect(fixture.input.plan.identityPlan.identityContext.inventory.terminalUnits).toHaveLength(5);
    expect(
      fixture.input.plan.identityPlan.identityContext.inventory.allUnits.filter(
        (unit) => unit.kind === "arrow-function",
      ),
    ).toHaveLength(1);
    const helperImport = fixture.input.entrySource.statements.find(ts.isImportDeclaration)?.importClause?.namedBindings;
    expect(helperImport && ts.isNamedImports(helperImport) ? helperImport.elements : []).toHaveLength(2);
    expect(fixture.input.shapes).toHaveLength(1);
    expect(fixture.candidate.legacyName).toBe("bench_string");
    expect(fixture.candidate.shape.plan.tripCount).toBe(1000);
    expect(fixture.candidate.loweringPlan.syntaxPlan).toBe(fixture.candidate.shape.plan);
    expect(fixture.candidate.callerDeclaration.name?.text).toBe("main");
    expect(fixture.candidate.importedTarget.name?.text).toBe("addBenchCard");
    requireCurrentMultiPreparedStringLeafCandidate(fixture.input, fixture.candidate);
    expect(plannerCardinalities(fixture.input)).toEqual(before);
  });

  it.each([
    ["renamed target", "measure_string", "", "< 2", 'str = str + "xy"', 2],
    ["plus-equals and braced loop", "bench_string", "seed", "< 2", '{ str += "xy"; }', 2],
    ["zero trips", "bench_string", "", "< 0", 'str = str + "xy"', 0],
    ["one trip", "bench_string", "", "<= 0", 'str = str + "xy"', 1],
    ["two-plus trips", "bench_string", "", "<= 2", 'str = str + "xy"', 3],
  ])("retains the shared proof for %s", (_label, name, seed, condition, append, tripCount) => {
    const leaf = `export function ${name}(): number {
  let str = "${seed}";
  for (let i = 0; i ${condition}; i++) ${append}
  return str.length;
}`;
    const fixture = buildFixture(entryWithLeaf(leaf, name));
    expect(fixture.input.shapes).toHaveLength(1);
    expect(fixture.candidate.legacyName).toBe(name);
    expect(fixture.candidate.shape.plan.tripCount).toBe(tripCount);
    expect(fixture.candidate.loweringPlan.syntaxPlan).toBe(fixture.candidate.shape.plan);
  });

  it("retains transitive immutable start, bound, and fragment proof declarations", () => {
    const leaf = `export function bench_string(): number {
  const start0 = 0;
  const start = start0;
  const bound0 = 2;
  const bound = bound0;
  const fragment0 = "xy";
  const fragment = fragment0;
  let str = "seed";
  for (let i = start; i <= bound; i += 1) { str += fragment; }
  return str.length;
}`;
    const fixture = buildFixture(entryWithLeaf(leaf));
    expect(fixture.candidate.shape.proofConstDeclarations.map((declaration) => declaration.name.getText())).toEqual([
      "start0",
      "start",
      "bound0",
      "bound",
      "fragment0",
      "fragment",
    ]);
    expect(fixture.candidate.shape.plan.tripCount).toBe(3);
  });

  it.each([
    ["missing export", CANONICAL_LEAF.replace("export ", "")],
    ["bodyless declaration", `export function bench_string(): number;`],
    ["async declaration", CANONICAL_LEAF.replace("export function", "export async function")],
    ["generator declaration", CANONICAL_LEAF.replace("function bench_string", "function* bench_string")],
    ["generic declaration", CANONICAL_LEAF.replace("bench_string()", "bench_string<T>()")],
    ["parameter", CANONICAL_LEAF.replace("bench_string()", "bench_string(value: number)")],
    ["wrong result", CANONICAL_LEAF.replace(": number", ": string")],
    ["extra local", CANONICAL_LEAF.replace('  let str = "";', '  const unused = 1;\n  let str = "";')],
    ["extra statement", CANONICAL_LEAF.replace("  return str.length;", "  void 0;\n  return str.length;")],
    ["extra loop", CANONICAL_LEAF.replace("  return str.length;", "  for (;;) break;\n  return str.length;")],
    ["extra call", CANONICAL_LEAF.replace("  return str.length;", "  String(str);\n  return str.length;")],
    ["extra property read", CANONICAL_LEAF.replace("  return str.length;", "  str.length;\n  return str.length;")],
    ["wrong receiver", CANONICAL_LEAF.replace("return str.length", 'return "x".length')],
    ["wrong property", CANONICAL_LEAF.replace("return str.length", "return str.byteLength")],
    ["accumulator alias", CANONICAL_LEAF.replace("  return str.length;", "  const alias = str;\n  return str.length;")],
    [
      "accumulator reassignment",
      CANONICAL_LEAF.replace("  return str.length;", '  str = "reset";\n  return str.length;'),
    ],
    [
      "accumulator capture",
      CANONICAL_LEAF.replace("  return str.length;", "  const read = () => str;\n  return str.length;"),
    ],
  ])("collects no shape for %s", (_label, leaf) => {
    expect(collectShapes(entryWithLeaf(leaf))).toHaveLength(0);
  });

  it.each([
    ["missing use", "void wrap;"],
    ["duplicate use", `${CARD_CALL}\n  ${CARD_CALL}`],
    ["stored use", `const selected = bench_string;\n  void selected;`],
    ["returned use", "return bench_string;"],
    ["direct call", "bench_string();"],
    [
      "wrong argument index",
      'addBenchCard(bench_string, "String: concat 1k", "wasm:js-string concat per iteration", wrap);',
    ],
    ["wrong arity", 'addBenchCard(wrap, "String: concat 1k", bench_string);'],
    [
      "spread call",
      'addBenchCard(...([wrap, "String: concat 1k", "wasm:js-string concat per iteration", bench_string] as never));',
    ],
    ["optional call", CARD_CALL.replace("addBenchCard(", "addBenchCard?.(")],
    ["generic call", CARD_CALL.replace("addBenchCard(", "addBenchCard<number>(")],
    ["nested caller", `function nested(): void { ${CARD_CALL} }\n  nested();`],
  ])("declines the callback edge for %s", (_label, replacement) => {
    expect(candidateForSource(replaceOnce(ENTRY_SOURCE, CARD_CALL, replacement))).toBeUndefined();
  });

  it("declines a second exact caller while retaining the canonical positive sibling", () => {
    expect(buildFixture().candidate).toBeDefined();
    const second = `${ENTRY_SOURCE}\nexport function second(): void { ${CARD_CALL} }\n`;
    expect(candidateForSource(second)).toBeUndefined();
    expect(
      candidateForSource(replaceOnce(ENTRY_SOURCE, "export function main(): void", "export function run(): void")),
    ).toBeUndefined();
  });

  it.each([
    [
      "aliased import",
      replaceOnce(
        replaceOnce(ENTRY_SOURCE, "import { addBenchCard, el }", "import { addBenchCard as card, el }"),
        "addBenchCard(",
        "card(",
      ),
    ],
    [
      "re-export instead of import",
      replaceOnce(
        ENTRY_SOURCE,
        'import { addBenchCard, el } from "./helpers.ts";',
        'export { addBenchCard } from "./helpers.ts";\nimport { el } from "./helpers.ts";',
      ),
    ],
    ["wrong source key", replaceOnce(ENTRY_SOURCE, 'from "./helpers.ts"', 'from "./support.ts"')],
    [
      "wrong helper name",
      replaceOnce(
        replaceOnce(ENTRY_SOURCE, "import { addBenchCard, el }", "import { bcrd, el }"),
        "addBenchCard(",
        "bcrd(",
      ),
    ],
    [
      "same-source helper",
      replaceOnce(
        replaceOnce(ENTRY_SOURCE, "import { addBenchCard, el }", "import { el }"),
        "export function bench_string",
        "export function addBenchCard(wrap: HTMLElement, title: string, desc: string, fn: () => number): void {}\n\nexport function bench_string",
      ),
    ],
  ])("declines %s", (_label, source) => {
    expect(candidateForSource(source)).toBeUndefined();
  });

  it.each([
    ["HTMLElement parameter", "wrap: HTMLElement", "wrap: Element"],
    [
      "title parameter",
      "addBenchCard(wrap: HTMLElement, title: string",
      "addBenchCard(wrap: HTMLElement, title: number",
    ],
    ["description parameter", "title: string, desc: string, fn", "title: string, desc: number, fn"],
    ["callback parameter", "fn: () => number", "fn: (value: number) => number"],
    ["callback result", "fn: () => number", "fn: () => string"],
    ["optional callback", "fn: () => number", "fn?: () => number"],
    ["rest callback", "fn: () => number", "...fn: [() => number]"],
    ["default callback", "fn: () => number", "fn: () => number = () => 0"],
    ["generic helper", "addBenchCard(", "addBenchCard<T>("],
    ["helper result", "): void {", "): number {"],
  ])("declines helper ABI drift in %s", (_label, search, replacement) => {
    expect(candidateForSource(ENTRY_SOURCE, replaceOnce(HELPERS_SOURCE, search, replacement))).toBeUndefined();
  });

  it("declines helper overload and duplicate-target populations", () => {
    const signature =
      "export function addBenchCard(wrap: HTMLElement, title: string, desc: string, fn: () => number): void";
    expect(
      candidateForSource(ENTRY_SOURCE, replaceOnce(HELPERS_SOURCE, signature, `${signature};\n${signature}`)),
    ).toBeUndefined();
    expect(
      candidateForSource(
        ENTRY_SOURCE,
        `${HELPERS_SOURCE}\n${signature} { void wrap; void title; void desc; void fn; }\n`,
      ),
    ).toBeUndefined();
  });

  it("fails closed on shape, selection, claim, override, and late-provider cardinality drift", () => {
    {
      const fixture = buildFixture();
      expectPlannerDecline({ ...fixture.input, shapes: Object.freeze([]) });
      expectPlannerDecline({
        ...fixture.input,
        shapes: Object.freeze([fixture.candidate.shape, fixture.candidate.shape]),
      });
      expectPlannerDecline({ ...fixture.input, shapes: [fixture.candidate.shape] });
    }
    {
      const fixture = buildFixture();
      const foreign = analyzeMultiSource({ "helpers.ts": HELPERS_SOURCE, "string.ts": ENTRY_SOURCE }, "string.ts");
      expectPlannerDecline({
        ...fixture.input,
        proofContext: { ...fixture.input.proofContext, checker: foreign.checker },
      });
      expectPlannerDecline({
        ...fixture.input,
        proofContext: { ...fixture.input.proofContext, oracle: new TsCheckerOracle(foreign.checker) },
      });
      expectPlannerDecline({
        ...fixture.input,
        safeSelection: { ...fixture.input.safeSelection, funcs: new Set([fixture.candidate.legacyName, "main"]) },
      });
      expectPlannerDecline({
        ...fixture.input,
        plan: { ...fixture.input.plan, selection: { ...fixture.input.plan.selection, funcs: new Set() } },
      });
    }
    {
      const fixture = buildFixture();
      const identityPlan = fixture.input.plan.identityPlan;
      const selectedFunction = identityPlan.identitySelection.funcs.get(fixture.candidate.unitId)!;
      const staleSelectedUnit = { ...selectedFunction, displayName: "stale" };
      expectPlannerDecline({
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          identityPlan: {
            ...identityPlan,
            identitySelection: {
              ...identityPlan.identitySelection,
              units: new Map(identityPlan.identitySelection.units).set(fixture.candidate.unitId, staleSelectedUnit),
              funcs: new Map(identityPlan.identitySelection.funcs).set(fixture.candidate.unitId, staleSelectedUnit),
            },
          },
        },
      });
      expectPlannerDecline({
        ...fixture.input,
        plan: { ...fixture.input.plan, functionClaimsByUnitId: new Map() },
      });
      expectPlannerDecline({
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          functionClaimsByUnitId: new Map([
            [
              fixture.candidate.unitId,
              {
                ...fixture.input.plan.functionClaimsByUnitId.get(fixture.candidate.unitId)!,
                unitId: fixture.candidate.importedTargetUnitId,
              },
            ],
          ]),
        },
      });
      expectPlannerDecline({
        ...fixture.input,
        plan: { ...fixture.input.plan, overrideMapByUnitId: new Map() },
      });
      expectPlannerDecline({
        ...fixture.input,
        plan: { ...fixture.input.plan, overrideMap: new Map() },
      });
      const override = fixture.input.plan.overrideMapByUnitId.get(fixture.candidate.unitId)!;
      expectPlannerDecline({
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          overrideMap: new Map([
            [fixture.candidate.legacyName, override],
            ["extra", override],
          ]),
        },
      });
      expectPlannerDecline({
        ...fixture.input,
        projectedLoweringPlans: {
          ...fixture.input.projectedLoweringPlans,
          signaturesByUnitId: new Map([
            ...fixture.input.projectedLoweringPlans.signaturesByUnitId,
            [fixture.candidate.importedTargetUnitId, override] as const,
          ]),
        },
      });
      expectPlannerDecline({ ...fixture.input, hasForeignLateProvider: () => true });
    }
  });

  it("fails closed on syntax-plan and projected C0 provenance drift", () => {
    const fixture = buildFixture();
    const { candidate, input } = fixture;
    const emptySyntax = {
      ...input.plan.identityPlan.identitySelection,
      countedStringAppendPlans: new Map(),
    };
    expectPlannerDecline({
      ...input,
      plan: {
        ...input.plan,
        identityPlan: { ...input.plan.identityPlan, identitySelection: emptySyntax },
      },
    });

    const duplicateSyntax = {
      ...input.plan.identityPlan.identitySelection,
      countedStringAppendPlans: new Map([[candidate.unitId, [candidate.shape.plan, candidate.shape.plan]]]),
    };
    expectPlannerDecline({
      ...input,
      plan: {
        ...input.plan,
        identityPlan: { ...input.plan.identityPlan, identitySelection: duplicateSyntax },
      },
    });

    expectPlannerDecline({
      ...input,
      projectedLoweringPlans: { ...input.projectedLoweringPlans, countedStringAppends: new Map() },
    });
    const detachedLoop = ts.factory.createForStatement(
      undefined,
      undefined,
      undefined,
      ts.factory.createEmptyStatement(),
    );
    expectPlannerDecline({
      ...input,
      projectedLoweringPlans: {
        ...input.projectedLoweringPlans,
        countedStringAppends: new Map([
          [candidate.shape.loop, candidate.loweringPlan],
          [detachedLoop, candidate.loweringPlan],
        ]),
      },
    });
    for (const loweringPlan of [
      Object.freeze({ ...candidate.loweringPlan, ownerUnitId: candidate.importedTargetUnitId }),
      Object.freeze({ ...candidate.loweringPlan, sourceId: "ir-source:v1:stale" as IrSourceId }),
      Object.freeze({ ...candidate.loweringPlan, provider: irIntrinsicFuncRef("__wrong_repeat") }),
      Object.freeze({
        ...candidate.loweringPlan,
        siteId: `${candidate.loweringPlan.siteId}:stale` as typeof candidate.loweringPlan.siteId,
      }),
      Object.freeze({ ...candidate.loweringPlan, syntaxPlan: Object.freeze({ ...candidate.shape.plan }) }),
    ]) {
      expectPlannerDecline({
        ...input,
        projectedLoweringPlans: {
          ...input.projectedLoweringPlans,
          countedStringAppends: new Map([[candidate.shape.loop, loweringPlan]]),
        },
      });
    }
  });

  it("fails closed on candidate-scoped graph and allocator namespace drift", () => {
    {
      const fixture = buildFixture();
      expectPlannerDecline({
        ...fixture.input,
        safety: { ...fixture.input.safety, collisions: new Set([fixture.candidate.legacyName]) },
      });
      expectPlannerDecline({
        ...fixture.input,
        safety: { ...fixture.input.safety, crossFileFunctionNames: new Set([fixture.candidate.legacyName]) },
      });
      expectPlannerDecline({
        ...fixture.input,
        safety: { ...fixture.input.safety, importAliasNames: new Set([fixture.candidate.legacyName]) },
      });
      expectPlannerDecline({
        ...fixture.input,
        safety: { ...fixture.input.safety, occupiedFunctionNameCounts: new Map() },
      });
      expectPlannerDecline({
        ...fixture.input,
        safety: {
          ...fixture.input.safety,
          occupiedFunctionKeys: [...fixture.input.safety.occupiedFunctionKeys, `${fixture.candidate.legacyName}$1`],
        },
      });
    }
    {
      const fixture = buildFixture();
      fixture.input.ctx.funcMap.set(
        `${fixture.candidate.legacyName}$1`,
        fixture.input.ctx.funcMap.get(fixture.candidate.legacyName)!,
      );
      expectPlannerDecline(fixture.input);
    }
    {
      const fixture = buildFixture();
      fixture.input.ctx.liveFuncBindingGlobals ??= new Set();
      fixture.input.ctx.liveFuncBindingGlobals.add(fixture.candidate.legacyName);
      expectPlannerDecline(fixture.input);
    }
    {
      const fixture = buildFixture();
      const target = fixture.input.ctx.programAbiSourceCallables?.functionForUnit(fixture.candidate.unitId);
      if (!target) throw new Error("fixture lost candidate target");
      fixture.input.ctx.mod.functions.push({ ...target });
      expectPlannerDecline(fixture.input);
    }
    {
      const fixture = buildFixture();
      fixture.input.ctx.funcMap.set(
        `__fn_tramp_${fixture.candidate.legacyName}_cached`,
        fixture.candidate.targetHandle,
      );
      expectPlannerDecline(fixture.input);
    }
    {
      const fixture = buildFixture();
      fixture.input.ctx.funcClosureGlobals.set(fixture.candidate.legacyName, 0);
      expectPlannerDecline(fixture.input);
    }
  });

  it("rejects identity and source-qualified join mutations", () => {
    {
      const fixture = buildFixture();
      const context = fixture.input.plan.identityPlan.identityContext;
      const sourceIdBySourceFile = new Map(context.sourceIdBySourceFile);
      sourceIdBySourceFile.delete(fixture.input.entrySource);
      expectPlannerDecline(inputWithIdentityContext(fixture, { ...context, sourceIdBySourceFile }));
    }
    {
      const fixture = buildFixture();
      const context = fixture.input.plan.identityPlan.identityContext;
      const declarationByUnitId = new Map(context.declarationByUnitId);
      declarationByUnitId.delete(fixture.candidate.unitId);
      expectPlannerDecline(inputWithIdentityContext(fixture, { ...context, declarationByUnitId }));
    }
    {
      const fixture = buildFixture();
      const context = fixture.input.plan.identityPlan.identityContext;
      const terminal = context.terminalByUnitId.get(fixture.candidate.unitId)!;
      const copiedTerminal = { ...terminal };
      const terminalByUnitId = new Map(context.terminalByUnitId);
      const unitByUnitId = new Map(context.unitByUnitId);
      terminalByUnitId.set(fixture.candidate.unitId, copiedTerminal);
      unitByUnitId.set(fixture.candidate.unitId, copiedTerminal);
      expectPlannerDecline(inputWithIdentityContext(fixture, { ...context, terminalByUnitId, unitByUnitId }));
    }
    {
      const fixture = buildFixture();
      const context = fixture.input.plan.identityPlan.identityContext;
      const terminal = context.terminalByUnitId.get(fixture.candidate.unitId)!;
      const staleTerminal = {
        ...terminal,
        terminalOwnerId: fixture.candidate.legacyOwnerUnitId,
      };
      const terminalByUnitId = new Map(context.terminalByUnitId);
      const unitByUnitId = new Map(context.unitByUnitId);
      terminalByUnitId.set(fixture.candidate.unitId, staleTerminal);
      unitByUnitId.set(fixture.candidate.unitId, staleTerminal);
      expectPlannerDecline(inputWithIdentityContext(fixture, { ...context, terminalByUnitId, unitByUnitId }));
    }
    {
      const fixture = buildFixture();
      const context = fixture.input.plan.identityPlan.identityContext;
      const moduleInitUnitIdBySourceFile = new Map(context.moduleInitUnitIdBySourceFile);
      moduleInitUnitIdBySourceFile.set(fixture.input.entrySource, fixture.candidate.unitId);
      expectPlannerDecline(inputWithIdentityContext(fixture, { ...context, moduleInitUnitIdBySourceFile }));
    }
  });

  it("throws the shared invariant when frozen candidate evidence drifts", () => {
    const fixture = buildFixture();
    for (const candidate of [
      { ...fixture.candidate },
      Object.freeze({ ...fixture.candidate, sourceId: "ir-source:v1:stale" as IrSourceId }),
      Object.freeze({ ...fixture.candidate, unitId: "ir-unit:v1:stale" as IrUnitId }),
      Object.freeze({ ...fixture.candidate, callerDeclaration: fixture.candidate.importedTarget }),
      Object.freeze({ ...fixture.candidate, shape: Object.freeze({ ...fixture.candidate.shape }) }),
    ]) {
      expect(() =>
        requireCurrentMultiPreparedStringLeafCandidate(
          fixture.input,
          candidate as MultiPreparedStringLeafCandidateEvidence,
        ),
      ).toThrow(/multi-source string leaf .* drifted after certification/);
    }
  });

  it("authenticates the same real support objects before preparation", () => {
    const fixture = buildFixture();
    const support = prepareSupport(fixture);
    const afterAllocation = plannerCardinalities(fixture.input);
    requireCurrentMultiPreparedStringLeafSupport(fixture.input, fixture.candidate, support, "before-prepare");
    expect(plannerCardinalities(fixture.input)).toEqual(afterAllocation);
  });

  it("distinguishes the empty-target and direct-body support boundaries", () => {
    const fixture = buildFixture();
    const support = prepareSupport(fixture);
    const afterAllocation = plannerCardinalities(fixture.input);
    support.targetFunction.body.push({ op: "f64.const", value: 0 });
    expect(() =>
      requireCurrentMultiPreparedStringLeafSupport(fixture.input, fixture.candidate, support, "before-prepare"),
    ).toThrow(/multi-source string leaf .* drifted after certification/);
    requireCurrentMultiPreparedStringLeafSupport(fixture.input, fixture.candidate, support, "after-direct");
    expect(plannerCardinalities(fixture.input)).toEqual(afterAllocation);
  });

  it("fails closed on support receipt, locator, body, and namespace drift", () => {
    type Mutation = (
      fixture: Fixture,
      support: MultiPreparedFunctionValueSupportReceipt,
    ) => MultiPreparedFunctionValueSupportReceipt;
    const mutations: readonly (readonly [string, Mutation])[] = [
      ["unfrozen receipt", (_fixture, support) => ({ ...support })],
      [
        "target allocator object",
        (_fixture, support) => Object.freeze({ ...support, targetFunction: support.trampolineFunction }),
      ],
      [
        "target allocator handle",
        (_fixture, support) => Object.freeze({ ...support, targetHandle: support.trampolineHandle }),
      ],
      [
        "target ABI",
        (fixture, support) => {
          const signature = fixture.input.ctx.mod.types[support.targetFunction.typeIdx];
          if (!signature || signature.kind !== "func") throw new Error("fixture lost target signature");
          fixture.input.ctx.mod.types[support.targetFunction.typeIdx] = {
            ...signature,
            results: [{ kind: "i32" }],
          };
          return support;
        },
      ],
      [
        "trampoline allocator object",
        (_fixture, support) => Object.freeze({ ...support, trampolineFunction: support.targetFunction }),
      ],
      [
        "trampoline allocator handle",
        (_fixture, support) => Object.freeze({ ...support, trampolineHandle: support.targetHandle }),
      ],
      [
        "trampoline reference",
        (fixture, support) =>
          Object.freeze({
            ...support,
            trampolineRef: irSupportFuncRef(
              fixture.candidate.importedTargetUnitId,
              "function-value-trampoline",
              support.trampolineRef.name,
            ),
          }),
      ],
      [
        "trampoline binding id",
        (fixture, support) =>
          Object.freeze({
            ...support,
            trampolineBindingId: irSupportFuncRef(
              fixture.candidate.importedTargetUnitId,
              "function-value-trampoline",
              support.trampolineRef.name,
            ).binding.bindingId,
          }),
      ],
      [
        "trampoline locator",
        (fixture, support) => {
          hiddenMap(fixture.input.ctx.programAbiSession, "locators").delete(support.trampolineBindingId);
          return support;
        },
      ],
      [
        "trampoline current index",
        (fixture, support) => {
          const session = fixture.input.ctx.programAbiSession;
          if (!session) throw new Error("fixture lost Program ABI session");
          const resolveCurrentIndex = session.resolveCurrentIndex.bind(session);
          const drifted: typeof session.resolveCurrentIndex = (id, space, key, module) => {
            const current = resolveCurrentIndex(id, space, key, module);
            return id === support.trampolineBindingId ? current + 1 : current;
          };
          Object.assign(session, { resolveCurrentIndex: drifted });
          return support;
        },
      ],
      [
        "cache allocator object",
        (_fixture, support) => Object.freeze({ ...support, cacheGlobal: { ...support.cacheGlobal } }),
      ],
      [
        "cache allocator handle",
        (_fixture, support) => Object.freeze({ ...support, cacheGlobalHandle: support.cacheGlobalHandle + 1 }),
      ],
      [
        "cache reference",
        (fixture, support) =>
          Object.freeze({
            ...support,
            cacheGlobalRef: irSupportGlobalRef(
              fixture.candidate.importedTargetUnitId,
              "function-value-cache",
              support.cacheGlobalRef.name,
            ),
          }),
      ],
      [
        "cache binding id",
        (fixture, support) =>
          Object.freeze({
            ...support,
            cacheGlobalBindingId: irSupportGlobalRef(
              fixture.candidate.importedTargetUnitId,
              "function-value-cache",
              support.cacheGlobalRef.name,
            ).binding.bindingId,
          }),
      ],
      [
        "trampoline body",
        (_fixture, support) => {
          support.trampolineFunction.body = [{ op: "call", funcIdx: support.targetHandle + 1 }];
          return support;
        },
      ],
      [
        "cache initializer",
        (_fixture, support) => {
          support.cacheGlobal.init = [];
          return support;
        },
      ],
      [
        "cache mutability",
        (_fixture, support) => {
          support.cacheGlobal.mutable = false;
          return support;
        },
      ],
      [
        "singleton reverse row",
        (fixture, support) => {
          fixture.input.ctx.funcClosureSingletonKeyByFuncIdx.set(support.targetHandle, "stale");
          return support;
        },
      ],
      [
        "duplicate trampoline namespace",
        (fixture, support) => {
          fixture.input.ctx.mod.functions.push({ ...support.trampolineFunction });
          return support;
        },
      ],
      [
        "duplicate cache namespace",
        (fixture, support) => {
          fixture.input.ctx.mod.globals.push({ ...support.cacheGlobal });
          return support;
        },
      ],
      [
        "suffixed trampoline namespace",
        (fixture, support) => {
          fixture.input.ctx.funcMap.set(`${support.trampolineFunction.name}$1`, support.trampolineHandle);
          return support;
        },
      ],
      [
        "suffixed cache namespace",
        (fixture, support) => {
          fixture.input.ctx.funcClosureGlobals.set(`${fixture.candidate.legacyName}$1`, support.cacheGlobalHandle);
          return support;
        },
      ],
      [
        "final selection",
        (fixture, support) => {
          (fixture.input.safeSelection.funcs as Set<string>).add("main");
          return support;
        },
      ],
      [
        "final safety",
        (fixture, support) => {
          (fixture.input.safety.collisions as Set<string>).add(fixture.candidate.legacyName);
          return support;
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      const fixture = buildFixture();
      const support = mutate(fixture, prepareSupport(fixture));
      expect(
        () => requireCurrentMultiPreparedStringLeafSupport(fixture.input, fixture.candidate, support, "before-prepare"),
        label,
      ).toThrow(/multi-source string leaf .* drifted after certification/);
    }
  });
});
