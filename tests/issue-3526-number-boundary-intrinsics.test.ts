// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3526 F1-S1 — the synchronous number boundary as semantic intrinsics.
//
// What these tests protect (the six behaviour-neutrality obligations of the
// 2026-08-29 plan, as amended by the 2026-08-30 Sol correction):
//
//  1. **Host-lane parity.** The migrated arms must keep the exact physical
//     `env.__box_number` / `env.__unbox_number` targets, the same import set
//     AND order, and the same runtime answers. The union import is shared with
//     raw consumers, so a capability-only identity would be an ABI change.
//  2. **Native-first unbox parity.** The host-free `Map.get` shape still calls
//     the union-native `__unbox_number` and stays host-import-free.
//  3. **Standalone/native-strings box demote parity.** A lane whose policy
//     cannot provide an arm still demotes — now as a typed, OWNER-LOCAL
//     preparation outcome instead of a live front-end mode read.
//  4. **Freeze discipline.** Provider substitution, crosswiring, a wrong
//     capability/symbol, a duplicate attachment, a post-freeze request, and a
//     non-canonical capability record all reject before materialization.
//  5. **Canonicalization.** Reversed traversal publishes byte-equivalent
//     projections, and Math-only / async-only manifests never acquire number
//     records.
//  6. **Non-vacuity.** The fixtures below ride the INTRINSIC path: reverting
//     only the two from-ast arms (keeping the schema) fails these tests,
//     because they assert the absence of the old direct call as well as the
//     presence of the intrinsic.
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { prepareSingleAwaitIrFunction } from "../src/ir/async-prepare.js";
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
  EXTERNREF_TO_F64_INTRINSIC_SIGNATURE,
  F64_TO_EXTERNREF_INTRINSIC_SIGNATURE,
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
  type IrFunction,
  type IrInstr,
  type IrInstrIntrinsic,
} from "../src/ir/nodes.js";
import {
  NUMBER_BOUNDARY_POLICY_DISABLED,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  type NumberBoundaryPolicy,
  type RuntimeManifestPolicy,
} from "../src/ir/runtime-manifest.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityRecord,
} from "../src/ir/runtime-host-capabilities.js";
import { ts } from "../src/ts-api.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-number-boundary");
const F64 = irVal({ kind: "f64" });
const EXTERNREF = irVal({ kind: "externref" });

const HOST_BOUNDARY: NumberBoundaryPolicy = { box: "host", unbox: "host" };
const NATIVE_FIRST_BOUNDARY: NumberBoundaryPolicy = { box: "unsupported", unbox: "native" };

/**
 * The #4461 memo shape: `fibCache.set(n, v)` boxes two f64s into the host
 * `Map` ABI and `return hit;` unboxes the externref back to the declared
 * number return. One fixture, both arms.
 */
const MEMO = `
const fibCache = new Map<number, number>();
function fibMemo(n: number): number {
  if (n < 2) return n;
  const hit = fibCache.get(n);
  if (hit !== undefined) return hit;
  const v = fibMemo(n - 1) + fibMemo(n - 2);
  fibCache.set(n, v);
  return v;
}
export function test(): number {
  let acc = 0;
  for (let n = 0; n < 20; n++) acc = acc + fibMemo(n);
  acc = acc + fibMemo(19) + fibMemo(10);
  return acc;
}
`;

/** The same algorithm in JS — the oracle the compiled module must match. */
function memoOracle(): number {
  const cache = new Map<number, number>();
  const fib = (n: number): number => {
    if (n < 2) return n;
    const hit = cache.get(n);
    if (hit !== undefined) return hit;
    const v = fib(n - 1) + fib(n - 2);
    cache.set(n, v);
    return v;
  };
  let acc = 0;
  for (let n = 0; n < 20; n++) acc += fib(n);
  return acc + fib(19) + fib(10);
}

function intrinsicsOf(fn: IrFunction): IrInstrIntrinsic[] {
  const found: IrInstrIntrinsic[] = [];
  const scan = (buffer: readonly IrInstr[]): void => {
    for (const root of buffer) {
      forEachInstrDeep(root, (instr) => {
        if (instr.kind === "intrinsic") found.push(instr);
      });
    }
  };
  for (const block of fn.blocks) scan(block.instrs);
  for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  return found;
}

function callTargetNames(fn: IrFunction): string[] {
  const names: string[] = [];
  for (const block of fn.blocks) {
    for (const root of block.instrs) {
      forEachInstrDeep(root, (instr) => {
        if (instr.kind === "call") names.push(instr.target.name);
      });
    }
  }
  return names;
}

function lower(source: string, name: string): IrFunction {
  const analysis = analyzeSource(source);
  const declaration = analysis.sourceFile.statements
    .filter(ts.isFunctionDeclaration)
    .find((candidate) => candidate.name?.text === name);
  if (!declaration) throw new Error(`missing ${name} declaration`);
  return lowerFunctionAstToIr(declaration, { ownerUnitId: identities.next(name).unitId, exported: true }).main;
}

function policy(numberBoundary: NumberBoundaryPolicy): RuntimeManifestPolicy {
  return { target: "host", backend: "wasmgc", numberBoundary };
}

/** One hand-built owner carrying exactly the requested number-boundary arms. */
function boundaryFunction(name: string, arms: readonly ("box" | "unbox")[]): IrFunction {
  const instrs: IrInstr[] = [];
  let nextValue = 2;
  for (const arm of arms) {
    instrs.push(
      arm === "box"
        ? {
            kind: "intrinsic",
            id: "js.number.box",
            version: INTRINSIC_SIGNATURE_VERSION,
            args: [asValueId(0)],
            result: asValueId(nextValue++),
            resultType: EXTERNREF,
          }
        : {
            kind: "intrinsic",
            id: "js.number.unbox",
            version: INTRINSIC_SIGNATURE_VERSION,
            args: [asValueId(1)],
            result: asValueId(nextValue++),
            resultType: F64,
          },
    );
  }
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [
      { name: "n", type: F64, value: asValueId(0) },
      { name: "carrier", type: EXTERNREF, value: asValueId(1) },
    ],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [asValueId(0)] },
      },
    ],
    exported: false,
    valueCount: nextValue,
    funcKind: "regular",
  };
}

function prepare(fn: IrFunction, numberBoundary: NumberBoundaryPolicy) {
  const prepared = prepareIrRuntimeManifest({
    functions: [fn],
    sourceFile: "/repo/number-boundary.ts",
    policy: policy(numberBoundary),
  });
  if (!prepared) throw new Error("expected a non-empty runtime manifest");
  return prepared;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const found = result.irOutcomes?.filter((candidate) => candidate.displayName === name) ?? [];
  if (found.length !== 1) throw new Error(`expected exactly one IR outcome for ${name}, got ${found.length}`);
  return found[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, () => number>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, () => number>;
  (imports as { setExports?: (value: Record<string, () => number>) => void }).setExports?.(exports);
  return exports;
}

describe("#3526 F1-S1 number-boundary contract", () => {
  it("adds exactly two versioned IDs with 1:1 feature rows and the exact carrier ABI", () => {
    expect(NUMBER_BOUNDARY_INTRINSIC_IDS).toEqual(["js.number.box", "js.number.unbox"]);
    expect([...NUMBER_BOUNDARY_RUNTIME_FEATURES]).toEqual([...NUMBER_BOUNDARY_INTRINSIC_IDS]);
    for (const id of NUMBER_BOUNDARY_INTRINSIC_IDS) {
      expect(INTRINSIC_DEFINITIONS[id].feature).toBe(id);
      expect(INTRINSIC_DEFINITIONS[id].signature.version).toBe(INTRINSIC_SIGNATURE_VERSION);
    }
    expect(INTRINSIC_DEFINITIONS["js.number.box"].signature).toBe(F64_TO_EXTERNREF_INTRINSIC_SIGNATURE);
    expect(INTRINSIC_DEFINITIONS["js.number.unbox"].signature).toBe(EXTERNREF_TO_F64_INTRINSIC_SIGNATURE);
    expect(F64_TO_EXTERNREF_INTRINSIC_SIGNATURE.params).toEqual([F64]);
    expect(F64_TO_EXTERNREF_INTRINSIC_SIGNATURE.result).toEqual(EXTERNREF);
    expect(EXTERNREF_TO_F64_INTRINSIC_SIGNATURE.params).toEqual([EXTERNREF]);
    expect(EXTERNREF_TO_F64_INTRINSIC_SIGNATURE.result).toEqual(F64);
  });

  it("keeps ONE central capability catalogue whose async projection stays narrowed", () => {
    expect(resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "number.box")).toEqual({
      capability: "number.box",
      module: "env",
      field: "__box_number",
      kind: "func",
      params: ["f64"],
      results: ["externref"],
    });
    expect(resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "number.unbox")).toEqual({
      capability: "number.unbox",
      module: "env",
      field: "__unbox_number",
      kind: "func",
      params: ["externref"],
      results: ["f64"],
    });

    // The async projection is the SAME frozen objects, minus the number rows.
    expect(ASYNC_HOST_CAPABILITY_RECORDS.every((record) => RUNTIME_HOST_CAPABILITY_RECORDS.includes(record))).toBe(
      true,
    );
    expect(ASYNC_HOST_CAPABILITY_RECORDS.map((record) => record.capability)).not.toContain("number.box");
    expect(ASYNC_HOST_CAPABILITY_RECORDS.map((record) => record.capability)).not.toContain("number.unbox");
    // An f64 row can never be narrowed into the async adapter union: the async
    // materializer maps every non-i32 row to externref and would mislower it.
    for (const capability of ["number.box", "number.unbox"] as const) {
      expect(() =>
        asAsyncHostAdapter(resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, capability)),
      ).toThrowError(/is not an async capability/);
    }
  });
});

describe("#3526 F1-S1 provider policy", () => {
  it("selects the exact host arms and their capability records under host policy", () => {
    const prepared = prepare(boundaryFunction("hostBoth", ["box", "unbox"]), HOST_BOUNDARY);

    expect(prepared.manifest.policy.numberBoundary).toEqual(HOST_BOUNDARY);
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual([
      "host.js.number.box",
      "host.js.number.unbox",
    ]);
    expect(prepared.manifest.hostCapabilities).toEqual(["number.box", "number.unbox"]);
    expect(prepared.manifest.hostCapabilityRecords.map((record) => record.field)).toEqual([
      "__box_number",
      "__unbox_number",
    ]);
    // Canonical object identity, not a rebuilt lookalike.
    for (const record of prepared.manifest.hostCapabilityRecords) {
      expect(RUNTIME_HOST_CAPABILITY_RECORDS).toContain(record);
    }
    // The physical target is the existing union import, so raw consumers and
    // import order do not drift.
    const attached = intrinsicsOf(prepared.functions[0]!);
    expect(attached.map((instr) => instr.provider)).toEqual([
      { kind: "callable", target: irImportFuncRef("env", "__box_number", "__box_number") },
      { kind: "callable", target: irImportFuncRef("env", "__unbox_number", "__unbox_number") },
    ]);
  });

  it("selects the union-native unbox and NO host capability under native-first policy", () => {
    const prepared = prepare(boundaryFunction("nativeUnbox", ["unbox"]), NATIVE_FIRST_BOUNDARY);

    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["native.js.number.unbox"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    expect(prepared.manifest.hostCapabilityRecords).toEqual([]);
    expect(intrinsicsOf(prepared.functions[0]!)[0]!.provider).toEqual({
      kind: "callable",
      target: irRuntimeFuncRef("__unbox_number", "__unbox_number"),
    });
  });

  it("refuses every arm its caller resolved to unsupported, naming the intrinsic and the policy", () => {
    // Native `__box_number` presence must NOT widen the box policy: the arm is
    // host-only by policy in this slice, not by helper availability.
    for (const [arm, boundary] of [
      ["box", NATIVE_FIRST_BOUNDARY],
      ["box", NUMBER_BOUNDARY_POLICY_DISABLED],
      ["unbox", NUMBER_BOUNDARY_POLICY_DISABLED],
    ] as const) {
      expect(() => prepare(boundaryFunction(`refused-${arm}`, [arm]), boundary)).toThrowError(
        expect.objectContaining<RuntimeManifestInvariantError>({ code: "provider-target-unavailable" }),
      );
      expect(() => prepare(boundaryFunction(`refused2-${arm}`, [arm]), boundary)).toThrowError(
        new RegExp(`js\\.number\\.${arm} is unavailable under number-boundary policy box=${boundary.box}`),
      );
    }
  });

  it("defaults an omitted policy closed and publishes the resolved decision", () => {
    const builder = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" });
    builder.requestFeature("math.sqrt");
    expect(builder.freeze().policy.numberBoundary).toEqual(NUMBER_BOUNDARY_POLICY_DISABLED);
  });
});

describe("#3526 F1-S1 freeze discipline", () => {
  const attachedBox = (target: IrInstrIntrinsic["provider"]): IrFunction => {
    const fn = boundaryFunction("preattached", ["box"]);
    const block = fn.blocks[0]!;
    const instr = block.instrs[0] as IrInstrIntrinsic;
    return {
      ...fn,
      blocks: [{ ...block, instrs: [{ ...instr, provider: target } as IrInstr] }],
    };
  };

  it("accepts an identical re-attachment and rejects every substitution or crosswire", () => {
    // Idempotent: the same frozen choice may be re-attached.
    expect(() =>
      prepare(
        attachedBox({ kind: "callable", target: irImportFuncRef("env", "__box_number", "__box_number") }),
        HOST_BOUNDARY,
      ),
    ).not.toThrow();

    const substitutions: readonly IrInstrIntrinsic["provider"][] = [
      // crosswired to the OTHER arm's physical import
      { kind: "callable", target: irImportFuncRef("env", "__unbox_number", "__unbox_number") },
      // host arm crosswired to the native runtime target
      { kind: "callable", target: irRuntimeFuncRef("__box_number", "__box_number") },
      // wrong capability field entirely
      { kind: "callable", target: irImportFuncRef("env", "__box_boolean", "__box_boolean") },
      // a backend provider this intrinsic does not admit
      { kind: "backend-op", opcode: "f64.abs" },
      { kind: "backend-composite", operation: "to-uint32" },
    ];
    for (const substitution of substitutions) {
      expect(() => prepare(attachedBox(substitution), HOST_BOUNDARY)).toThrowError(
        /already carries a different prepared provider/,
      );
    }
  });

  it("rejects a post-freeze request for an intrinsic the frozen plan does not carry", () => {
    const builder = new RuntimeManifestBuilder(policy(HOST_BOUNDARY));
    builder.addIntrinsicUse(
      {
        id: "js.number.box",
        version: INTRINSIC_SIGNATURE_VERSION,
        argumentTypes: F64_TO_EXTERNREF_INTRINSIC_SIGNATURE.params,
        resultType: F64_TO_EXTERNREF_INTRINSIC_SIGNATURE.result,
        location: { file: "/repo/number-boundary.ts", line: 1, column: 0 },
      },
      intrinsicEffectEvidence({
        kind: "intrinsic",
        id: "js.number.box",
        version: INTRINSIC_SIGNATURE_VERSION,
        args: [asValueId(0)],
        result: asValueId(1),
        resultType: EXTERNREF,
      }),
    );
    builder.freeze();

    // Planned before freeze: lookup-only afterwards, never a new request.
    expect(() => builder.assertIntrinsicPlanned("js.number.box")).not.toThrow();
    expect(() => builder.assertHostCapabilityPlanned("number.box")).not.toThrow();
    expect(() => builder.assertIntrinsicPlanned("js.number.unbox")).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "late-unplanned-intrinsic" }),
    );
    expect(() => builder.assertHostCapabilityPlanned("number.unbox")).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "late-unplanned-host-capability" }),
    );
    expect(() => builder.requestFeature("js.number.unbox")).toThrowError(
      expect.objectContaining<RuntimeManifestInvariantError>({ code: "manifest-frozen" }),
    );
  });

  it("rejects a non-canonical or incomplete capability catalogue before materialization", () => {
    const invalid = expect.objectContaining<RuntimeManifestInvariantError>({
      code: "invalid-host-capability-catalog",
    });
    const freezeWith = (records: readonly (typeof RUNTIME_HOST_CAPABILITY_RECORDS)[number][]) => {
      const builder = new RuntimeManifestBuilder(policy(HOST_BOUNDARY), { hostCapabilityRecords: records });
      builder.requestFeature("js.number.box");
      return () => builder.freeze();
    };
    // A structurally equal but non-canonical clone of the number record.
    const cloned = RUNTIME_HOST_CAPABILITY_RECORDS.map((record) =>
      record.capability === "number.box" ? { ...record } : record,
    );
    expect(freezeWith(cloned)).toThrowError(invalid);
    // A wrong field on the number record.
    const wrongField = RUNTIME_HOST_CAPABILITY_RECORDS.map((record) =>
      record.capability === "number.box" ? { ...record, field: "__box_number_other" } : record,
    );
    expect(freezeWith(wrongField)).toThrowError(invalid);
    // The async-only projection is no longer a complete catalogue.
    expect(freezeWith([...ASYNC_HOST_CAPABILITY_RECORDS])).toThrowError(invalid);
  });
});

describe("#3526 F1-S1 canonicalization", () => {
  it("publishes byte-equivalent projections under reversed traversal", () => {
    const forward = prepare(boundaryFunction("fwd", ["box", "unbox"]), HOST_BOUNDARY);
    const reverse = prepare(boundaryFunction("rev", ["unbox", "box"]), HOST_BOUNDARY);
    const view = (manifest: (typeof forward)["manifest"]) => ({
      features: manifest.features,
      providers: manifest.providers,
      providerComponents: manifest.providerComponents,
      hostCapabilities: manifest.hostCapabilities,
      hostCapabilityRecords: manifest.hostCapabilityRecords,
      backendRequirements: manifest.backendRequirements,
    });
    expect(JSON.stringify(view(reverse.manifest))).toBe(JSON.stringify(view(forward.manifest)));
  });

  it("keeps Math-only and async-only manifests free of number records", () => {
    const mathOnly = new RuntimeManifestBuilder(policy(HOST_BOUNDARY));
    mathOnly.requestFeature("math.sqrt");
    expect(mathOnly.freeze().hostCapabilityRecords).toEqual([]);

    const asyncOnly = new RuntimeManifestBuilder(policy(HOST_BOUNDARY));
    for (const feature of ASYNC_RUNTIME_FEATURES) asyncOnly.requestFeature(feature);
    const manifest = asyncOnly.freeze();
    expect(manifest.hostCapabilities).not.toContain("number.box");
    expect(manifest.hostCapabilities).not.toContain("number.unbox");
    expect(manifest.hostCapabilityRecords.map((record) => record.field)).not.toContain("__box_number");
  });
});

describe("#3526 F1-S1 host-lane parity", () => {
  it("keeps the exact env import set and order and the same answers on the host lane", async () => {
    const result = await compile(MEMO, { fileName: "t.ts", trackIrOutcomes: true });

    expect(outcome(result, "fibMemo").kind).toBe("emitted");
    // Import membership AND order are part of the ABI: `addUnionImports` is
    // still the whole-family materializer, reached through the attached
    // provider target rather than a direct call.
    expect(result.imports.map((entry) => entry.name)).toEqual([
      "Map_new",
      "Map_get",
      "Map_set",
      "__unbox_number",
      "__box_number",
      "__extern_is_undefined",
    ]);
    expect(await (await instantiate(result)).test!()).toBe(memoOracle());
  });

  it("materializes the union family from an isolated attached box provider alone", async () => {
    // The only union-family trigger in this module is the attached
    // `js.number.box` provider — no `dyn.*` op, no `Map.get`, no raw call.
    const result = await compile(
      `
      const c = new Map<number, number>();
      export function put(n: number): number { c.set(n, n * 2); return n; }
      `,
      { fileName: "t.ts", trackIrOutcomes: true },
    );
    expect(outcome(result, "put").kind).toBe("emitted");
    expect(result.imports.map((entry) => entry.name)).toEqual(["Map_new", "Map_set", "__box_number"]);
    expect(result.wat).toContain("__box_number");
    // Non-vacuity, and the one MEASURED emission difference this slice makes:
    // a semantic intrinsic is pure under the existing `effectsOf` authority, so
    // the boxed carrier is emitted at its consumer instead of being anchored
    // into an externref spill local. Restoring the old direct-call arms brings
    // those `(local $$irN externref)` declarations back and fails here.
    expect(result.wat).not.toMatch(/\(local \$\$ir\d+ externref\)/);
    expect(await (await instantiate(result)).put!()).toBeTypeOf("number");
  });
});

describe("#3526 F1-S1 native-first and demote parity", () => {
  it("keeps the standalone Map.get shape host-free and correct", async () => {
    const result = await compile(MEMO, { fileName: "t.ts", trackIrOutcomes: true, target: "standalone" });

    expect(outcome(result, "fibMemo").kind).toBe("emitted");
    // Host-freedom: a standalone module must import nothing from `env`.
    expect(result.imports).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: new Proxy(
        {},
        {
          get(_target, name) {
            throw new Error(`standalone module requested host import env.${String(name)}`);
          },
        },
      ),
    } as never);
    expect((instance.exports as Record<string, () => number>).test!()).toBe(memoOracle());
  });

  it("demotes only the requesting owner when the lane cannot provide an arm", async () => {
    // `nativeStrings` resolves BOTH arms unsupported (host box/unbox is gated
    // on `!nativeStrings`, native unbox on `semanticProviders`), so `fibMemo`
    // demotes while the unrelated `pure` owner in the same module must not.
    const source = `${MEMO}
export function pure(x: number): number { return Math.sqrt(x) + Math.floor(x); }
`;
    const result = await compile(source, { fileName: "t.ts", trackIrOutcomes: true, nativeStrings: true });

    const demoted = outcome(result, "fibMemo");
    expect(demoted.kind).toBe("unsupported");
    if (demoted.kind === "emitted") throw new Error("fibMemo unexpectedly stayed on the IR path");
    expect(demoted.code).toBe("late-preparation-unsupported");
    expect(demoted.stage).toBe("resolve");
    expect(demoted.detail).toMatch(/js\.number\.(box|unbox) has no provider under number-boundary policy/);

    // The clean owner survives, exactly once, in the same transaction.
    expect(outcome(result, "pure").kind).toBe("emitted");
    expect(await (await instantiate(result)).pure!()).toBeTypeOf("number");
  });

  it("reports the same accounting when the owners are declared in the other order", async () => {
    const forward = await compile(`${MEMO}\nexport function pure(x: number): number { return Math.sqrt(x); }\n`, {
      fileName: "t.ts",
      trackIrOutcomes: true,
      nativeStrings: true,
    });
    const reverse = await compile(`export function pure(x: number): number { return Math.sqrt(x); }\n${MEMO}`, {
      fileName: "t.ts",
      trackIrOutcomes: true,
      nativeStrings: true,
    });
    const accounting = (result: CompileResult) =>
      (result.irOutcomes ?? [])
        .map((entry) => `${entry.displayName}:${entry.kind}:${entry.kind === "emitted" ? "" : entry.code}`)
        .sort()
        .join("|");
    expect(accounting(reverse)).toBe(accounting(forward));
  });
});

describe("#3526 F1-S1 async-prepare join", () => {
  const asyncOwner = (tail: IrInstr | null): IrFunction => ({
    unitId: identities.next("asyncTail").unitId,
    name: "asyncTail",
    params: [{ name: "p", type: EXTERNREF, value: asValueId(0) }],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          { kind: "await", operand: asValueId(0), result: asValueId(1), resultType: EXTERNREF },
          ...(tail ? [tail] : []),
        ],
        terminator: { kind: "return", values: [tail ? asValueId(2) : asValueId(1)] },
      },
    ],
    exported: false,
    valueCount: 3,
    funcKind: "async",
  });

  const UNBOX_INTRINSIC: IrInstr = {
    kind: "intrinsic",
    id: "js.number.unbox",
    version: INTRINSIC_SIGNATURE_VERSION,
    args: [asValueId(1)],
    result: asValueId(2),
    resultType: F64,
  };

  const UNBOX_IMPORT: IrInstr = {
    kind: "call",
    target: irImportFuncRef("env", "__unbox_number", "__unbox_number"),
    args: [asValueId(1)],
    result: asValueId(2),
    resultType: F64,
  };

  it("elides the round trip for the intrinsic form exactly where the raw-import form applied", () => {
    // A one-instruction externref→f64 tail is an identity continuation, so the
    // prepared plan needs exactly one state function instead of two.
    //
    // The raw-import form is retained unconditionally for legacy owners. The
    // intrinsic form is admitted ONLY under a host unbox policy — because the
    // import form it replaces was itself only ever emitted on the host lane,
    // and the elision is validated against the host Promise ABI. Admitting it
    // unconditionally would fire the elision on standalone owners for the
    // first time and drop a derived unit from the standalone cutover corpus.
    expect(prepareSingleAwaitIrFunction(asyncOwner(UNBOX_IMPORT))?.stateFunctions).toHaveLength(1);
    expect(prepareSingleAwaitIrFunction(asyncOwner(UNBOX_INTRINSIC), HOST_BOUNDARY)?.stateFunctions).toHaveLength(1);

    // Native-first and disabled policies keep their continuation, exactly as
    // the runtime-target form did before this slice.
    for (const boundary of [NATIVE_FIRST_BOUNDARY, NUMBER_BOUNDARY_POLICY_DISABLED, undefined]) {
      expect(prepareSingleAwaitIrFunction(asyncOwner(UNBOX_INTRINSIC), boundary)?.stateFunctions).toHaveLength(2);
    }

    // A tail that is NOT the exact roundtrip still needs its continuation.
    const other: IrInstr = {
      kind: "unary",
      op: "f64.neg",
      rand: asValueId(1),
      result: asValueId(2),
      resultType: F64,
    };
    expect(prepareSingleAwaitIrFunction(asyncOwner(other), HOST_BOUNDARY)?.stateFunctions).toHaveLength(2);
  });
});
