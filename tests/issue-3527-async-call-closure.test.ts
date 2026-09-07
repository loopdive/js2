// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #3527 B2/B3 integration — source-qualified async Promise call closure. */
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import {
  collectPreparedIrAsyncOwners,
  prepareAsyncCallableAbi,
  preparedIrAsyncAwaitSite,
  preparedIrAsyncPromiseOwnerUnitIds,
  preparedIrAsyncPromiseOwnerWasIssued,
  preparedIrAsyncSourceCanSuspend,
} from "../src/codegen/async-ir-planning.js";
import {
  buildIrOverlayIdentityMaps,
  planIrOverlayByIdentity,
  type IrOverlayIdentityPlan,
} from "../src/codegen/ir-overlay-identity.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { ProgramAbiSourceCallableRegistry } from "../src/codegen/program-abi-source-callable-planning.js";
import { addFuncType, getOrRegisterVecType } from "../src/codegen/registry/types.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";
import { buildIrUnitInventory, type IrSourceId, type IrTerminalUnitRecord, type IrUnitId } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { createEmptyModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

const RAW_C1_CONSUMER_SOURCE = `
  async function inner(x: number): Promise<number> {
    return x * 2;
  }
  async function outer(x: number): Promise<number> {
    const a = await inner(x);
    const b = await inner(x + 1);
    return a + b;
  }
  export function run(): number {
    return outer(5) as any as number;
  }
`;

// `outer` is declared before `inner` on purpose. The provider-backed async
// population must settle the two exact UnitIds together instead of depending
// on source declaration order.
const PROMISE_CLOSURE_SOURCE = `
  export async function outer(x: number): Promise<number> {
    const a = await inner(x);
    const b = await inner(x + 1);
    return a + b;
  }
  async function inner(x: number): Promise<number> {
    return await Promise.resolve(x + 1);
  }
  export function run(): Promise<number> {
    return outer(5);
  }
`;

const GENERIC_ISSUANCE_SOURCE = `
  declare function pending(value: number): Promise<number>;
  export async function owner(seed: number): Promise<number> {
    const value = await callee(seed);
    return value + 1;
  }
  export async function callee(seed: number): Promise<number> {
    const value = await pending(seed + 1);
    return value + 2;
  }
  export function caller(seed: number): Promise<number> { return owner(seed); }
`;

type MutableIdentity = IrPlanningIdentityContext & {
  readonly unitIdByDeclaration: Map<ts.Node, IrUnitId>;
  readonly declarationByUnitId: Map<IrUnitId, ts.Node>;
  readonly terminalByUnitId: Map<IrUnitId, IrTerminalUnitRecord>;
  readonly sourceFileBySourceId: Map<IrSourceId, ts.SourceFile>;
};

interface GenericIssuanceProbe {
  readonly ctx: ReturnType<typeof createCodegenContext>;
  readonly identity: MutableIdentity;
  readonly owner: ts.FunctionDeclaration;
  readonly callee: ts.FunctionDeclaration;
  readonly caller: ts.FunctionDeclaration;
  readonly awaitSite: ts.AwaitExpression;
  readonly plan: IrOverlayIdentityPlan;
  readonly ownerId: IrUnitId;
  readonly calleeId: IrUnitId;
}

function makeGenericIssuanceProbe(label: string, source = GENERIC_ISSUANCE_SOURCE): GenericIssuanceProbe {
  const ast = analyzeSource(source, `issue-3527-generic-issuance-${label}.ts`);
  const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker });
  const original = buildIrPlanningIdentityContext(inventory);
  const identity = {
    ...original,
    unitIdByDeclaration: new Map(original.unitIdByDeclaration),
    declarationByUnitId: new Map(original.declarationByUnitId),
    terminalByUnitId: new Map(original.terminalByUnitId),
    sourceFileBySourceId: new Map(original.sourceFileBySourceId),
  } as MutableIdentity;
  const mod = createEmptyModule();
  const ctx = createCodegenContext(
    mod,
    ast.checker,
    { experimentalIR: true, trackIrOutcomes: true, target: "gc" },
    new ProgramAbiSession(inventory, mod),
    identity,
  );
  ctx.callableSourceFiles = [ast.sourceFile];
  const declarations = ast.sourceFile.statements.filter(ts.isFunctionDeclaration);
  const owner = declarations.find((declaration) => declaration.name?.text === "owner");
  const callee = declarations.find((declaration) => declaration.name?.text === "callee");
  const caller = declarations.find((declaration) => declaration.name?.text === "caller");
  let awaitSite: ts.AwaitExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) awaitSite ??= node;
    ts.forEachChild(node, visit);
  };
  if (owner) visit(owner);
  const ownerId = owner === undefined ? undefined : identity.unitIdByDeclaration.get(owner);
  const calleeId = callee === undefined ? undefined : identity.unitIdByDeclaration.get(callee);
  if (!owner || !callee || !caller || !awaitSite || !ownerId || !calleeId) {
    throw new Error(`generic issuance fixture failed for ${label}`);
  }
  const maps = buildIrOverlayIdentityMaps(ast.sourceFile, ast.checker, identity);
  const plan = planIrOverlayByIdentity(ast.sourceFile, identity, {}, maps);
  return { ctx, identity, owner, callee, caller, awaitSite, plan, ownerId, calleeId };
}

function issueGenericOwner(probe: GenericIssuanceProbe): ReadonlySet<IrUnitId> {
  const owners = preparedIrAsyncPromiseOwnerUnitIds(probe.ctx);
  expect(owners.has(probe.ownerId)).toBe(true);
  expect(prepareAsyncCallableAbi(probe.ctx, probe.owner, [{ kind: "f64" }], [{ kind: "f64" }])[1]).toEqual([
    { kind: "externref" },
  ]);
  return owners;
}

function expectGenericProofLost(probe: GenericIssuanceProbe): void {
  expect(preparedIrAsyncPromiseOwnerWasIssued(probe.ctx, probe.owner)).toBe(true);
  for (const action of Object.values(genericHandoffs(probe))) {
    expect(action).toThrowError(
      expect.objectContaining({
        code: "selection-preparation-mismatch",
        stage: "resolve",
        message: expect.stringContaining(probe.ownerId),
      }),
    );
  }
}

function genericHandoffs(probe: GenericIssuanceProbe) {
  return {
    abi: () => prepareAsyncCallableAbi(probe.ctx, probe.owner, [{ kind: "f64" }], [{ kind: "f64" }]),
    suspension: () => preparedIrAsyncSourceCanSuspend(probe.ctx, probe.owner),
    peer: () => preparedIrAsyncSourceCanSuspend(probe.ctx, probe.callee),
    await: () => preparedIrAsyncAwaitSite(probe.ctx, probe.awaitSite),
    population: () => preparedIrAsyncPromiseOwnerUnitIds(probe.ctx),
    // A lost selector claim must not hide the already-issued original owner.
    r3: () => collectPreparedIrAsyncOwners(probe.ctx, { ...probe.plan, functionClaims: [] }, new Set()),
  };
}

function outcome(result: CompileResult, name: string) {
  const row = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  if (!row) throw new Error(`missing IR outcome for ${name}`);
  return row;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function expectSuccessful(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
}

describe("#3527 async Promise owner call closure", () => {
  it("withdraws a real-suspending component with a raw C1 consumer before Promise ABI publication", async () => {
    const [ir, legacy] = await Promise.all([
      compile(RAW_C1_CONSUMER_SOURCE, {
        fileName: "issue-3527-async-call-closure-raw.ts",
        target: "gc",
        experimentalIR: true,
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
      }),
      compile(RAW_C1_CONSUMER_SOURCE, {
        fileName: "issue-3527-async-call-closure-raw.ts",
        target: "gc",
        experimentalIR: false,
        skipSemanticDiagnostics: true,
      }),
    ]);
    expectSuccessful(ir);
    expectSuccessful(legacy);
    expect(bytesEqual(new Uint8Array(ir.binary), new Uint8Array(legacy.binary))).toBe(true);

    for (const name of ["inner", "outer"]) {
      expect(outcome(ir, name)).toMatchObject({
        kind: "unsupported",
        code: "late-preparation-unsupported",
        directBodyEmissions: 1,
        irBodyEmissions: 0,
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
    }
    expect(ir.irCompiledFuncs ?? []).not.toContain("inner");
    expect(ir.irCompiledFuncs ?? []).not.toContain("outer");
    expect(outcome(ir, "run")).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      directBodyEmissions: 1,
      irBodyEmissions: 0,
    });
    const imports = buildCompiledImports(ir);
    const { instance } = await WebAssembly.instantiate(ir.binary, imports as WebAssembly.Imports);
    imports.setInstance?.(instance);
    const legacyImports = buildCompiledImports(legacy);
    const legacyInstance = await WebAssembly.instantiate(legacy.binary, legacyImports as WebAssembly.Imports);
    legacyImports.setInstance?.(legacyInstance.instance);
    // The unsupported numeric cast retains the direct engine's behavior;
    // canonical no-await async semantics are outside this ABI repair.
    expect((instance.exports as unknown as { run: () => unknown }).run()).toBe(
      (legacyInstance.instance.exports as unknown as { run: () => unknown }).run(),
    );
  });

  it("settles a provider-backed async component by exact identity and publishes native Promises", async () => {
    const result = await compile(PROMISE_CLOSURE_SOURCE, {
      fileName: "issue-3527-async-call-closure-provider.ts",
      target: "gc",
      experimentalIR: true,
      trackIrOutcomes: true,
      skipSemanticDiagnostics: true,
    });
    expectSuccessful(result);

    for (const name of ["inner", "outer"]) {
      expect(outcome(result, name)).toMatchObject({
        kind: "emitted",
        directBodyEmissions: 0,
        irBodyEmissions: 1,
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
    }
    expect(outcome(result, "run")).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      directBodyEmissions: 1,
      irBodyEmissions: 0,
    });

    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setInstance?.(instance);
    const run = (instance.exports as unknown as { run: () => unknown }).run();
    expect(run).toBeInstanceOf(Promise);
    await expect(run).resolves.toBe(13);
  });

  it("fails closed after the issued declaration-to-unit join disappears", () => {
    const probe = makeGenericIssuanceProbe("missing-unit-id");
    issueGenericOwner(probe);
    probe.identity.unitIdByDeclaration.delete(probe.owner);
    expectGenericProofLost(probe);
    probe.identity.unitIdByDeclaration.set(probe.owner, probe.ownerId);
    expectGenericProofLost(probe);
  });

  it("fails closed after the issued declaration is rebound to another UnitId", () => {
    const probe = makeGenericIssuanceProbe("rebound-unit-id");
    issueGenericOwner(probe);
    probe.identity.unitIdByDeclaration.set(probe.owner, probe.calleeId);
    expectGenericProofLost(probe);
  });

  it("fails closed after the issued terminal record disappears", () => {
    const probe = makeGenericIssuanceProbe("terminal-loss");
    issueGenericOwner(probe);
    probe.identity.terminalByUnitId.delete(probe.ownerId);
    expectGenericProofLost(probe);
  });

  it.each(["abi", "suspension", "peer", "await", "population", "r3"] as const)(
    "detects identity loss first at the %s handoff",
    (handoff) => {
      const probe = makeGenericIssuanceProbe(`first-${handoff}`);
      issueGenericOwner(probe);
      probe.identity.unitIdByDeclaration.delete(probe.owner);
      // No other handoff has marked this receipt invalid yet.
      expect(genericHandoffs(probe)[handoff]).toThrowError(
        expect.objectContaining({
          code: "selection-preparation-mismatch",
          message: expect.stringContaining(probe.ownerId),
        }),
      );
    },
  );

  it("reports generic identity loss before a direct body can replace the promised ABI", async () => {
    const fileName = "issue-3527-generic-identity-loss-e2e.ts";
    const originalGet = Map.prototype.get;
    let injected = 0;
    Map.prototype.get = function (key: unknown): unknown {
      if (
        typeof key === "object" &&
        key !== null &&
        ts.isFunctionDeclaration(key as ts.Node) &&
        (key as ts.FunctionDeclaration).name?.text === "outer" &&
        (key as ts.Node).getSourceFile().fileName.endsWith(fileName) &&
        (new Error().stack ?? "").includes("promiseOwnerIdentityIsCurrent")
      ) {
        injected++;
        return undefined;
      }
      return originalGet.call(this, key);
    };
    let result: CompileResult;
    try {
      result = await compile(PROMISE_CLOSURE_SOURCE, {
        fileName,
        target: "gc",
        experimentalIR: true,
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
      });
    } finally {
      Map.prototype.get = originalGet;
    }
    expect(injected).toBeGreaterThan(0);
    expect(result.success).toBe(false);
    const row = outcome(result, "outer");
    expect(row).toMatchObject({
      kind: "invariant",
      code: "selection-preparation-mismatch",
      legacyBodyEmitted: false,
      irBodyEmitted: false,
    });
    expect(row.directBodyEmissions ?? 0).toBe(0);
    expect(row.irBodyEmissions ?? 0).toBe(0);
    expect(row.detail).toContain("lost its source proof");
  });

  it.each(["missing", "numeric-result", "missing-parameter"] as const)(
    "rejects the %s allocated Promise slot at final R3 preparation",
    async (mutation) => {
      const fileName = `issue-3527-generic-r3-${mutation}.ts`;
      const registryPrototype = ProgramAbiSourceCallableRegistry.prototype;
      const originalLookup = registryPrototype.functionForUnit;
      let injected = 0;
      registryPrototype.functionForUnit = function (unitId) {
        const func = originalLookup.call(this, unitId);
        const declaration = this.identityContext?.declarationByUnitId.get(unitId);
        if (
          func &&
          declaration &&
          ts.isFunctionDeclaration(declaration) &&
          declaration.name?.text === "outer" &&
          declaration.getSourceFile().fileName.endsWith(fileName) &&
          (new Error().stack ?? "").includes("r3SuspendingAsyncSignatureMatchesAllocatedSlot")
        ) {
          injected++;
          if (mutation === "missing") return undefined;
          const typeIdx =
            mutation === "numeric-result"
              ? addFuncType(this.ctx, [{ kind: "f64" }], [{ kind: "f64" }])
              : addFuncType(this.ctx, [], [{ kind: "externref" }]);
          return { ...func, typeIdx };
        }
        return func;
      };
      let result: CompileResult;
      try {
        result = await compile(PROMISE_CLOSURE_SOURCE, {
          fileName,
          target: "gc",
          experimentalIR: true,
          trackIrOutcomes: true,
          skipSemanticDiagnostics: true,
        });
      } finally {
        registryPrototype.functionForUnit = originalLookup;
      }
      expect(injected).toBeGreaterThan(0);
      expect(result.success).toBe(false);
      const row = outcome(result, "outer");
      expect(row).toMatchObject({
        kind: "invariant",
        code: "selection-preparation-mismatch",
        legacyBodyEmitted: false,
        irBodyEmitted: false,
      });
      expect(row.directBodyEmissions ?? 0).toBe(0);
      expect(row.irBodyEmissions ?? 0).toBe(0);
      expect(row.detail).toContain("lost its issued allocated ABI");
    },
  );

  it("keeps the issued ABI after callers cannot mutate the owner collection", () => {
    const probe = makeGenericIssuanceProbe("immutable-population");
    const owners = issueGenericOwner(probe);
    expect((owners as Readonly<{ clear?: unknown }>).clear).toBeUndefined();
    expect(() => Set.prototype.clear.call(owners)).toThrow(TypeError);
    expect(() => Set.prototype.delete.call(owners, probe.ownerId)).toThrow(TypeError);
    expect(() => Set.prototype.add.call(owners, probe.calleeId)).toThrow(TypeError);
    expect(Object.isFrozen(owners)).toBe(true);
    expect([...owners]).toEqual(expect.arrayContaining([probe.ownerId, probe.calleeId]));
    expect(prepareAsyncCallableAbi(probe.ctx, probe.owner, [{ kind: "f64" }], [{ kind: "f64" }])[1]).toEqual([
      { kind: "externref" },
    ]);
  });

  it("rejects a stale outgoing source contract while the owner identity remains valid", () => {
    const probe = makeGenericIssuanceProbe("stale-outgoing-contract");
    issueGenericOwner(probe);
    // Keep owner's reverse identity intact while redirecting its known async
    // callee to the owner's UnitId. The retained closure fingerprint must
    // reject this contradiction instead of accepting a replacement edge.
    probe.identity.unitIdByDeclaration.set(probe.callee, probe.ownerId);
    expectGenericProofLost(probe);
  });

  it("rejects a changed incoming return contract with every identity join intact", () => {
    const probe = makeGenericIssuanceProbe("incoming-return-contract");
    issueGenericOwner(probe);
    const signatureOf = probe.ctx.oracle.signatureOf;
    probe.ctx.oracle.signatureOf = function (node) {
      const signature = signatureOf.call(this, node);
      return node === probe.caller && signature ? { ...signature, returns: { kind: "number" } } : signature;
    };
    try {
      expectGenericProofLost(probe);
    } finally {
      probe.ctx.oracle.signatureOf = signatureOf;
    }
  });

  it("keeps proof loss fatal when the issued owner's current body is absent", () => {
    const probe = makeGenericIssuanceProbe("missing-body");
    issueGenericOwner(probe);
    const mutableOwner = probe.owner as unknown as { body: ts.Block | undefined };
    const body = mutableOwner.body;
    mutableOwner.body = undefined;
    try {
      expectGenericProofLost(probe);
    } finally {
      mutableOwner.body = body;
    }
    expectGenericProofLost(probe);
  });

  it.each([
    "owner-reverse",
    "callee-reverse",
    "callee-terminal",
    "caller-reverse",
    "caller-terminal",
    "source-reverse",
  ])("authenticates the retained %s join at every post-issuance handoff", (mutation) => {
    const probe = makeGenericIssuanceProbe(mutation);
    issueGenericOwner(probe);
    const callerId = probe.identity.unitIdByDeclaration.get(probe.caller)!;
    if (mutation === "owner-reverse") probe.identity.declarationByUnitId.delete(probe.ownerId);
    if (mutation === "callee-reverse") probe.identity.declarationByUnitId.delete(probe.calleeId);
    if (mutation === "callee-terminal") probe.identity.terminalByUnitId.delete(probe.calleeId);
    if (mutation === "caller-reverse") probe.identity.declarationByUnitId.delete(callerId);
    if (mutation === "caller-terminal") probe.identity.terminalByUnitId.delete(callerId);
    if (mutation === "source-reverse") probe.identity.sourceFileBySourceId.clear();
    expectGenericProofLost(probe);
  });

  it("does not replace an issued physical parameter/result contract", () => {
    const probe = makeGenericIssuanceProbe("physical-abi-change");
    issueGenericOwner(probe);
    expect(() => prepareAsyncCallableAbi(probe.ctx, probe.owner, [], [{ kind: "f64" }])).toThrow(
      /lost its source proof/,
    );
    expectGenericProofLost(probe);
  });

  it("rejects a callee's contradictory physical ABI after a caller has issued", () => {
    const probe = makeGenericIssuanceProbe("callee-physical-abi-change");
    issueGenericOwner(probe);
    expect(() => prepareAsyncCallableAbi(probe.ctx, probe.callee, [{ kind: "i32" }], [{ kind: "f64" }])).toThrow(
      /lost its source proof/,
    );
    expectGenericProofLost(probe);
  });

  it("rejects a numeric-vector slot substituted for the callee's numeric parameter", () => {
    const probe = makeGenericIssuanceProbe("callee-vector-abi-change");
    issueGenericOwner(probe);
    const typeIdx = getOrRegisterVecType(probe.ctx, "f64", { kind: "f64" });
    expect(() =>
      prepareAsyncCallableAbi(probe.ctx, probe.callee, [{ kind: "ref_null", typeIdx }], [{ kind: "f64" }]),
    ).toThrow(/lost its source proof/);
    expectGenericProofLost(probe);
  });

  it("rejects a callee's missing numeric fulfillment after a caller has issued", () => {
    const probe = makeGenericIssuanceProbe("callee-void-abi-change");
    issueGenericOwner(probe);
    expect(() => prepareAsyncCallableAbi(probe.ctx, probe.callee, [{ kind: "f64" }], [])).toThrow(
      /lost its source proof/,
    );
    expectGenericProofLost(probe);
  });

  it("withdraws an observed incompatible callee before any Promise ABI is issued", () => {
    const probe = makeGenericIssuanceProbe("preclaim-physical-abi");
    expect(preparedIrAsyncPromiseOwnerUnitIds(probe.ctx).has(probe.ownerId)).toBe(true);
    expect(prepareAsyncCallableAbi(probe.ctx, probe.callee, [{ kind: "i32" }], [{ kind: "f64" }])[1]).toEqual([
      { kind: "f64" },
    ]);
    expect(preparedIrAsyncPromiseOwnerUnitIds(probe.ctx).size).toBe(0);
    expect(prepareAsyncCallableAbi(probe.ctx, probe.owner, [{ kind: "f64" }], [{ kind: "f64" }])[1]).toEqual([
      { kind: "f64" },
    ]);
    expect(preparedIrAsyncPromiseOwnerWasIssued(probe.ctx, probe.owner)).toBe(false);
  });

  it("does not use a numeric checker type as evidence of an explicit i32 callee carrier", () => {
    const source = `type i32 = number;\n${GENERIC_ISSUANCE_SOURCE.replace("callee(seed: number)", "callee(seed: i32)")}`;
    const probe = makeGenericIssuanceProbe("native-i32-callee", source);
    expect(probe.ctx.checker.typeToString(probe.ctx.checker.getTypeAtLocation(probe.callee.parameters[0]!))).toBe(
      "number",
    );
    expect(preparedIrAsyncPromiseOwnerUnitIds(probe.ctx).size).toBe(0);
    expect(prepareAsyncCallableAbi(probe.ctx, probe.owner, [{ kind: "f64" }], [{ kind: "f64" }])[1]).toEqual([
      { kind: "f64" },
    ]);
    expect(prepareAsyncCallableAbi(probe.ctx, probe.callee, [{ kind: "i32" }], [{ kind: "f64" }])[1]).toEqual([
      { kind: "f64" },
    ]);
  });

  it("declines an asserted numeric await consumer before promoting its callee", () => {
    const source = GENERIC_ISSUANCE_SOURCE.replace("await callee(seed)", "await (callee(seed) as any as number)");
    const probe = makeGenericIssuanceProbe("asserted-await-consumer", source);
    expect(preparedIrAsyncPromiseOwnerUnitIds(probe.ctx).size).toBe(0);
    expect(prepareAsyncCallableAbi(probe.ctx, probe.owner, [{ kind: "f64" }], [{ kind: "f64" }])[1]).toEqual([
      { kind: "f64" },
    ]);
    expect(preparedIrAsyncPromiseOwnerWasIssued(probe.ctx, probe.owner)).toBe(false);
  });
});
