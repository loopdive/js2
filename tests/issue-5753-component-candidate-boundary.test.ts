// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS } from "../src/codegen/any-helpers.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import * as unitPreparation from "../src/codegen/program-abi-unit-callable-preparation.js";
import {
  prepareUnitCallableDescriptorForScope,
  consumePreparedUnitCallableDescriptor,
} from "../src/codegen/program-abi-unit-callable-preparation.js";
import {
  prepareSupportTypeDescriptorForScope,
  consumePreparedSupportTypeDescriptor,
} from "../src/codegen/program-abi-support-type-preparation.js";
import { buildIrUnitInventory, createDerivedIrUnitId, type IrBindingId } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { irCallableBindingKey, irUnitCallableBindingId, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { asBlockId, asValueId, irVal, type IrFunction } from "../src/ir/nodes.js";
import { irSupportRef } from "../src/ir/core/types.js";
import { createEmptyModule, type FuncTypeDef, type StructTypeDef, type WasmFunction } from "../src/ir/types.js";
import { derivePreparedComponentDependencies } from "../src/ir/prepared-component-dependencies.js";
import type { PreparedComponentArtifactEntry } from "../src/ir/prepared-component-sealing.js";
import type { PreparedComponentCandidateDemand } from "../src/ir/program/component-candidate-demand.js";
import { ts } from "../src/frontend/typescript.js";

afterEach(() => vi.restoreAllMocks());

function fixture(withSupport = true) {
  const source = ts.createSourceFile(
    "/repo/candidate.ts",
    "export function first(): void {} export function second(): void {}",
    ts.ScriptTarget.Latest,
    true,
  );
  const inventory = buildIrUnitInventory([source], { entrySource: source });
  const terminals = inventory.terminalUnits.filter((unit) => unit.kind === "top-level-function");
  expect(terminals).toHaveLength(2);
  const mod = createEmptyModule();
  const session = new ProgramAbiSession(inventory, mod);
  const ctx = createCodegenContext(
    mod,
    {} as ts.TypeChecker,
    undefined,
    session,
    buildIrPlanningIdentityContext(inventory),
  );
  const cell: StructTypeDef = {
    kind: "struct",
    name: "candidate_cell",
    fields: [{ name: "value", type: { kind: "f64" }, mutable: true }],
  };
  mod.types.push(cell);
  const [support] = ctx.programAbiTypes!.prepareRefCellSupportTypes(
    [{ innerType: irVal({ kind: "f64" }), cellType: cell }],
    true,
  );
  const supportId = support!.cellTypeRef.binding.bindingId;
  const signature: FuncTypeDef = {
    kind: "func",
    params: withSupport ? [{ kind: "ref_null", typeIdx: mod.types.indexOf(cell) }] : [],
    results: [],
  };
  mod.types.push(signature);
  const entries: PreparedComponentArtifactEntry[] = [];
  const allocate = (name: string) => {
    const func: WasmFunction = { name, typeIdx: mod.types.indexOf(signature), locals: [], body: [], exported: false };
    const handle = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, handle, func);
    return { func, handle };
  };
  const body = (id: (typeof terminals)[number]["id"], name: string): IrFunction => ({
    unitId: id,
    name,
    params: withSupport ? [{ name: "cell", value: asValueId(0), type: irSupportRef(support!.cellTypeRef, true) }] : [],
    resultTypes: [],
    blocks: [
      { id: asBlockId(0), blockArgs: [], blockArgTypes: [], instrs: [], terminator: { kind: "return", values: [] } },
    ],
    exported: false,
    valueCount: 1,
  });
  for (const unit of terminals) {
    const declaration = source.statements.find(
      (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === unit.displayName,
    )!;
    const { handle } = allocate(unit.displayName);
    expect(ctx.programAbiSourceCallables!.observe(declaration, handle)).toBe(unit.id);
    entries.push({ artifactUnitId: unit.id, terminalOwnerUnitId: unit.id, fn: body(unit.id, unit.displayName) });
  }
  const parent = terminals[0]!;
  const derived = {
    id: createDerivedIrUnitId({ parentId: parent.id, role: "lifted-closure", ordinal: 0 }),
    parentId: parent.id,
    terminalOwnerId: parent.id,
    sourceId: parent.sourceId,
    role: "lifted-closure" as const,
    ordinal: 0,
  };
  session.registerDerivedUnit(derived);
  const { func: child } = allocate("child");
  ctx.irUnitFuncMap.set(derived.id, child);
  entries.push({
    artifactUnitId: derived.id,
    terminalOwnerUnitId: parent.id,
    fn: body(derived.id, "child"),
    derivedUnit: derived,
  });
  const adapter = ctx.programAbiComponentPreparation!;
  const candidates = adapter.observeCallables(entries, inventory);
  const views = candidates.observeDependencies();
  const report = derivePreparedComponentDependencies({
    module: { functions: entries.map((entry) => entry.fn) },
    terminalUnitIds: new Set(terminals.map((unit) => unit.id)),
    inventory,
    derivedUnits: [derived],
    abi: views.abi,
  });
  expect(report.components).toHaveLength(2);
  expect(report.components.every((component) => component.status === "complete")).toBe(true);
  const component = report.componentByTerminalUnitId.get(parent.id)!;
  const childId = irUnitCallableBindingId(derived.id);
  const demand: PreparedComponentCandidateDemand = {
    componentId: component.id,
    terminalUnitIds: component.terminalUnitIds,
    callableBindingIds: [childId],
    supportBindingIds: withSupport ? [supportId] : [],
  };
  const describe = () => candidates.describe(component, demand, new Map())!;
  return {
    ctx,
    mod,
    session,
    inventory,
    entries,
    terminals,
    child,
    childId,
    derived,
    supportId,
    cell,
    signature,
    adapter,
    candidates,
    views,
    report,
    component,
    demand,
    describe,
  };
}

function absent(f: ReturnType<typeof fixture>) {
  for (const id of [f.childId, f.supportId]) {
    expect(f.session.getDraft(id)).toBeUndefined();
    expect(f.session.hasLocator(id)).toBe(false);
    expect(f.session.locatorObjectForBinding(id)).toBeUndefined();
  }
  expect(
    f.session.bindingIdsForStructuralReference(irCallableBindingKey(irUnitFuncRef(f.entries[2]!.fn).binding)),
  ).toEqual([]);
}

function stage(f: ReturnType<typeof fixture>, batch = f.describe()) {
  const scope = f.session.beginPreparedComponentScope(f.component.id, f.component.terminalUnitIds);
  scope.stagePreparedComponentBatch({
    scopeId: f.component.id,
    terminalUnitIds: f.component.terminalUnitIds,
    ...batch,
  });
  scope.includeBinding(f.supportId);
  return scope;
}

it.each(["abort", "seal"] as const)(
  "keeps candidate drafts private until %s and consumes original tokens",
  (action) => {
    const f = fixture();
    const batch = f.describe();
    expect(Object.keys(batch.unitCallables!)).toEqual(["kind"]);
    expect(Object.keys(batch.supportTypes!)).toEqual(["kind"]);
    absent(f);
    const scope = stage(f, batch);
    absent(f);
    expect(scope.abi.locatorObject(f.childId)).toBe(f.child);
    expect(scope.abi.get(f.supportId)).toBeDefined();
    scope[action]();
    expect(f.session.hasPlan(f.childId)).toBe(action === "seal");
    expect(f.session.hasPlan(f.supportId)).toBe(action === "seal");
    expect(() =>
      prepareUnitCallableDescriptorForScope(batch.unitCallables!, f.session, "replay", f.component.terminalUnitIds),
    ).toThrow("already claimed");
    expect(() =>
      prepareSupportTypeDescriptorForScope(batch.supportTypes!, f.session, "replay", f.component.terminalUnitIds),
    ).toThrow("already claimed");
  },
);

it.each(["terminal", "callable", "support"] as const)(
  "rejects missing, duplicate, excess and same-size foreign %s populations",
  (kind) => {
    const f = fixture();
    expect(f.describe().unitCallables).toBeDefined();
    const key =
      kind === "terminal" ? "terminalUnitIds" : kind === "callable" ? "callableBindingIds" : "supportBindingIds";
    const original = f.demand[key];
    for (const values of [[], [...original, ...original], [...original, "foreign"], ["foreign"]]) {
      expect(() => f.candidates.describe(f.component, { ...f.demand, [key]: values }, new Map())).toThrow(
        "population mismatch",
      );
    }
    absent(f);
  },
);

it("rejects a foreign component id, context, session, module and inventory", () => {
  const f = fixture();
  expect(f.describe().supportTypes).toBeDefined();
  expect(() => f.candidates.describe(f.component, { ...f.demand, componentId: "foreign" }, new Map())).toThrow(
    "identity mismatch",
  );
  expect(() => f.adapter.assertContext({ ...f.ctx })).toThrow("crossed contexts");
  expect(() => f.adapter.observeCallables(f.entries, { ...f.inventory })).toThrow("crossed inventories");
  const foreign = fixture();
  f.ctx.programAbiSession = foreign.session;
  expect(() => f.describe()).toThrow("crossed contexts or sessions");
  f.ctx.programAbiSession = f.session;
  f.ctx.mod = { ...f.mod };
  expect(() => f.describe()).toThrow();
  f.ctx.mod = f.mod;
  absent(f);
});

it("rejects missing, duplicate and wrongly owned derived artifacts", () => {
  const f = fixture();
  expect(f.describe().unitCallables).toBeDefined();
  expect(() => f.adapter.observeCallables([...f.entries, f.entries[2]!], f.inventory)).toThrow("duplicate artifact");
  expect(() =>
    f.adapter.observeCallables(
      f.entries.map((entry, index) => (index === 2 ? { ...entry, terminalOwnerUnitId: f.terminals[1]!.id } : entry)),
      f.inventory,
    ),
  ).toThrow("foreign or duplicate artifact");
  f.ctx.irUnitFuncMap.delete(f.derived.id);
  expect(() => f.adapter.observeCallables(f.entries, f.inventory)).toThrow("no exact allocated callable");
  expect(() => f.describe()).toThrow("exact unit allocator");
  absent(f);
});

it.each(["copy", "foreign session", "different terminals", "duplicate terminals"] as const)(
  "rejects %s for both real tokens",
  (mutation) => {
    const f = fixture();
    const batch = f.describe();
    const otherSession = mutation === "foreign session" ? fixture().session : f.session;
    const terminals =
      mutation === "different terminals"
        ? [f.terminals[1]!.id]
        : mutation === "duplicate terminals"
          ? [...f.component.terminalUnitIds, ...f.component.terminalUnitIds]
          : f.component.terminalUnitIds;
    expect(() =>
      prepareUnitCallableDescriptorForScope(
        mutation === "copy" ? { ...batch.unitCallables! } : batch.unitCallables!,
        otherSession,
        "bad",
        terminals,
      ),
    ).toThrow("foreign");
    expect(() =>
      prepareSupportTypeDescriptorForScope(
        mutation === "copy" ? { ...batch.supportTypes! } : batch.supportTypes!,
        otherSession,
        "bad",
        terminals,
      ),
    ).toThrow("foreign");
    absent(f);
  },
);

it.each(["signature", "removed function", "moved owner", "shape", "replaced cell"] as const)(
  "consumes both descriptors after partial preparation fails: %s",
  (mutation) => {
    const f = fixture();
    const batch = f.describe();
    absent(f);
    if (mutation === "signature") f.mod.types[f.child.typeIdx] = { ...f.signature, results: [{ kind: "i32" }] };
    if (mutation === "removed function") f.mod.functions.splice(f.mod.functions.indexOf(f.child), 1);
    if (mutation === "moved owner") f.ctx.irUnitFuncMap.set(f.derived.id, { ...f.child });
    if (mutation === "shape") f.cell.fields = [];
    if (mutation === "replaced cell") f.session.typeCellFor(f.cell)!.current = { ...f.cell };
    const scope = f.session.beginPreparedComponentScope(f.component.id, f.component.terminalUnitIds);
    expect(() =>
      scope.stagePreparedComponentBatch({
        scopeId: f.component.id,
        terminalUnitIds: f.component.terminalUnitIds,
        ...batch,
      }),
    ).toThrow(
      mutation === "moved owner"
        ? "exact unit allocator"
        : mutation === "shape" || mutation === "replaced cell"
          ? "exact allocator or shape"
          : "exact allocator or signature",
    );
    scope.abort();
    expect(() =>
      prepareUnitCallableDescriptorForScope(batch.unitCallables!, f.session, "retry", f.component.terminalUnitIds),
    ).toThrow("already claimed");
    expect(() =>
      prepareSupportTypeDescriptorForScope(batch.supportTypes!, f.session, "retry", f.component.terminalUnitIds),
    ).toThrow("already claimed");
    absent(f);
  },
);

it("rejects an unknown support candidate after a real positive", () => {
  const f = fixture();
  expect(f.describe().supportTypes).toBeDefined();
  expect(() =>
    f.candidates.describe(f.component, { ...f.demand, supportBindingIds: ["unknown" as IrBindingId] }, new Map()),
  ).toThrow("support binding");
  absent(f);
});

it("omits a genuinely empty callable population while retaining the nonempty shared support token", () => {
  const f = fixture();
  const component = f.report.componentByTerminalUnitId.get(f.terminals[1]!.id)!;
  const batch = f.candidates.describe(
    component,
    {
      componentId: component.id,
      terminalUnitIds: component.terminalUnitIds,
      callableBindingIds: [],
      supportBindingIds: [f.supportId],
    },
    new Map(),
  )!;
  expect(batch.unitCallables).toBeUndefined();
  expect(batch.supportTypes).toBeDefined();
  absent(f);
});

it.each(["abort", "seal"] as const)("preserves shared support across peer publication then %s", (action) => {
  const f = fixture();
  const first = stage(f);
  const component = f.report.componentByTerminalUnitId.get(f.terminals[1]!.id)!;
  const batch = f.candidates.describe(
    component,
    {
      componentId: component.id,
      terminalUnitIds: component.terminalUnitIds,
      callableBindingIds: [],
      supportBindingIds: [f.supportId],
    },
    new Map(),
  )!;
  const second = f.session.beginPreparedComponentScope(component.id, component.terminalUnitIds);
  second.stagePreparedComponentBatch({ scopeId: component.id, terminalUnitIds: component.terminalUnitIds, ...batch });
  second.includeBinding(f.supportId);
  second.seal();
  expect(f.session.hasPlan(f.supportId)).toBe(true);
  first[action]();
  expect(f.session.hasPlan(f.supportId)).toBe(true);
  expect(f.session.hasPlan(f.childId)).toBe(action === "seal");
});

it.each(["unit", "support"] as const)("rejects foreign module reuse of a minted %s token", (kind) => {
  const f = fixture();
  const batch = f.describe();
  // Same allocator objects, but a different module container is not this session.
  f.ctx.mod = { ...f.mod };
  expect(() =>
    kind === "unit"
      ? prepareUnitCallableDescriptorForScope(
          batch.unitCallables!,
          f.session,
          "foreign-module",
          f.component.terminalUnitIds,
        )
      : prepareSupportTypeDescriptorForScope(
          batch.supportTypes!,
          f.session,
          "foreign-module",
          f.component.terminalUnitIds,
        ),
  ).toThrow("belongs to a different WasmModule");
  f.ctx.mod = f.mod;
  absent(f);
});

it("retains exact moved token declarations and no physical candidates in the IR boundary", () => {
  const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const leaf = read("src/shared/contracts/prepared-component-tokens.ts");
  for (const [path, name] of [
    ["src/codegen/program-abi-unit-callable-preparation.ts", "PreparedUnitCallableDescriptor"],
    ["src/codegen/program-abi-support-type-preparation.ts", "PreparedSupportTypeDescriptor"],
  ]) {
    const old = execFileSync("git", ["show", "4085860f7a06415650fa5ef68ad0d58f0c88c8f0:" + path], { encoding: "utf8" });
    const declaration = old.match(new RegExp("export interface " + name + " \\{[^}]+\\}"))![0];
    expect(leaf).toContain(declaration);
    expect(read(path)).not.toContain(declaration);
    expect(read(path)).toContain('from "../shared/contracts/prepared-component-tokens.js"');
    const restored = read(path)
      .replace(
        "import type { " +
          name +
          ' } from "../shared/contracts/prepared-component-tokens.js";\n' +
          "export type { " +
          name +
          ' } from "../shared/contracts/prepared-component-tokens.js";',
        declaration,
      )
      .replace("  session.assertModule(ctx.mod);\n", "");
    expect(restored).toBe(old);
  }
  expect(ts.createSourceFile("tokens.ts", leaf, ts.ScriptTarget.Latest).statements).toHaveLength(2);
  const sealing = read("src/ir/prepared-component-sealing.ts");
  for (const forbidden of [
    "describePreparedUnitCallables",
    "describePreparedSupportTypes",
    "definedFuncAt",
    "provisionalSupportTypes",
    "planProgramAbiUnitCallable",
  ])
    expect(sealing).not.toContain(forbidden);
});

// Parent-approved U1 follow-up: these two exact spans add real undefined
// consumer reuse to selection, without rewriting the historical C1 receipt.
const undefinedReuseInverse = [
  {
    current: `  // A committed binding closes dependency discovery, not resource authentication.
  // Retain the ordinary descriptor for each actual undefined consumer so its
  // allocator/resource checks survive deferred sealing and final commit.
  const undefinedKey = irCallableBindingKey(irRuntimeFuncRef(IR_UNDEFINED_VALUE_FN).binding);
  const consumedProviderKeys = new Set(
    component.externalCallables
      .filter(({ structuralReferenceKey }) => structuralReferenceKey === undefinedKey)
      .map(({ structuralReferenceKey }) => structuralReferenceKey),
  );
  if (component.status === "complete" && consumedProviderKeys.size === 0) {
    const exportAliases = describeExportAliases();
    return exportAliases
      ? Object.freeze({ requestedStructuralReferenceKeys: Object.freeze([]), exportAliases })
      : undefined;
  }
  if (component.status !== "complete" && (component.status !== "blocked" || component.failures.length === 0))
    return undefined;
  const importRegistry = ctx.programAbiCallableImports;
  const providerRegistry = ctx.programAbiCallableProviders;
  const typeRegistry = ctx.programAbiTypes;
  const selectedImports = new Set<Import>();
  const selectedProviderKeys = new Set(consumedProviderKeys);
  const selectedClassIds = new Set<IrClassId>();
  // Requests include authenticated reuse; do not fabricate unplanned failures
  // or change a complete component's dependency evidence to select a descriptor.
  const requestedKeys = new Set(consumedProviderKeys);
  if (consumedProviderKeys.size > 0) {
    const providerImports = providerRegistry?.importsForPreparedProviders(consumedProviderKeys);
    if (providerImports === undefined) fail("undefined consumers lost their authenticated provider reservation");
    for (const imported of providerImports) selectedImports.add(imported);
  }`,
    original: `  if (component.status === "complete") {
    const exportAliases = describeExportAliases();
    return exportAliases
      ? Object.freeze({ requestedStructuralReferenceKeys: Object.freeze([]), exportAliases })
      : undefined;
  }
  if (component.status !== "blocked" || component.failures.length === 0) return undefined;
  const importRegistry = ctx.programAbiCallableImports;
  const providerRegistry = ctx.programAbiCallableProviders;
  const typeRegistry = ctx.programAbiTypes;
  const selectedImports = new Set<Import>();
  const selectedProviderKeys = new Set<string>();
  const selectedClassIds = new Set<IrClassId>();
  const requestedKeys = new Set<string>();`,
  },
  {
    current: `    const uniqueDependencyRequests = new Set([
      ...consumedProviderKeys,
      ...component.failures.map((failure) => {
        const classId = preparableClassLayoutId(ctx, classIdByBindingId, failure);
        if (classId !== undefined) {
          const record = ctx.programAbiSession!.inventory.classes.find(({ id }) => id === classId)!;
          return irTypeBindingKey(irClassTypeRef(classId, record.displayName).binding);
        }
        return failure.structuralReferenceKey!;
      }),
    ]);
    if (uniqueDependencyRequests.size !== requestedStructuralReferenceKeys.length) return undefined;`,
    original: `    const uniqueFailureRequests = new Set(
      component.failures.map((failure) => {
        const classId = preparableClassLayoutId(ctx, classIdByBindingId, failure);
        if (classId !== undefined) {
          const record = ctx.programAbiSession!.inventory.classes.find(({ id }) => id === classId)!;
          return irTypeBindingKey(irClassTypeRef(classId, record.displayName).binding);
        }
        return failure.structuralReferenceKey!;
      }),
    );
    if (uniqueFailureRequests.size !== requestedStructuralReferenceKeys.length) return undefined;`,
  },
] as const;

function undoUndefinedConsumerReuse(source: string): string {
  for (const span of undefinedReuseInverse) {
    if (source.split(span.current).length !== 2) throw new Error("approved U1 inverse span must occur exactly once");
    source = source.replace(span.current, span.original);
  }
  return source;
}

const numberBoundaryOwnerInverse = {
  current: "    for (const name of NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS) {",
  original: '    for (const name of ["__typeof_number", "__unbox_number"] as const) {',
} as const;

function undoNumberBoundaryOwnerReuse(source: string): string {
  const span = numberBoundaryOwnerInverse;
  if (source.split(span.current).length !== 2)
    throw new Error("canonical number boundary inverse span must occur exactly once");
  return source.replace(span.current, span.original);
}

function assertBatchPlannerReceipt(current: string): void {
  const path = "src/ir/prepared-component-sealing.ts";
  const old = execFileSync("git", ["show", "4085860f7a06415650fa5ef68ad0d58f0c88c8f0:" + path], { encoding: "utf8" });
  const c1 = execFileSync(
    "git",
    ["show", "a55f9a856e48d94a41ae766dc8782b1a41b346c7:src/codegen/program-abi-component-preparation.ts"],
    { encoding: "utf8" },
  );
  const named = (source: string, name: string) =>
    ts
      .createSourceFile("receipt.ts", source, ts.ScriptTarget.Latest, true)
      .statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  for (const name of ["describePreparedComponentBatch", "preparableClassLayoutId"]) {
    expect(named(old, name)).toHaveLength(1);
    expect(named(c1, name)).toHaveLength(1);
    expect(named(current, name)).toHaveLength(1);
    const original = named(old, name)[0]!.getText();
    expect(named(c1, name)[0]!.getText()).toBe(original);
    const actual = named(current, name)[0]!.getText();
    const restored =
      name === "describePreparedComponentBatch"
        ? undoNumberBoundaryOwnerReuse(undoUndefinedConsumerReuse(actual))
        : actual;
    if (restored !== original) throw new Error("batch planner changed outside the approved U1 inverse spans");
  }
}

it("preserves the entire existing import/provider/class/export batch planner exactly", () => {
  assertBatchPlannerReceipt(
    readFileSync(new URL("../src/codegen/program-abi-component-preparation.ts", import.meta.url), "utf8"),
  );
});

it("uses the canonical numeric boundary population in the original order", () => {
  expect(NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS).toEqual(["__typeof_number", "__unbox_number"]);
  const current = readFileSync(new URL("../src/codegen/program-abi-component-preparation.ts", import.meta.url), "utf8");
  expect(current.split('import { NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS } from "./any-helpers.js";')).toHaveLength(2);
  assertBatchPlannerReceipt(current);
});

it("rejects altered or duplicated canonical numeric boundary selection", () => {
  const current = readFileSync(new URL("../src/codegen/program-abi-component-preparation.ts", import.meta.url), "utf8");
  assertBatchPlannerReceipt(current);
  const span = numberBoundaryOwnerInverse.current;
  for (const replacement of [span.replace("HELPERS", "HELPERS.slice(0, 1)"), span + "\n" + span]) {
    expect(() => assertBatchPlannerReceipt(current.replace(span, replacement))).toThrow(
      "canonical number boundary inverse span must occur exactly once",
    );
  }
});

it("rejects a planner mutation outside the approved U1 inverse spans", () => {
  const current = readFileSync(new URL("../src/codegen/program-abi-component-preparation.ts", import.meta.url), "utf8");
  assertBatchPlannerReceipt(current);
  const anchor = "const targets = new Set<object>();";
  expect(current.split(anchor)).toHaveLength(2);
  const mutant = current.replace(anchor, "const targets = new Set<object>(preparedAllocatorTargets);");
  expect(() => assertBatchPlannerReceipt(mutant)).toThrow(
    "batch planner changed outside the approved U1 inverse spans",
  );
});

it("rejects altered or duplicated approved U1 inverse spans", () => {
  const current = readFileSync(new URL("../src/codegen/program-abi-component-preparation.ts", import.meta.url), "utf8");
  assertBatchPlannerReceipt(current);
  for (const span of undefinedReuseInverse) {
    const altered = current.replace(span.current, span.current.replace("const ", "let "));
    expect(() => assertBatchPlannerReceipt(altered)).toThrow("approved U1 inverse span must occur exactly once");
    expect(() => assertBatchPlannerReceipt(current.replace(span.current, span.current + "\n" + span.current))).toThrow(
      "approved U1 inverse span must occur exactly once",
    );
  }
});

it("refuses unresolved nonempty contributions explicitly instead of returning an empty batch", () => {
  const f = fixture();
  expect(f.describe().unitCallables).toBeDefined();
  expect(() =>
    f.candidates.describe(
      {
        ...f.component,
        status: "blocked",
        failures: [
          {
            code: "unplanned-abi-binding",
            ownerUnitId: f.terminals[0]!.id,
            detail: "missing control",
            structuralReferenceKey: "unknown-control",
          },
        ],
      },
      f.demand,
      new Map(),
    ),
  ).toThrow("incomplete dependencies");
  absent(f);
});

it("omits both tokens for an actual dependency-free component and only support for a callable-only component", () => {
  const f = fixture(false);
  const first = f.describe();
  expect(first.unitCallables).toBeDefined();
  expect(first.supportTypes).toBeUndefined();
  const component = f.report.componentByTerminalUnitId.get(f.terminals[1]!.id)!;
  expect(
    f.candidates.describe(
      component,
      {
        componentId: component.id,
        terminalUnitIds: component.terminalUnitIds,
        callableBindingIds: [],
        supportBindingIds: [],
      },
      new Map(),
    ),
  ).toBeUndefined();
  absent(f);
});

it("rejects an altered report artifact population even when its requested terminal matches", () => {
  const f = fixture();
  expect(f.describe().unitCallables).toBeDefined();
  expect(() =>
    f.candidates.describe({ ...f.component, functionUnitIds: [f.terminals[1]!.id] }, f.demand, new Map()),
  ).toThrow("component artifacts population mismatch");
  absent(f);
});

it("rechecks allocator and shape on rebase and assertCurrent without publishing", () => {
  const f = fixture();
  const batch = f.describe();
  const unit = prepareUnitCallableDescriptorForScope(
    batch.unitCallables!,
    f.session,
    "parts",
    f.component.terminalUnitIds,
  );
  const support = prepareSupportTypeDescriptorForScope(
    batch.supportTypes!,
    f.session,
    "parts",
    f.component.terminalUnitIds,
  );
  expect(unit.rebaseBindings!()).toHaveLength(1);
  expect(support.rebaseBindings!()).toHaveLength(1);
  unit.assertCurrent();
  support.assertCurrent();
  f.ctx.irUnitFuncMap.set(f.derived.id, { ...f.child });
  f.cell.fields = [];
  expect(() => unit.rebaseBindings!()).toThrow("exact unit allocator");
  expect(() => unit.assertCurrent()).toThrow("exact unit allocator");
  expect(() => support.rebaseBindings!()).toThrow("exact allocator or shape");
  expect(() => support.assertCurrent()).toThrow("exact allocator or shape");
  consumePreparedUnitCallableDescriptor(batch.unitCallables!, f.session, "parts");
  consumePreparedSupportTypeDescriptor(batch.supportTypes!, f.session, "parts");
  absent(f);
});

it("consumes every part even when one registry consumption throws during abort", () => {
  const f = fixture();
  const batch = f.describe();
  const scope = stage(f, batch);
  vi.spyOn(unitPreparation, "consumePreparedUnitCallableDescriptor").mockImplementationOnce(() => {
    throw new Error("injected unit consumption failure");
  });
  expect(() => scope.abort()).toThrow("injected unit consumption failure");
  expect(() =>
    prepareUnitCallableDescriptorForScope(batch.unitCallables!, f.session, "retry", f.component.terminalUnitIds),
  ).toThrow("already claimed");
  expect(() =>
    prepareSupportTypeDescriptorForScope(batch.supportTypes!, f.session, "retry", f.component.terminalUnitIds),
  ).toThrow("already claimed");
  absent(f);
});

it("consumes a stale candidate on seal failure with no publication prefix", () => {
  const f = fixture();
  const batch = f.describe();
  const scope = stage(f, batch);
  f.cell.fields = [];
  expect(() => scope.seal()).toThrow("exact allocator or shape");
  expect(() =>
    prepareUnitCallableDescriptorForScope(batch.unitCallables!, f.session, "retry", f.component.terminalUnitIds),
  ).toThrow("already claimed");
  expect(() =>
    prepareSupportTypeDescriptorForScope(batch.supportTypes!, f.session, "retry", f.component.terminalUnitIds),
  ).toThrow("already claimed");
  absent(f);
});
