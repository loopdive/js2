// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext, IrPlanningIdentityInvariantError } from "../src/ir/planning-identity.js";
import { makeIrPromiseDelayResolver } from "../src/ir/promise-delay.js";
import {
  collectIrPromiseDelayOwners,
  buildIrPromiseDelayLoweringPlans,
  validatePromiseDelayPlansByIdentity,
  validateNativePromiseDelaySupportByIdentity,
  type IrPromiseDelayLoweringPlan,
  type IrPromiseDelayLoweringPlans,
} from "../src/ir/promise-delay-lowering.js";
import { requireExactSourceFunctionOwner, requireExactPlanSiteOwner } from "../src/ir/planning-sites.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";

const code = `export function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}`;
function fixture() {
  const input = sourceInput({ "./entry.ts": code, "./peer.ts": code });
  const inventory = buildIrUnitInventory(input.sourceFiles, { entrySource: input.entrySource, checker: input.checker });
  const context = buildIrPlanningIdentityContext(inventory);
  const owner = input.entrySource.statements.find(ts.isFunctionDeclaration)!;
  const ownerId = context.unitIdByDeclaration.get(owner)!;
  const resolver = makeIrPromiseDelayResolver(input.checker);
  const certified = resolver.resolveOwner(owner);
  expect(certified).toBeDefined();
  const plans = buildIrPromiseDelayLoweringPlans(
    collectIrPromiseDelayOwners(input.entrySource, new Set([ownerId]), resolver, context),
    new Set([ownerId]),
    context,
    "standalone-native",
  );
  expect(plans.constructions.size).toBe(1);
  const plan = plans.constructions.values().next().value!;
  const executorId = context.unitIdByDeclaration.get(plan.executor)!;
  const timerId = context.unitIdByDeclaration.get(plan.timerCallback)!;
  return { input, context, owner, ownerId, plans, plan, executorId, timerId, certified: certified! };
}
function maps(plan: IrPromiseDelayLoweringPlan): IrPromiseDelayLoweringPlans {
  return {
    constructions: new Map([[plan.construction, plan]]),
    timers: new Map([[plan.timerCall, plan]]),
    resolves: new Map([[plan.resolveCall, plan]]),
  };
}
function withChangedTimerRecord(f: ReturnType<typeof fixture>, field: string, value: unknown) {
  const original = f.context.unitByUnitId.get(f.timerId)!;
  // Original scanner records are frozen. Perturb a copy and both views used by
  // the validator, so rejection tests the selected invariant, not a failed write.
  const record = { ...original };
  expect(Reflect.set(record, field, value)).toBe(true);
  const unitByUnitId = new Map(f.context.unitByUnitId);
  unitByUnitId.set(f.timerId, record);
  return {
    ...f.context,
    unitByUnitId,
    inventory: {
      ...f.context.inventory,
      allUnits: f.context.inventory.allUnits.map((unit) => (unit === original ? record : unit)),
    },
  };
}
function rejected(run: () => unknown, code?: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IrPlanningIdentityInvariantError);
  if (code) expect(caught).toMatchObject({ code });
}

describe("certified native delay original support identity", () => {
  it("joins exact arrows bidirectionally without conflating certification and inventory ordinals", () => {
    const f = fixture();
    const support = validateNativePromiseDelaySupportByIdentity(f.input.entrySource, f.context, f.plans);
    expect(support).toHaveLength(2);
    expect(support[0]).toBe(f.context.unitByUnitId.get(f.executorId));
    expect(support[1]).toBe(f.context.unitByUnitId.get(f.timerId));
    expect(support.map((unit) => [unit.lexicalOwnerId, unit.terminalOwnerId, unit.terminal, unit.kind])).toEqual([
      [f.ownerId, f.ownerId, false, "arrow-function"],
      [f.executorId, f.ownerId, false, "arrow-function"],
    ]);
    expect(f.certified.timerOrdinal).toBe(1);
    expect(support[1]!.ordinal).toBe(0);
    expect(f.plan.timerTarget.binding).not.toEqual({ kind: "unit", unitId: f.timerId });
    expect(requireExactSourceFunctionOwner(f.input.entrySource, f.context, f.ownerId, "delay")).toBe(f.owner);
    for (const site of [
      f.plan.construction,
      f.plan.executor,
      f.plan.timerCall,
      f.plan.timerCallback,
      f.plan.resolveCall,
    ])
      expect(() =>
        requireExactPlanSiteOwner(f.input.entrySource, f.context, f.ownerId, "delay", site, "control"),
      ).not.toThrow();
  });

  it.each(["constructions", "timers", "resolves"] as const)("rejects missing %s", (key) => {
    const f = fixture();
    const broken = { ...f.plans, [key]: new Map() };
    rejected(
      () => validateNativePromiseDelaySupportByIdentity(f.input.entrySource, f.context, broken),
      "unit-record-mismatch",
    );
  });
  it.each(["constructions", "timers", "resolves"] as const)(
    "rejects equal-shaped but different plan objects in %s",
    (key) => {
      const f = fixture();
      const broken = { ...f.plans, [key]: new Map([...f.plans[key]].map(([site, plan]) => [site, { ...plan }])) };
      rejected(
        () => validateNativePromiseDelaySupportByIdentity(f.input.entrySource, f.context, broken),
        "unit-record-mismatch",
      );
    },
  );
  it.each(["construction", "executor", "timerCall", "timerCallback", "resolveCall"] as const)(
    "rejects the detached %s site even with recomputed maps",
    (key) => {
      const f = fixture();
      const other = fixture();
      const plan = { ...f.plan, [key]: other.plan[key] };
      rejected(() => validateNativePromiseDelaySupportByIdentity(f.input.entrySource, f.context, maps(plan)));
    },
  );

  it.each(["executor", "timer"] as const)("rejects missing %s forward declaration identity", (which) => {
    const f = fixture();
    const unitIdByDeclaration = new Map(f.context.unitIdByDeclaration);
    unitIdByDeclaration.delete(which === "executor" ? f.plan.executor : f.plan.timerCallback);
    rejected(() =>
      validateNativePromiseDelaySupportByIdentity(f.input.entrySource, { ...f.context, unitIdByDeclaration }, f.plans),
    );
  });
  it.each(["executor", "timer"] as const)("rejects missing %s reverse declaration identity", (which) => {
    const f = fixture();
    const declarationByUnitId = new Map(f.context.declarationByUnitId);
    declarationByUnitId.delete(which === "executor" ? f.executorId : f.timerId);
    rejected(() =>
      validateNativePromiseDelaySupportByIdentity(f.input.entrySource, { ...f.context, declarationByUnitId }, f.plans),
    );
  });
  it("rejects swapped support maps despite complete record counts", () => {
    const f = fixture();
    const unitIdByDeclaration = new Map(f.context.unitIdByDeclaration);
    unitIdByDeclaration.set(f.plan.executor, f.timerId);
    unitIdByDeclaration.set(f.plan.timerCallback, f.executorId);
    const declarationByUnitId = new Map(f.context.declarationByUnitId);
    declarationByUnitId.set(f.timerId, f.plan.executor);
    declarationByUnitId.set(f.executorId, f.plan.timerCallback);
    rejected(() =>
      validateNativePromiseDelaySupportByIdentity(
        f.input.entrySource,
        { ...f.context, unitIdByDeclaration, declarationByUnitId },
        f.plans,
      ),
    );
  });
  it.each(["missing", "duplicate", "equal copy"] as const)(
    "rejects %s original support records in allUnits",
    (mode) => {
      const f = fixture();
      const unit = f.context.unitByUnitId.get(f.timerId)!;
      const allUnits =
        mode === "missing"
          ? f.context.inventory.allUnits.filter((record) => record.id !== f.timerId)
          : mode === "duplicate"
            ? [...f.context.inventory.allUnits, unit]
            : f.context.inventory.allUnits.map((record) => (record === unit ? { ...record } : record));
      rejected(() =>
        validateNativePromiseDelaySupportByIdentity(
          f.input.entrySource,
          { ...f.context, inventory: { ...f.context.inventory, allUnits } },
          f.plans,
        ),
      );
    },
  );
  it.each([
    ["declarationStart", -1],
    ["declarationEnd", -1],
    ["line", -1],
    ["column", -1],
    ["kind", "function-expression"],
    ["terminal", true],
    ["terminalOwnerId", null],
    ["syntheticRole", "lifted-closure"],
    ["sourceId", "foreign-source"],
    ["lexicalOwnerId", null],
  ])("rejects stale or fabricated support field %s", (field, value) => {
    const f = fixture();
    const context = withChangedTimerRecord(f, String(field), value);
    rejected(() => validateNativePromiseDelaySupportByIdentity(f.input.entrySource, context, f.plans));
  });
  it("rejects a timer assigned directly to delay instead of its executor", () => {
    const f = fixture();
    const context = withChangedTimerRecord(f, "lexicalOwnerId", f.ownerId);
    rejected(() => validateNativePromiseDelaySupportByIdentity(f.input.entrySource, context, f.plans));
  });
  it("does not add native support-span requirements to the legacy shared validator", () => {
    const f = fixture();
    const context = withChangedTimerRecord(f, "declarationEnd", -1);
    const legacy = maps({ ...f.plan, runtimeProjection: "host-executor" });
    expect(validatePromiseDelayPlansByIdentity(f.input.entrySource, context, legacy)).toHaveLength(1);
    rejected(() => validateNativePromiseDelaySupportByIdentity(f.input.entrySource, context, legacy));
    rejected(() => validateNativePromiseDelaySupportByIdentity(f.input.entrySource, context, f.plans));
  });
  it("rejects a current source whose owner body no longer contains a certified site", () => {
    const f = fixture();
    const original = f.owner.body!;
    Reflect.set(f.owner, "body", ts.factory.createBlock([]));
    try {
      rejected(() => validateNativePromiseDelaySupportByIdentity(f.input.entrySource, f.context, f.plans));
    } finally {
      Reflect.set(f.owner, "body", original);
    }
  });
  it("does not silently promote module-init or arrow records to selected source owners", () => {
    const f = fixture();
    for (const id of [f.executorId, f.timerId])
      rejected(() =>
        collectIrPromiseDelayOwners(
          f.input.entrySource,
          new Set([id]),
          makeIrPromiseDelayResolver(f.input.checker),
          f.context,
        ),
      );
  });
  it("rejects a same-named owner in another authoritative source", () => {
    const f = fixture();
    const peer = f.input.sourceFiles.find((source) => source !== f.input.entrySource)!;
    const owner = peer.statements.find(ts.isFunctionDeclaration)!;
    const id = f.context.unitIdByDeclaration.get(owner)!;
    expect(id).not.toBe(f.ownerId);
    const plan = { ...f.plan, ownerUnitId: id };
    rejected(
      () => validateNativePromiseDelaySupportByIdentity(f.input.entrySource, f.context, maps(plan)),
      "source-record-mismatch",
    );
  });
});

const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// Exact full declaration text measured at 1731cf377a9ae3a55af7b9d9447c3b5b2fa144fd.
// Permanent controls do not depend on that historical object existing in CI.
const receipts = [
  [
    "requireExactSourceFunctionOwner",
    "src/ir/planning-sites.ts",
    true,
    "1a925af69d8b78400cfb5aa81525cadab199e597f8a35a5eafb87e211e64bc11",
  ],
  [
    "exactNodeIsReachableFrom",
    "src/ir/planning-sites.ts",
    false,
    "31849d00e8ca74c6b055ab99bdcdfe6737f8e68054843cd1758d5afcdf291d55",
  ],
  [
    "requireExactPlanSiteOwner",
    "src/ir/planning-sites.ts",
    true,
    "535922377fbe2c14a21b6fbab0bb009e3e530c1343a0f811200168abfc5345c8",
  ],
  [
    "validatePromiseDelayPlansByIdentity",
    "src/ir/promise-delay-lowering.ts",
    true,
    "940d59242f71c03d4855474e3318fb5336dfc54f21c1ed1a185fd69d5b65c661",
  ],
] as const;
function declarationReceipt(text: string, name: string, exported: boolean) {
  const file = ts.createSourceFile("receipt.ts", text, ts.ScriptTarget.Latest, true);
  const matches = file.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  expect(matches).toHaveLength(1);
  const node = matches[0]!;
  expect(node.modifiers?.map((modifier) => modifier.kind) ?? []).toEqual(exported ? [ts.SyntaxKind.ExportKeyword] : []);
  expect(node.asteriskToken).toBeUndefined();
  const exact = node.getText(file);
  return sha(exported ? exact.slice("export ".length) : exact);
}
describe("pure frontend validator relocation receipts", () => {
  it.each(receipts)("preserves all of %s, only adding the enumerated export modifier", (name, path, exported, hash) => {
    expect(declarationReceipt(read(path), name, exported)).toBe(hash);
  });
  it.each(["body", "parameter", "async", "generator", "duplicate"] as const)(
    "detects a live %s mutation before admitting the receipt",
    (kind) => {
      const [name, path, exported, hash] = receipts[0];
      const original = read(path);
      const text =
        kind === "body"
          ? original.replace("const unit =", "const changed =")
          : kind === "parameter"
            ? original.replace("ownerName?: string", "ownerName?: number")
            : kind === "async"
              ? original.replace(`export function ${name}`, `export async function ${name}`)
              : kind === "generator"
                ? original.replace(`export function ${name}`, `export function* ${name}`)
                : original + `\nexport function ${name}() { return null; }`;
      expect(text).not.toBe(original);
      expect(() => expect(declarationReceipt(text, name, exported)).toBe(hash)).toThrow();
    },
  );
  it("keeps the overlay's actual downward value imports and no duplicate moved declarations", () => {
    const text = read("src/codegen/ir-overlay-finalize.ts");
    const file = ts.createSourceFile("overlay.ts", text, ts.ScriptTarget.Latest, true);
    for (const [name] of receipts)
      expect(file.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)).toBe(false);
    for (const [path, names] of [
      ["../ir/planning-sites.js", ["requireExactSourceFunctionOwner", "requireExactPlanSiteOwner"]],
      ["../ir/promise-delay-lowering.js", ["validatePromiseDelayPlansByIdentity"]],
    ] as const) {
      const imports = file.statements.filter(
        (node): node is ts.ImportDeclaration =>
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === path,
      );
      expect(imports).toHaveLength(1);
      const clause = imports[0]!.importClause!;
      expect(clause.isTypeOnly).toBe(false);
      const bindings = clause.namedBindings;
      expect(bindings && ts.isNamedImports(bindings)).toBe(true);
      if (!bindings || !ts.isNamedImports(bindings)) throw new Error("missing named imports");
      for (const name of names) {
        const specs = bindings.elements.filter((element) => element.name.text === name);
        expect(specs).toHaveLength(1);
        expect(specs[0]!.isTypeOnly).toBe(false);
        expect(specs[0]!.propertyName).toBeUndefined();
      }
    }
  });
});
