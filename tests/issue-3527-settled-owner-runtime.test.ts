// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #3527 B3 — settled non-thenable owners use the canonical Promise ABI. */
import { afterEach, describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import {
  prepareAsyncCallableAbi,
  preparedIrAsyncAwaitSite,
  preparedIrAsyncSourceCanSuspend,
} from "../src/codegen/async-ir-planning.js";
import {
  forgetPreparedIrAsyncSettledOwner,
  preparedIrAsyncSettledOwner,
  preparedIrAsyncSettledOwnerWasIssued,
} from "../src/codegen/async-linear-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildIrUnitInventory, type IrTerminalUnitRecord, type IrUnitId } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { createEmptyModule } from "../src/ir/types.js";
import { buildCompiledImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const SETTLED_SOURCE = `
let phase = 0;

export function readPhase(): number {
  return phase;
}

function numericHelper(seed: number): number {
  return seed + 42;
}

export async function settledOne(seed: number): Promise<number> {
  const value = await 42;
  return value + 1;
}

export async function settledWithHelper(seed: number): Promise<number> {
  const value = await numericHelper(seed);
  return value + 1;
}

export async function settledMany(seed: number): Promise<number> {
  let live = seed + 1;
  phase = 1;
  const first = await 42;
  phase = 2;
  live = live + first;
  const second = await (live + 1);
  phase = 3;
  const unused = await 99;
  phase = 4;
  return second + live + unused;
}

export async function returnAwait(seed: number): Promise<number> {
  return await (seed + 2);
}

export async function voidTail(seed: number): Promise<void> {
  await 42;
  phase = 5;
}
`;

const STATIC_OWNER_SOURCE = `
export async function literalOne(seed: number): Promise<number> {
  const value = await 42;
  return value + 1;
}

export async function literalTwo(seed: number): Promise<number> {
  const first = await 42;
  const second = await 43;
  return first + second;
}
`;

const NEGATIVE_SOURCE = `
declare const pending: Promise<number>;
declare const unknownValue: unknown;
const Promise = { resolve(value: number): number { return value; } };

export async function castPromise(seed: number): Promise<number> {
  const value = await (pending as unknown as number);
  return value + seed;
}

export async function castUnknown(seed: number): Promise<number> {
  const value = await (unknownValue as number);
  return value + seed;
}

export async function shadowedResolve(seed: number): Promise<number> {
  const value = await Promise.resolve(1);
  return value + seed;
}
`;

const PROMISE_RESOLVE_SOURCE = `
export async function promiseResolve(seed: number): Promise<number> {
  const value = await Promise.resolve(seed + 1);
  return value + 1;
}
`;

const IDENTITY_MUTATION_SOURCE = `
export async function owner(): Promise<number> { return await 42; }
export async function other(): Promise<number> { return await 43; }
`;

type MutableIdentity = IrPlanningIdentityContext & {
  readonly unitIdByDeclaration: Map<ts.Node, IrUnitId>;
  readonly declarationByUnitId: Map<IrUnitId, ts.Node>;
  readonly terminalByUnitId: Map<IrUnitId, IrTerminalUnitRecord>;
};

interface SettledOwnerIdentityProbe {
  readonly ctx: ReturnType<typeof createCodegenContext>;
  readonly identity: MutableIdentity;
  readonly owner: ts.FunctionDeclaration;
  readonly other: ts.FunctionDeclaration;
  readonly awaitSite: ts.AwaitExpression;
  readonly ownerId: IrUnitId;
  readonly otherId: IrUnitId;
}

function makeSettledOwnerIdentityProbe(label: string): SettledOwnerIdentityProbe {
  const ast = analyzeSource(IDENTITY_MUTATION_SOURCE, `issue-3527-settled-owner-identity-${label}.ts`);
  const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker });
  const original = buildIrPlanningIdentityContext(inventory);
  const identity = {
    ...original,
    unitIdByDeclaration: new Map(original.unitIdByDeclaration),
    declarationByUnitId: new Map(original.declarationByUnitId),
    terminalByUnitId: new Map(original.terminalByUnitId),
  } as MutableIdentity;
  const mod = createEmptyModule();
  const session = new ProgramAbiSession(inventory, mod);
  const ctx = createCodegenContext(
    mod,
    ast.checker,
    { experimentalIR: true, trackIrOutcomes: true, target: "gc" },
    session,
    identity,
  );
  ctx.callableSourceFiles = [ast.sourceFile];

  const declarations = ast.sourceFile.statements.filter(ts.isFunctionDeclaration);
  const owner = declarations.find((declaration) => declaration.name?.text === "owner");
  const other = declarations.find((declaration) => declaration.name?.text === "other");
  let awaitSite: ts.AwaitExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) awaitSite = node;
    ts.forEachChild(node, visit);
  };
  if (owner) visit(owner);
  const ownerId = owner === undefined ? undefined : identity.unitIdByDeclaration.get(owner);
  const otherId = other === undefined ? undefined : identity.unitIdByDeclaration.get(other);
  if (!owner || !other || !awaitSite || !ownerId || !otherId) {
    throw new Error(`identity mutation fixture did not produce owner/other/await for ${label}`);
  }
  return { ctx, identity, owner, other, awaitSite, ownerId, otherId };
}

function issueSettledOwner(probe: SettledOwnerIdentityProbe): void {
  expect(preparedIrAsyncSettledOwner(probe.ctx, probe.owner)).not.toBeNull();
  expect(preparedIrAsyncSettledOwnerWasIssued(probe.ctx, probe.owner)).toBe(true);
  expect(prepareAsyncCallableAbi(probe.ctx, probe.owner, [], [{ kind: "f64" }])[1]).toEqual([{ kind: "externref" }]);
}

function expectIssuedOwnerWithdrawal(probe: SettledOwnerIdentityProbe): void {
  expect(preparedIrAsyncSettledOwnerWasIssued(probe.ctx, probe.owner)).toBe(true);
  expect(preparedIrAsyncSettledOwner(probe.ctx, probe.owner)).toBeNull();
  expect(() => preparedIrAsyncSourceCanSuspend(probe.ctx, probe.owner)).toThrow(/lost its source proof/);
  expect(() => preparedIrAsyncAwaitSite(probe.ctx, probe.awaitSite)).toThrow(/lost its source proof/);
  expect(() => prepareAsyncCallableAbi(probe.ctx, probe.owner, [], [{ kind: "f64" }])).toThrow(/lost its source proof/);
}

const E2E_IDENTITY_LOSS_SOURCE = `
export async function owner(): Promise<number> { return await 42; }
export async function other(): Promise<number> { return await 43; }
`;

function isOwnerFunctionKey(key: unknown, fileName: string): key is ts.FunctionDeclaration {
  if (typeof key !== "object" || key === null) return false;
  const node = key as ts.FunctionDeclaration;
  return (
    ts.isFunctionDeclaration(node) && node.name?.text === "owner" && node.getSourceFile().fileName.endsWith(fileName)
  );
}

async function compileWithIdentityLoss(fileName: string): Promise<CompileResult> {
  const mapPrototype = Map.prototype as unknown as {
    get: (key: unknown) => unknown;
  };
  const originalGet = mapPrototype.get;
  let ownerIdentityLookups = 0;
  let receiptObserved = false;
  mapPrototype.get = function (this: Map<unknown, unknown>, key: unknown): unknown {
    const stack = new Error().stack ?? "";
    const identityLookup = isOwnerFunctionKey(key, fileName) && stack.includes("settledOwnerIdentity");
    const buildLookup = identityLookup && stack.includes("buildPreparedIrAsyncSettledOwner");
    const initialReceiptLookup = identityLookup && stack.includes("preparedIrAsyncSettledOwner") && !buildLookup;
    const value = originalGet.call(this, key);
    if (identityLookup) {
      if (initialReceiptLookup) ownerIdentityLookups++;
      const allowInitialReceiptLookup = initialReceiptLookup && ownerIdentityLookups === 1;
      if (allowInitialReceiptLookup) receiptObserved = true;
      if (receiptObserved && !buildLookup && !allowInitialReceiptLookup) return undefined;
    }
    return value;
  };
  try {
    return await compile(E2E_IDENTITY_LOSS_SOURCE, options(fileName));
  } finally {
    mapPrototype.get = originalGet;
  }
}

function options(fileName: string) {
  return {
    fileName,
    target: "gc" as const,
    experimentalIR: true,
    trackIrOutcomes: true,
    trackFallbacks: true,
    skipSemanticDiagnostics: true,
  };
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const row = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  if (!row) throw new Error(`missing IR outcome for ${name}`);
  return row;
}

function expectPrepared(result: CompileResult, name: string): IrObservedOutcome {
  const row = outcome(result, name);
  expect(row).toMatchObject({
    kind: "emitted",
    directBodyEmissions: 0,
    irBodyEmissions: 1,
    legacyBodyEmitted: false,
    irBodyEmitted: true,
  });
  expect(row.preparedComponentId).toMatch(/^prepared-component:/);
  expect(result.irCompiledFuncs ?? []).toContain(name);
  expect(result.irCompiledFuncs ?? []).toContain(`${name}__ir_async_state_0`);
  return row;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  return instance.exports as unknown as Record<string, Function>;
}

afterEach(() => {
  Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY");
  Reflect.deleteProperty(process.env, "JS2WASM_TEST_DROP_IR_ASYNC_SETTLED_OWNER");
  (globalThis as { gc?: () => void }).gc?.();
});

describe("#3527 B3 settled non-thenable owners", () => {
  it("projects one/multiple awaits, return-await and void tails to Promise exports", async () => {
    const result = await compile(SETTLED_SOURCE, options("issue-3527-settled-owner-runtime.ts"));
    for (const name of ["settledOne", "settledWithHelper", "settledMany", "returnAwait", "voidTail"])
      expectPrepared(result, name);

    const exports = await instantiate(result);
    const one = exports.settledOne(0);
    const helper = exports.settledWithHelper(0);
    const many = exports.settledMany(3);
    const returned = exports.returnAwait(3);
    const voidResult = exports.voidTail(0);
    for (const promise of [one, helper, many, returned, voidResult]) expect(promise).toBeInstanceOf(Promise);
    await expect(one).resolves.toBe(43);
    await expect(helper).resolves.toBe(43);
    await expect(many).resolves.toBe(192);
    await expect(returned).resolves.toBe(5);
    await expect(voidResult).resolves.toBeUndefined();
  });

  it("retains every settled await job and exposes native observer ordering", async () => {
    const result = await compile(SETTLED_SOURCE, options("issue-3527-settled-owner-observers.ts"));
    expectPrepared(result, "settledMany");
    const exports = await instantiate(result);
    const events: string[] = [];
    const promise = exports.settledMany(3);
    events.push(`after-call:${exports.readPhase()}`);
    Promise.resolve().then(() => events.push(`observer-1:${exports.readPhase()}`));
    await Promise.resolve();
    events.push(`after-flush-1:${exports.readPhase()}`);
    Promise.resolve().then(() => events.push(`observer-2:${exports.readPhase()}`));
    await Promise.resolve();
    events.push(`after-flush-2:${exports.readPhase()}`);
    await expect(promise).resolves.toBe(192);
    events.push(`after-promise:${exports.readPhase()}`);
    expect(events).toEqual([
      "after-call:1",
      "observer-1:2",
      "after-flush-1:2",
      "observer-2:3",
      "after-flush-2:3",
      "after-promise:4",
    ]);
  });

  it("keeps the direct async body poisoned while B3 owns the IR body", async () => {
    process.env.JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY = "1";
    const result = await compile(STATIC_OWNER_SOURCE, options("issue-3527-settled-owner-poison.ts"));
    expectPrepared(result, "literalOne");
    expectPrepared(result, "literalTwo");
    const exports = await instantiate(result);
    await expect(exports.literalOne(0)).resolves.toBe(43);
    await expect(exports.literalTwo(0)).resolves.toBe(85);
  });

  it("fails closed when an issued owner proof is withdrawn before lowering", async () => {
    process.env.JS2WASM_TEST_DROP_IR_ASYNC_SETTLED_OWNER = "owner";
    const result = await compile(
      "export async function owner(): Promise<number> { return await 42; }",
      options("issue-3527-settled-owner-proof-loss.ts"),
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("lost its source proof"))).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("owner__ir_async_state_0");
  });

  it("retains issuance when the declaration-to-unit mapping disappears", () => {
    const probe = makeSettledOwnerIdentityProbe("unit-map-deleted");
    issueSettledOwner(probe);
    probe.identity.unitIdByDeclaration.delete(probe.owner);
    expectIssuedOwnerWithdrawal(probe);

    // The withdrawal seam itself must still find the original UnitId after
    // current identity lookup has failed, so restoring the map cannot revive
    // a previously promised ABI.
    forgetPreparedIrAsyncSettledOwner(probe.ctx, probe.owner);
    probe.identity.unitIdByDeclaration.set(probe.owner, probe.ownerId);
    expect(preparedIrAsyncSettledOwner(probe.ctx, probe.owner)).toBeNull();
    expect(preparedIrAsyncSettledOwnerWasIssued(probe.ctx, probe.owner)).toBe(true);
  });

  it("retains issuance when the terminal identity disappears", () => {
    const probe = makeSettledOwnerIdentityProbe("terminal-map-deleted");
    issueSettledOwner(probe);
    probe.identity.terminalByUnitId.delete(probe.ownerId);
    expectIssuedOwnerWithdrawal(probe);
  });

  it("retains issuance when the declaration is rebound to another UnitId", () => {
    const probe = makeSettledOwnerIdentityProbe("unit-map-rebound");
    issueSettledOwner(probe);
    probe.identity.unitIdByDeclaration.set(probe.owner, probe.otherId);
    expectIssuedOwnerWithdrawal(probe);

    // A rebound declaration cannot mint a second receipt under the other
    // owner's UnitId, even if the original binding is restored later.
    forgetPreparedIrAsyncSettledOwner(probe.ctx, probe.owner);
    probe.identity.unitIdByDeclaration.set(probe.owner, probe.ownerId);
    expect(preparedIrAsyncSettledOwner(probe.ctx, probe.owner)).toBeNull();
  });

  it("fails closed when the current source shape disappears after issuance", () => {
    const probe = makeSettledOwnerIdentityProbe("source-shape-disappeared");
    issueSettledOwner(probe);
    const originalBody = probe.owner.body;
    probe.owner.body = undefined;
    try {
      expect(preparedIrAsyncSettledOwnerWasIssued(probe.ctx, probe.owner)).toBe(true);
      expect(preparedIrAsyncSettledOwner(probe.ctx, probe.owner)).toBeNull();
      expect(() => preparedIrAsyncSourceCanSuspend(probe.ctx, probe.owner)).toThrow(/lost its source proof/);
      expect(() => preparedIrAsyncAwaitSite(probe.ctx, probe.awaitSite)).toThrow(/lost its source proof/);
    } finally {
      probe.owner.body = originalBody;
    }
  });

  it("rejects identity loss before direct body publication", async () => {
    const fileName = "issue-3527-settled-owner-identity-loss-e2e.ts";
    const result = await compileWithIdentityLoss(fileName);
    expect(result.success).toBe(false);
    const row = outcome(result, "owner");
    expect(row).toMatchObject({
      kind: "invariant",
      code: "selection-preparation-mismatch",
      legacyBodyEmitted: false,
      irBodyEmitted: false,
    });
    expect(row.directBodyEmissions ?? 0).toBe(0);
    expect(row.irBodyEmissions ?? 0).toBe(0);
    expect(row.detail).toContain("lost its source proof");
    expect(result.irCompiledFuncs ?? []).not.toContain("owner__ir_async_state_0");
  });

  it("closes a prepared caller against the owner's Promise ABI", async () => {
    const source = `
      export async function owner(): Promise<number> { return await 42; }
      export async function caller(): Promise<number> { return await owner(); }
    `;
    const result = await compile(source, options("issue-3527-settled-owner-caller.ts"));
    expectPrepared(result, "owner");
    expectPrepared(result, "caller");
    const exports = await instantiate(result);
    const promise = exports.caller();
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).resolves.toBe(42);
  });

  it("joins incoming callers by identity and keeps a same-spelling foreign binding out", async () => {
    const source = `
      export async function owner(): Promise<number> { return await 42; }
      export async function caller(): Promise<number> { return await owner(); }
      export async function foreign(owner: () => Promise<number>): Promise<number> { return await owner(); }
    `;
    const result = await compile(source, options("issue-3527-settled-owner-caller-closure.ts"));
    expectPrepared(result, "owner");
    expectPrepared(result, "caller");
    const foreign = outcome(result, "foreign");
    expect(foreign.preparedComponentId).toBeUndefined();
    const exports = await instantiate(result);
    const promise = exports.caller();
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).resolves.toBe(42);
  });

  it("refuses an incompatible raw-value consumer before it can claim IR", async () => {
    const source = `
      export async function owner(): Promise<number> { return await 42; }
      export function raw(): number { return owner() as unknown as number; }
    `;
    const result = await compile(source, options("issue-3527-settled-owner-raw-consumer.ts"));
    const owner = outcome(result, "owner");
    expect(owner).toMatchObject({
      kind: "emitted",
      directBodyEmissions: 1,
      legacyBodyEmitted: true,
    });
    expect(owner.preparedComponentId).toBeUndefined();
    const raw = outcome(result, "raw");
    expect(raw.irBodyEmitted).toBe(false);
    expect(raw.legacyBodyEmitted).toBe(true);
    expect(raw.preparedComponentId).toBeUndefined();
  });

  it("does not treat unknown, Promise casts, or shadowed Promise.resolve as B3 proof", async () => {
    const result = await compile(NEGATIVE_SOURCE, options("issue-3527-settled-owner-negatives.ts"));
    for (const name of ["castPromise", "castUnknown", "shadowedResolve"]) {
      const row = outcome(result, name);
      expect(row.preparedComponentId, name).toBeUndefined();
    }
    expect(result.irCompiledFuncs ?? []).not.toContain("castPromise__ir_async_state_0");
    expect(result.irCompiledFuncs ?? []).not.toContain("castUnknown__ir_async_state_0");
    expect(result.irCompiledFuncs ?? []).not.toContain("shadowedResolve__ir_async_state_0");
  });

  it("leaves Promise.resolve operands on the existing B2 policy", async () => {
    const result = await compile(PROMISE_RESOLVE_SOURCE, options("issue-3527-settled-owner-promise-resolve.ts"));
    const row = outcome(result, "promiseResolve");
    expect(row).toMatchObject({
      kind: "emitted",
      directBodyEmissions: 0,
      irBodyEmissions: 1,
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irCompiledFuncs ?? []).toContain("promiseResolve__ir_async_state_0");
    const exports = await instantiate(result);
    const promise = exports.promiseResolve(3);
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).resolves.toBe(5);
  });

  it("keeps no-await and standalone static controls outside this cutover", async () => {
    const noAwait = await compile(
      "export async function noAwait(seed: number): Promise<number> { return seed + 1; }",
      options("issue-3527-settled-owner-no-await.ts"),
    );
    const noAwaitRow = outcome(noAwait, "noAwait");
    expect(noAwaitRow.preparedComponentId).toBeUndefined();
    expect(noAwait.irCompiledFuncs ?? []).not.toContain("noAwait__ir_async_state_0");

    const standalone = await compile(STATIC_OWNER_SOURCE, {
      ...options("issue-3527-settled-owner-standalone.ts"),
      target: "standalone",
    });
    for (const name of ["literalOne", "literalTwo"]) {
      const row = outcome(standalone, name);
      expect(row.preparedComponentId, name).toBeUndefined();
      expect(standalone.irCompiledFuncs ?? []).not.toContain(`${name}__ir_async_state_0`);
    }
  });
});
