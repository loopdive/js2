// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #1042/#1373b — AST-free IrAsyncPlan and canonical Promise ABI. */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile } from "../../src/index.js";
import {
  asAsyncHandlerId,
  asAsyncStateId,
  canonicalPromiseAbi,
  createIrAsyncPlan,
  hashIrAsyncPlan,
  serializeIrAsyncPlan,
  verifyIrAsyncPlan,
  type IrAsyncPlan,
} from "../../src/ir/async-plan.js";
import { createIrBindingId, createIrSourceId, createIrUnitId } from "../../src/ir/identity.js";
import { asValueId, irVal, type IrType } from "../../src/ir/nodes.js";
import { evaluateIrOutcomePolicy } from "../../src/ir/outcomes.js";
import { ASYNC_RUNTIME_FEATURES } from "../../src/ir/async-runtime-providers.js";
import { compileToWasm } from "../equivalence/helpers.js";

const EXTERN: IrType = irVal({ kind: "externref" });
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });

function ownerUnitId() {
  const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "tests/async-plan.ts" });
  return createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "function-declaration", ordinal: 0 });
}

/**
 * Two suspensions, a conditional loop back-edge, and a rejection handler.
 * Values 1/2 are genuinely live across both suspension points.
 */
function makePlan(): IrAsyncPlan {
  const owner = ownerUnitId();
  const nextBinding = createIrBindingId({ ownerId: owner, domain: "support", role: "next-promise" });
  const promise = asValueId(0);
  const condition = asValueId(1);
  const accumulator = asValueId(2);
  const resumed = asValueId(3);
  const sum = asValueId(4);
  const nextPromise = asValueId(5);
  const rejection = asValueId(6);
  const entry = asAsyncStateId(0);
  const loop = asAsyncStateId(1);
  const suspendAgain = asAsyncStateId(2);
  const done = asAsyncStateId(3);
  const caught = asAsyncStateId(4);
  const handler = asAsyncHandlerId(0);
  return {
    schemaVersion: 1,
    ownerUnitId: owner,
    kind: "async-function",
    abi: canonicalPromiseAbi(F64),
    entry,
    params: [
      { value: promise, type: EXTERN },
      { value: condition, type: I32 },
    ],
    values: [
      { value: promise, type: EXTERN },
      { value: condition, type: I32 },
      { value: accumulator, type: F64 },
      { value: resumed, type: F64 },
      { value: sum, type: F64 },
      { value: nextPromise, type: EXTERN },
      { value: rejection, type: EXTERN },
    ],
    spills: [
      { value: condition, type: I32, storage: "slot" },
      { value: accumulator, type: F64, storage: "ref-cell" },
    ],
    states: [
      {
        id: entry,
        body: [{ kind: "const", value: { kind: "f64", value: 0 }, result: accumulator, resultType: F64 }],
        terminator: {
          kind: "suspend",
          awaited: promise,
          resume: { state: loop, value: resumed },
          rejected: { kind: "handler", handler },
          live: [accumulator, condition],
        },
      },
      {
        id: loop,
        resume: { value: resumed, type: F64, source: "fulfilled" },
        body: [
          {
            kind: "binary",
            op: "f64.add",
            lhs: accumulator,
            rhs: resumed,
            result: sum,
            resultType: F64,
          },
        ],
        updates: [{ target: accumulator, value: sum }],
        terminator: { kind: "branch", condition, ifTrue: suspendAgain, ifFalse: done },
      },
      {
        id: suspendAgain,
        body: [
          {
            kind: "call",
            target: { kind: "func", name: "nextPromise", binding: { kind: "support", bindingId: nextBinding } },
            args: [sum],
            result: nextPromise,
            resultType: EXTERN,
          },
        ],
        terminator: {
          kind: "suspend",
          awaited: nextPromise,
          resume: { state: loop, value: resumed },
          rejected: { kind: "handler", handler },
          live: [condition, accumulator],
        },
      },
      { id: done, body: [], terminator: { kind: "resolve", value: sum } },
      {
        id: caught,
        resume: { value: rejection, type: EXTERN, source: "rejected" },
        body: [],
        terminator: { kind: "reject", reason: rejection },
      },
    ],
    handlers: [{ id: handler, kind: "catch", entry: caught, parent: null }],
    runtimeIntents: [
      "promise.capability.create",
      "promise.resolve",
      "promise.react",
      "promise.settle.fulfill",
      "promise.settle.reject",
      "scheduler.enqueue",
      "scheduler.drain",
    ],
  };
}

function errorCodes(plan: IrAsyncPlan): string[] {
  return verifyIrAsyncPlan(plan).map((error) => error.code);
}

describe("#1373b IrAsyncPlan contract", () => {
  it("verifies, canonicalizes, freezes, and hashes a two-suspend loop/handler plan", () => {
    const plan = createIrAsyncPlan(makePlan());
    expect(verifyIrAsyncPlan(plan)).toEqual([]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.states)).toBe(true);
    expect(plan.states.map((state) => state.id)).toEqual([0, 1, 2, 3, 4]);
    expect(plan.states[0]?.terminator).toMatchObject({ kind: "suspend", live: [1, 2] });
    expect(hashIrAsyncPlan(plan)).toMatch(/^ir-async-plan:v1:[0-9a-f]{16}$/);
  });

  it("canonicalizes plan order independently of any backend target", () => {
    const prepared = (["host", "standalone", "wasi"] as const).map((_target) => {
      // Target choice is intentionally unavailable to the plan producer.
      const plan = makePlan();
      plan.states.reverse();
      plan.runtimeIntents.reverse();
      return { serialized: serializeIrAsyncPlan(plan), hash: hashIrAsyncPlan(plan) };
    });
    expect(new Set(prepared.map((item) => item.serialized)).size).toBe(1);
    expect(new Set(prepared.map((item) => item.hash)).size).toBe(1);
  });

  it("uses the shared semantic vocabulary and rejects concrete host adapter names", () => {
    const plan = makePlan();
    expect(new Set(plan.runtimeIntents)).toEqual(new Set(ASYNC_RUNTIME_FEATURES));
    for (const adapter of [
      "Promise_new_pending",
      "Promise_resolve",
      "Promise_then2",
      "__make_callback",
      "Promise_settle_resolve",
      "Promise_settle_reject",
    ]) {
      expect(serializeIrAsyncPlan(plan)).not.toContain(adapter);
    }

    (plan as { runtimeIntents: readonly string[] }).runtimeIntents = [...plan.runtimeIntents, "Promise_resolve"];
    expect(errorCodes(plan)).toContain("unknown-runtime-intent");
  });

  it("fails closed on an unknown state and handler", () => {
    const plan = makePlan();
    const first = plan.states[0]!;
    (first as { terminator: unknown }).terminator = {
      ...first.terminator,
      resume: { state: asAsyncStateId(99), value: asValueId(3) },
      rejected: { kind: "handler", handler: asAsyncHandlerId(99) },
    };
    expect(errorCodes(plan)).toEqual(expect.arrayContaining(["unknown-state", "unknown-handler"]));
  });

  it("fails closed when cross-suspend liveness is missing or over-reported", () => {
    const missing = makePlan();
    const first = missing.states[0]!;
    (first as { terminator: unknown }).terminator = { ...first.terminator, live: [asValueId(1)] };
    expect(errorCodes(missing)).toContain("liveness-mismatch");

    const extra = makePlan();
    const again = extra.states[2]!;
    (again as { terminator: unknown }).terminator = {
      ...again.terminator,
      live: [asValueId(0), asValueId(1), asValueId(2)],
    };
    expect(errorCodes(extra)).toContain("liveness-mismatch");
  });

  it("verifies typed loop-carried spill updates and canonicalizes their order", () => {
    const plan = makePlan();
    expect(verifyIrAsyncPlan(plan)).toEqual([]);
    expect(createIrAsyncPlan(plan).states[1]?.updates).toEqual([{ target: asValueId(2), value: asValueId(4) }]);

    const unknownTarget = makePlan();
    (unknownTarget.states[1] as { updates: unknown }).updates = [{ target: asValueId(0), value: asValueId(4) }];
    expect(errorCodes(unknownTarget)).toContain("unknown-spill-update");

    const duplicate = makePlan();
    (duplicate.states[1] as { updates: unknown }).updates = [
      { target: asValueId(2), value: asValueId(4) },
      { target: asValueId(2), value: asValueId(4) },
    ];
    expect(errorCodes(duplicate)).toContain("duplicate-spill-update");

    const wrongType = makePlan();
    (wrongType.states[1] as { updates: unknown }).updates = [{ target: asValueId(1), value: asValueId(4) }];
    expect(errorCodes(wrongType)).toContain("spill-update-type-mismatch");

    const updatedParam = makePlan();
    (updatedParam.states[1] as { updates: unknown }).updates = [{ target: asValueId(1), value: asValueId(1) }];
    expect(errorCodes(updatedParam)).toContain("invalid-spill-update");

    const crossDependent = makePlan();
    crossDependent.values.push({ value: asValueId(7), type: F64 });
    crossDependent.spills.push({ value: asValueId(7), type: F64, storage: "ssa" });
    crossDependent.states[0]!.body.push({
      kind: "const",
      value: { kind: "f64", value: 1 },
      result: asValueId(7),
      resultType: F64,
    });
    (crossDependent.states[1] as { updates: unknown }).updates = [
      { target: asValueId(2), value: asValueId(7) },
      { target: asValueId(7), value: asValueId(2) },
    ];
    expect(errorCodes(crossDependent)).toContain("invalid-spill-update");
  });

  it("rejects ordinary control-flow edges into fulfilled and rejected resume states", () => {
    const fulfilled = makePlan();
    (fulfilled.states[2] as { terminator: unknown }).terminator = {
      kind: "goto",
      target: asAsyncStateId(1),
    };
    expect(errorCodes(fulfilled)).toContain("invalid-resume");

    const rejected = makePlan();
    (rejected.states[3] as { terminator: unknown }).terminator = {
      kind: "goto",
      target: asAsyncStateId(4),
    };
    expect(errorCodes(rejected)).toContain("invalid-resume");
  });

  it("rejects callbacks, AST objects, raw Wasm, and concrete backend indices", () => {
    const plan = makePlan() as IrAsyncPlan & Record<string, unknown>;
    plan.emit = () => [];
    plan.sourceNode = { kind: 263, pos: 0, end: 1 };
    plan.backend = "wasmgc";
    plan.wasmType = { typeIdx: 4 };
    plan.states[0]!.body.push({ kind: "raw.wasm", result: null, resultType: null, ops: [], stackDelta: 0 });
    const errors = verifyIrAsyncPlan(plan).filter((error) => error.code === "forbidden-data");
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });

  it("rejects the legacy raw-value/thenable ABI and missing scheduler intents", () => {
    const plan = makePlan();
    (plan as { abi: unknown }).abi = {
      ...plan.abi,
      consumerContract: "raw-or-promise",
      settlementTiming: "sometimes-sync",
    };
    (plan as { runtimeIntents: readonly string[] }).runtimeIntents = ["promise.capability.create"];
    expect(errorCodes(plan)).toEqual(expect.arrayContaining(["invalid-abi", "missing-runtime-intent"]));
  });

  it("rejects undeclared definitions and async control left inside state bodies", () => {
    const missingDefinition = makePlan();
    missingDefinition.values.push({ value: asValueId(7), type: F64 });
    expect(errorCodes(missingDefinition)).toContain("missing-value-definition");

    const hiddenAwait = makePlan();
    hiddenAwait.states[0]!.body.push({
      kind: "await",
      operand: asValueId(0),
      result: null,
      resultType: null,
    });
    expect(errorCodes(hiddenAwait)).toContain("unlowered-async-control");
  });
});

describe("#1042/#1373b async migration anti-vacuity", () => {
  it("IR-emits the complete playground async family with no IR-only blocker", async () => {
    const source = readFileSync(new URL("../../website/playground/examples/js/async.ts", import.meta.url), "utf8");
    const result = await compile(source, {
      fileName: "website/playground/examples/js/async.ts",
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(true);
    const family = ["delay", "fetchUser", "fetchAllSequential", "fetchAllParallel", "main"].map((name) =>
      (result.irOutcomes ?? []).find((outcome) => outcome.displayName === name),
    );
    expect(family).toHaveLength(5);
    expect(family.every((outcome) => outcome?.kind === "emitted")).toBe(true);
    expect(
      family.every(
        (outcome) =>
          outcome?.legacyBodyEmitted === false &&
          outcome.irBodyEmitted === true &&
          outcome.preparedComponentId?.startsWith("prepared-component:"),
      ),
    ).toBe(true);
    expect(
      evaluateIrOutcomePolicy(
        family.filter((outcome) => outcome !== undefined),
        "ir-only",
      ),
    ).toMatchObject({
      ready: true,
      blockers: [],
    });
  });

  it("preserves the existing frame engine's real two-suspension execution", async () => {
    const exports = await compileToWasm(`
      async function f(): Promise<number> {
        const a = await Promise.resolve(20).then((x: number) => x + 1);
        const b = await Promise.resolve(20).then((x: number) => x + 1);
        return a + b;
      }
      export async function main(): Promise<number> { return await f(); }
    `);
    await expect(Promise.resolve(exports.main())).resolves.toBe(42);
  });
});
