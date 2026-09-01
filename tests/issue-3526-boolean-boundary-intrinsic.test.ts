// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3526 F1-S2 — the synchronous boolean boundary as ONE semantic intrinsic.
//
// This is the LAST resolver-mode predicate at the from-ast externref-coercion
// boundary. `hasHostBooleanBox()` — a lane fact read in the front-end — is
// deleted; the branded-i32 gate (a TYPE fact, #4503) stays. Which provider, if
// any, answers `js.boolean.box` is decided once, at manifest freeze, from the
// caller-resolved boolean-boundary policy.
//
// What these tests protect (the six behaviour-neutrality obligations of the
// 2026-09-01 F1-S2 plan):
//
//  1. **Census.** Guarded by `pnpm run check:ir-fallbacks`, not by a unit test;
//     measured output-identical and recorded in the issue checkpoint.
//  2. **Import set AND order.** The migrated arm keeps the exact physical
//     `env.__box_boolean` target, and `addUnionImports` stays the whole
//     family's single materializer — reached through the ATTACHED PROVIDER
//     rather than a direct `call`. Asserted below, and non-vacuous: dropping
//     `js.boolean.box` from the preregistration recognizer shifts the module's
//     type indices (measured: the union family materializes later, moving
//     `__unbox_number` from type 11 to type 15).
//  3. **Byte parity.** All 25 measured cells (5 fixtures x gc-host /
//     gc-native-strings / standalone / WASI / linear) are byte-identical,
//     WAT included — this slice produced NO purity-class diff at all, because
//     the boxed boolean is consumed immediately by its element store and was
//     never anchored into a spill local. Recorded in the checkpoint.
//  4. **Outcome-code shift** (F1-S1 divergence-4 class): shapes that fell
//     through to the BUILD-time `operand-coercion-unsupported` demote on
//     no-box lanes now demote in PREPARATION as
//     `late-preparation-unsupported` / `resolve`. Both demote to legacy and
//     the emitted bytes are identical. Asserted below.
//  5. **Non-vacuity.** Reverting ONLY the from-ast arm (keeping the schema)
//     fails two named tests here — "lowers the branded carrier to the
//     provider-free intrinsic" (the intrinsic-emission assertion) and
//     "demotes only the requesting owner ..." (the owner-local demote code) —
//     while every schema/policy test above them stays green.
//  6. **Unchanged emission population.** The predicate never gated which
//     shapes REACH the arm, only demote-vs-box. Asserted directly: the
//     lowered IR is byte-for-byte the same under a resolver that answers the
//     old predicate `false` as under one that answers it `true`, because the
//     front-end no longer asks.
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import {
  ASYNC_HOST_CAPABILITY_RECORDS,
  ASYNC_RUNTIME_FEATURES,
  asAsyncHostAdapter,
} from "../src/ir/async-runtime-providers.js";
import { irImportFuncRef, irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import {
  intrinsicEffectEvidence,
  BOOLEAN_BOUNDARY_INTRINSIC_IDS,
  BOOLEAN_BOUNDARY_RUNTIME_FEATURES,
  I32_TO_EXTERNREF_INTRINSIC_SIGNATURE,
  INTRINSIC_DEFINITIONS,
  INTRINSIC_SIGNATURE_VERSION,
  NUMBER_BOUNDARY_INTRINSIC_IDS,
  NUMBER_BOUNDARY_RUNTIME_FEATURES,
} from "../src/ir/intrinsics.js";
import {
  asBlockId,
  asValueId,
  forEachInstrDeep,
  irVal,
  irVec,
  type IrFunction,
  type IrInstr,
  type IrInstrIntrinsic,
  type IrType,
} from "../src/ir/nodes.js";
import {
  BOOLEAN_BOUNDARY_POLICY_DISABLED,
  NUMBER_BOUNDARY_POLICY_DISABLED,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  type BooleanBoundaryPolicy,
  type RuntimeManifestPolicy,
} from "../src/ir/runtime-manifest.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import { ts } from "../src/ts-api.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-boolean-boundary");
const I32 = irVal({ kind: "i32" });
const EXTERNREF = irVal({ kind: "externref" });

const HOST_BOOLEAN: BooleanBoundaryPolicy = { box: "host" };

/**
 * The one measured shape that both IR-SELECTS and reaches the arm: an element
 * store of a comparison result into an `any[]` (externref-element) vector.
 * Eight other candidates (`Map<number, boolean>.set`, `Set<boolean>.add`,
 * `any[].push`, `JSON.stringify`, template/string concat, an extern class
 * method, a DOM property write) all demote at IR SELECTION before reaching it.
 */
const BOOL_STORE_SOURCE = `function fill(a: any[], n: number): void { a[0] = n > 2; }`;

/**
 * `fill` rides the IR path; the exported `probe` stays on legacy and drives it,
 * so the module is callable from JS (an `any[]` parameter is a WasmGC vector,
 * not a JS array, and cannot cross the JS boundary directly). `typeof` is what
 * makes the answer load-bearing: boxing through `__box_number` instead would
 * store the NUMBER 1 and fail the `"boolean"` check.
 */
const RUNNABLE = `
${BOOL_STORE_SOURCE}
export function probe(n: number): number {
  const a: any[] = [0];
  fill(a, n);
  if (typeof a[0] !== "boolean") return -1;
  return a[0] === true ? 1 : 0;
}
`;

function instrsOf(fn: IrFunction): IrInstr[] {
  const found: IrInstr[] = [];
  const scan = (buffer: readonly IrInstr[]): void => {
    for (const root of buffer) forEachInstrDeep(root, (instr) => found.push(instr));
  };
  for (const block of fn.blocks) scan(block.instrs);
  for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  return found;
}

function intrinsicsOf(fn: IrFunction): IrInstrIntrinsic[] {
  return instrsOf(fn).filter((instr): instr is IrInstrIntrinsic => instr.kind === "intrinsic");
}

function callTargetNames(fn: IrFunction): string[] {
  return instrsOf(fn).flatMap((instr) => (instr.kind === "call" ? [instr.target.name] : []));
}

/**
 * Lower `fill` with the exact externref-element vector shape the compiler
 * gives it, plus the minimum resolver the element-store arm needs (a vec
 * lowering). `hasHostBooleanBox` is passed on purpose: it is now an UNREAD
 * property, which is what obligation 6 asserts.
 */
function lowerFill(hasHostBooleanBox: boolean): IrFunction {
  const analysis = analyzeSource(BOOL_STORE_SOURCE);
  const declaration = analysis.sourceFile.statements
    .filter(ts.isFunctionDeclaration)
    .find((candidate) => candidate.name?.text === "fill");
  if (!declaration) throw new Error("missing fill declaration");
  return lowerFunctionAstToIr(declaration, {
    ownerUnitId: identities.next("fill").unitId,
    exported: false,
    paramTypeOverrides: [irVec(EXTERNREF) as IrType, irVal({ kind: "f64" }) as IrType],
    resolver: {
      resolveVecForElement: (elementValType) => ({
        vecStructTypeIdx: 7,
        lengthFieldIdx: 0,
        dataFieldIdx: 1,
        arrayTypeIdx: 8,
        elementValType,
      }),
      hasHostBooleanBox: () => hasHostBooleanBox,
    },
  } as Parameters<typeof lowerFunctionAstToIr>[1]).main;
}

function policy(booleanBoundary: BooleanBoundaryPolicy): RuntimeManifestPolicy {
  return { target: "host", backend: "wasmgc", booleanBoundary };
}

/** One hand-built owner carrying exactly one boolean-box arm. */
function booleanFunction(name: string, provider?: IrInstrIntrinsic["provider"]): IrFunction {
  const instr: IrInstr = {
    kind: "intrinsic",
    id: "js.boolean.box",
    version: INTRINSIC_SIGNATURE_VERSION,
    args: [asValueId(0)],
    result: asValueId(1),
    resultType: EXTERNREF,
    ...(provider ? { provider } : {}),
  };
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [{ name: "flag", type: I32, value: asValueId(0) }],
    resultTypes: [I32],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [instr],
        terminator: { kind: "return", values: [asValueId(0)] },
      },
    ],
    exported: false,
    valueCount: 2,
    funcKind: "regular",
  };
}

function prepare(fn: IrFunction, booleanBoundary: BooleanBoundaryPolicy) {
  const prepared = prepareIrRuntimeManifest({
    functions: [fn],
    sourceFile: "/repo/boolean-boundary.ts",
    policy: policy(booleanBoundary),
  });
  if (!prepared) throw new Error("expected a non-empty runtime manifest");
  return prepared;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const found = result.irOutcomes?.filter((candidate) => candidate.displayName === name) ?? [];
  if (found.length !== 1) throw new Error(`expected exactly one IR outcome for ${name}, got ${found.length}`);
  return found[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, (n: number) => number>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, (n: number) => number>;
  (imports as { setExports?: (value: Record<string, (n: number) => number>) => void }).setExports?.(exports);
  return exports;
}

describe("#3526 F1-S2 boolean-boundary contract", () => {
  it("adds exactly ONE versioned ID with a 1:1 feature row and the exact carrier ABI", () => {
    expect(BOOLEAN_BOUNDARY_INTRINSIC_IDS).toEqual(["js.boolean.box"]);
    expect([...BOOLEAN_BOUNDARY_RUNTIME_FEATURES]).toEqual([...BOOLEAN_BOUNDARY_INTRINSIC_IDS]);
    expect(INTRINSIC_DEFINITIONS["js.boolean.box"].feature).toBe("js.boolean.box");
    expect(INTRINSIC_DEFINITIONS["js.boolean.box"].signature).toBe(I32_TO_EXTERNREF_INTRINSIC_SIGNATURE);
    expect(I32_TO_EXTERNREF_INTRINSIC_SIGNATURE.version).toBe(INTRINSIC_SIGNATURE_VERSION);
    expect(I32_TO_EXTERNREF_INTRINSIC_SIGNATURE.params).toEqual([I32]);
    expect(I32_TO_EXTERNREF_INTRINSIC_SIGNATURE.result).toEqual(EXTERNREF);

    // A SIBLING of the number family, never a widening of it. The one-armed
    // shape is deliberate: `__unbox_boolean` has no IR producer.
    expect(NUMBER_BOUNDARY_INTRINSIC_IDS).toEqual(["js.number.box", "js.number.unbox"]);
    expect([...NUMBER_BOUNDARY_RUNTIME_FEATURES]).toEqual([...NUMBER_BOUNDARY_INTRINSIC_IDS]);
    expect([...(NUMBER_BOUNDARY_INTRINSIC_IDS as readonly string[])]).not.toContain("js.boolean.box");
    expect(INTRINSIC_DEFINITIONS).not.toHaveProperty("js.boolean.unbox");
  });

  it("keeps ONE central catalogue, and the async projection excludes the row BY ID", () => {
    expect(resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "boolean.box")).toEqual({
      capability: "boolean.box",
      module: "env",
      field: "__box_boolean",
      kind: "func",
      params: ["i32"],
      results: ["externref"],
    });

    const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "boolean.box");
    // The load-bearing distinction from the number rows: EVERY value type on
    // this record IS admissible under `AsyncHostAdapterValueType`, so a
    // value-type filter would let it into the async projection. The seven-ID
    // filter is what keeps it out — never replace one with the other.
    for (const entry of [...record.params, ...record.results]) {
      expect(["externref", "i32"]).toContain(entry);
    }
    expect(ASYNC_HOST_CAPABILITY_RECORDS.map((entry) => entry.capability)).not.toContain("boolean.box");
    expect(() => asAsyncHostAdapter(record)).toThrowError(/is not an async capability/);
    // The projection is still the SAME frozen objects, minus the non-async rows.
    expect(ASYNC_HOST_CAPABILITY_RECORDS.every((entry) => RUNTIME_HOST_CAPABILITY_RECORDS.includes(entry))).toBe(true);
  });
});

describe("#3526 F1-S2 provider policy", () => {
  it("selects the exact host arm and its canonical capability record", () => {
    const prepared = prepare(booleanFunction("hostBox"), HOST_BOOLEAN);

    expect(prepared.manifest.policy.booleanBoundary).toEqual(HOST_BOOLEAN);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["host.js.boolean.box"]);
    expect(prepared.manifest.hostCapabilities).toEqual(["boolean.box"]);
    expect(prepared.manifest.hostCapabilityRecords.map((record) => record.field)).toEqual(["__box_boolean"]);
    for (const record of prepared.manifest.hostCapabilityRecords) {
      expect(RUNTIME_HOST_CAPABILITY_RECORDS).toContain(record);
    }
    // The physical target stays the existing union import, so raw consumers
    // and import order do not drift.
    expect(intrinsicsOf(prepared.functions[0]!).map((instr) => instr.provider)).toEqual([
      { kind: "callable", target: irImportFuncRef("env", "__box_boolean", "__box_boolean") },
    ]);
  });

  it("refuses the arm its caller resolved to unsupported, naming the intrinsic and the policy", () => {
    expect(() => prepare(booleanFunction("refused"), BOOLEAN_BOUNDARY_POLICY_DISABLED)).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "provider-target-unavailable" }),
    );
    expect(() => prepare(booleanFunction("refused2"), BOOLEAN_BOUNDARY_POLICY_DISABLED)).toThrowError(
      /js\.boolean\.box is unavailable under boolean-boundary policy box=unsupported/,
    );
  });

  it("defaults an omitted policy closed and publishes the resolved decision", () => {
    const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    builder.requestFeature("math.sqrt");
    const frozen = builder.freeze();
    expect(frozen.policy.booleanBoundary).toEqual(BOOLEAN_BOUNDARY_POLICY_DISABLED);
    // The two boundaries are independent policies, not one widened field.
    expect(frozen.policy.numberBoundary).toEqual(NUMBER_BOUNDARY_POLICY_DISABLED);
  });

  it("resolves the boolean arm independently of the number arms", () => {
    const prepared = prepareIrRuntimeManifest({
      functions: [booleanFunction("independent")],
      sourceFile: "/repo/boolean-boundary.ts",
      policy: {
        target: "host",
        backend: "wasmgc",
        // Numbers OFF, booleans ON: the boolean arm must still resolve.
        numberBoundary: NUMBER_BOUNDARY_POLICY_DISABLED,
        booleanBoundary: HOST_BOOLEAN,
      },
    });
    expect(prepared?.manifest.providers.map((provider) => provider.id)).toEqual(["host.js.boolean.box"]);
  });
});

describe("#3526 F1-S2 freeze discipline", () => {
  it("accepts an identical re-attachment and rejects every substitution or crosswire", () => {
    const canonical: IrInstrIntrinsic["provider"] = {
      kind: "callable",
      target: irImportFuncRef("env", "__box_boolean", "__box_boolean"),
    };
    expect(() => prepare(booleanFunction("preattached", canonical), HOST_BOOLEAN)).not.toThrow();

    const substitutions: readonly IrInstrIntrinsic["provider"][] = [
      // crosswired to the NUMBER family's physical import
      { kind: "callable", target: irImportFuncRef("env", "__box_number", "__box_number") },
      // host arm crosswired to a runtime target that does not exist
      { kind: "callable", target: irRuntimeFuncRef("__box_boolean", "__box_boolean") },
      // a plausible but wrong union member
      { kind: "callable", target: irImportFuncRef("env", "__unbox_boolean", "__unbox_boolean") },
      // a backend provider this intrinsic does not admit
      { kind: "backend-op", opcode: "f64.abs" },
    ];
    for (const substitution of substitutions) {
      expect(() => prepare(booleanFunction("crosswired", substitution), HOST_BOOLEAN)).toThrowError(
        /already carries a different prepared provider/,
      );
    }
  });

  it("rejects a post-freeze request and a non-canonical capability catalogue", () => {
    const builder = new RuntimeManifestBuilder(policy(HOST_BOOLEAN));
    builder.addIntrinsicUse(
      {
        id: "js.boolean.box",
        version: INTRINSIC_SIGNATURE_VERSION,
        argumentTypes: I32_TO_EXTERNREF_INTRINSIC_SIGNATURE.params,
        resultType: I32_TO_EXTERNREF_INTRINSIC_SIGNATURE.result,
        location: { file: "/repo/boolean-boundary.ts", line: 1, column: 0 },
      },
      intrinsicEffectEvidence({
        kind: "intrinsic",
        id: "js.boolean.box",
        version: INTRINSIC_SIGNATURE_VERSION,
        args: [asValueId(0)],
        result: asValueId(1),
        resultType: EXTERNREF,
      }),
    );
    builder.freeze();
    expect(() => builder.assertIntrinsicPlanned("js.boolean.box")).not.toThrow();
    expect(() => builder.assertHostCapabilityPlanned("boolean.box")).not.toThrow();
    expect(() => builder.assertHostCapabilityPlanned("number.box")).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "late-unplanned-host-capability" }),
    );
    expect(() => builder.requestFeature("js.boolean.box")).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "manifest-frozen" }),
    );

    const invalid = expect.objectContaining<RuntimeManifestInvariantError>({
      code: "invalid-host-capability-catalog",
    });
    const freezeWith = (records: readonly (typeof RUNTIME_HOST_CAPABILITY_RECORDS)[number][]) => {
      const scoped = new RuntimeManifestBuilder(policy(HOST_BOOLEAN), { hostCapabilityRecords: records });
      scoped.requestFeature("js.boolean.box");
      return () => scoped.freeze();
    };
    // A structurally equal but non-canonical clone of the boolean record.
    expect(
      freezeWith(
        RUNTIME_HOST_CAPABILITY_RECORDS.map((record) => (record.capability === "boolean.box" ? { ...record } : record)),
      ),
    ).toThrowError(invalid);
    // A wrong field on the boolean record.
    expect(
      freezeWith(
        RUNTIME_HOST_CAPABILITY_RECORDS.map((record) =>
          record.capability === "boolean.box" ? { ...record, field: "__box_bool" } : record,
        ),
      ),
    ).toThrowError(invalid);
    // Dropping the new row makes the catalogue incomplete.
    expect(
      freezeWith(RUNTIME_HOST_CAPABILITY_RECORDS.filter((record) => record.capability !== "boolean.box")),
    ).toThrowError(invalid);
  });

  it("keeps Math-only, async-only and number-only manifests free of the boolean record", () => {
    const mathOnly = new RuntimeManifestBuilder(policy(HOST_BOOLEAN));
    mathOnly.requestFeature("math.sqrt");
    expect(mathOnly.freeze().hostCapabilityRecords).toEqual([]);

    const asyncOnly = new RuntimeManifestBuilder(policy(HOST_BOOLEAN));
    for (const feature of ASYNC_RUNTIME_FEATURES) asyncOnly.requestFeature(feature);
    expect(asyncOnly.freeze().hostCapabilities).not.toContain("boolean.box");

    const numberOnly = new RuntimeManifestBuilder({
      target: "host",
      backend: "wasmgc",
      numberBoundary: { box: "host", unbox: "host" },
      booleanBoundary: HOST_BOOLEAN,
    });
    numberOnly.requestFeature("js.number.box");
    const frozen = numberOnly.freeze();
    expect(frozen.hostCapabilities).toEqual(["number.box"]);
    expect(frozen.hostCapabilityRecords.map((record) => record.field)).not.toContain("__box_boolean");
  });
});

describe("#3526 F1-S2 front-end migration", () => {
  it("lowers the branded carrier to the provider-free intrinsic, with no direct call", () => {
    const fn = lowerFill(true);
    // The intrinsic-emission assertion. Reverting the from-ast arm to its
    // direct `emitCall(env.__box_boolean)` form fails HERE.
    expect(intrinsicsOf(fn).map((instr) => instr.id)).toEqual(["js.boolean.box"]);
    expect(intrinsicsOf(fn)[0]!.provider).toBeUndefined();
    expect(callTargetNames(fn)).not.toContain("__box_boolean");
  });

  it("reads no lane fact: the same IR under either answer to the deleted predicate", () => {
    // Obligation 6. The predicate never gated which shapes REACH the arm, only
    // demote-vs-box, so the emitted population is a pure TYPE fact. Passing
    // `hasHostBooleanBox` is now inert — a resolver property nothing reads.
    const withBox = lowerFill(true);
    const withoutBox = lowerFill(false);
    const shape = (fn: IrFunction) =>
      JSON.stringify({ intrinsics: intrinsicsOf(fn).map((i) => i.id), calls: callTargetNames(fn) });
    expect(shape(withoutBox)).toBe(shape(withBox));
    expect(intrinsicsOf(withoutBox).map((instr) => instr.id)).toEqual(["js.boolean.box"]);
  });

  it("keeps the BRAND gate: an unbranded i32 in an externref position still demotes", async () => {
    // A native-annotated integer shares the i32 carrier with a JS boolean and
    // must NOT take the boolean boxer — its boxing semantics differ. The arm
    // must never widen to bare i32 now that the lane read is gone.
    const result = await compile(
      `type i32 = number;
function fill(a: any[], n: i32): void { a[0] = n; }
export function probe(n: number): number { const a: any[] = [0]; fill(a, n | 0); return a[0] === 3 ? 1 : 0; }`,
      { fileName: "t.ts", trackIrOutcomes: true },
    );
    const demoted = outcome(result, "fill");
    expect(demoted.kind).toBe("unsupported");
    if (demoted.kind === "emitted") throw new Error("an unbranded i32 unexpectedly took the boolean boxer");
  });
});

describe("#3526 F1-S2 host-lane parity", () => {
  it("keeps the exact env import set and order and the same answers on the host lane", async () => {
    const result = await compile(RUNNABLE, { fileName: "t.ts", trackIrOutcomes: true });

    expect(outcome(result, "fill").kind).toBe("emitted");
    // Import membership AND order are part of the ABI. `addUnionImports` is
    // still the whole-family materializer, reached through the attached
    // provider target rather than a direct call — and this exact order is what
    // the preregistration recognizer's `js.boolean.box` arm preserves.
    expect(result.imports.map((entry) => entry.name)).toEqual([
      "__typeof_boolean",
      "__unbox_number",
      "__box_number",
      "__box_boolean",
      "__get_undefined",
    ]);
    expect(result.wat).toContain("__box_boolean");

    const exports = await instantiate(result);
    // `typeof a[0] === "boolean"` is the load-bearing part: a number boxer
    // would store 1 and return -1 here.
    expect(exports.probe!(5)).toBe(1);
    expect(exports.probe!(0)).toBe(0);
  });
});

describe("#3526 F1-S2 owner-local demote parity", () => {
  it("demotes only the requesting owner when the lane cannot provide the arm", async () => {
    // `nativeStrings` resolves the box arm unsupported (it was gated on
    // `!nativeStrings`), so `fill` demotes while the unrelated `pure` owner in
    // the same module must not.
    const result = await compile(`${RUNNABLE}\nexport function pure(x: number): number { return Math.sqrt(x); }\n`, {
      fileName: "t.ts",
      trackIrOutcomes: true,
      nativeStrings: true,
    });

    const demoted = outcome(result, "fill");
    expect(demoted.kind).toBe("unsupported");
    if (demoted.kind === "emitted") throw new Error("fill unexpectedly stayed on the IR path");
    // The outcome-code SHIFT (obligation 4): this used to be
    // `operand-coercion-unsupported` / `build`. Reverting the from-ast arm
    // fails HERE.
    expect(demoted.code).toBe("late-preparation-unsupported");
    expect(demoted.stage).toBe("resolve");
    expect(demoted.detail).toMatch(/js\.boolean\.box has no provider under boolean-boundary policy box=unsupported/);

    // The clean owner survives, exactly once, in the same transaction.
    expect(outcome(result, "pure").kind).toBe("emitted");
  });

  it("demotes the same way on the standalone and WASI lanes", async () => {
    for (const target of ["standalone", "wasi"] as const) {
      const result = await compile(BOOL_STORE_SOURCE.replace("function fill", "export function fill"), {
        fileName: "t.ts",
        trackIrOutcomes: true,
        target,
      });
      const demoted = outcome(result, "fill");
      expect(demoted.kind).toBe("unsupported");
      if (demoted.kind === "emitted") throw new Error(`fill unexpectedly stayed on the IR path for ${target}`);
      expect(demoted.code).toBe("late-preparation-unsupported");
      expect(demoted.stage).toBe("resolve");
      // Host-freedom is preserved: no `env` import may appear on these lanes.
      expect(result.imports).toEqual([]);
    }
  });

  it("reports the same accounting when the owners are declared in the other order", async () => {
    const pure = `export function pure(x: number): number { return Math.sqrt(x); }`;
    const accounting = (result: CompileResult) =>
      (result.irOutcomes ?? [])
        .map((entry) => `${entry.displayName}:${entry.kind}:${entry.kind === "emitted" ? "" : entry.code}`)
        .sort()
        .join("|");
    const forward = await compile(`${RUNNABLE}\n${pure}\n`, {
      fileName: "t.ts",
      trackIrOutcomes: true,
      nativeStrings: true,
    });
    const reverse = await compile(`${pure}\n${RUNNABLE}`, {
      fileName: "t.ts",
      trackIrOutcomes: true,
      nativeStrings: true,
    });
    expect(accounting(reverse)).toBe(accounting(forward));
  });
});
