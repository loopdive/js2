// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as oldBindings from "../src/ir/callable-bindings.js";
import * as bindings from "../src/ir/core/callable-bindings.js";
import * as oldEffects from "../src/ir/effects.js";
import * as effects from "../src/ir/analysis/effects.js";
import * as oldIntrinsics from "../src/ir/intrinsics.js";
import * as catalog from "../src/ir/core/intrinsics.js";
import * as intrinsic from "../src/ir/analysis/intrinsics.js";
import * as oldAsync from "../src/ir/async-plan.js";
import * as asyncPlan from "../src/ir/analysis/async-plan.js";
import * as oldAsyncProviders from "../src/ir/async-runtime-providers.js";
import * as intents from "../src/ir/core/async-intents.js";
import { INTRINSIC_RUNTIME_FEATURES } from "../src/ir/runtime/contracts/intrinsics.js";
import { verifyIrIntrinsicInstruction } from "../src/ir/intrinsic-support.js";
import { asValueId, type IrInstr, type IrInstrIntrinsic } from "../src/ir/core/nodes.js";
import { irVal, type IrType } from "../src/ir/core/types.js";
import type { IntrinsicUse } from "../src/ir/core/intrinsic-contracts.js";
import type { IrAsyncPlan } from "../src/ir/core/async-plan.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const root = resolve(import.meta.dirname, "..");

const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const EXTERN: IrType = irVal({ kind: "externref" });
const identity = createTestIrFunctionIdentityFactory("semantic-verification-ownership");
const owner = identity.unit(0);
const v = asValueId;
const s = asyncPlan.asAsyncStateId;
const h = asyncPlan.asAsyncHandlerId;

/** Nonempty semantic fixture: one suspension, a live spill and a catch edge.
 * It is not a source-produced compiler-execution witness. */
function plan(): IrAsyncPlan {
  return {
    schemaVersion: 1,
    ownerUnitId: owner,
    kind: "async-function",
    abi: asyncPlan.canonicalPromiseAbi(F64),
    entry: s(0),
    params: [
      { value: v(0), type: EXTERN },
      { value: v(1), type: F64 },
    ],
    values: [
      { value: v(0), type: EXTERN },
      { value: v(1), type: F64 },
      { value: v(2), type: F64 },
      { value: v(3), type: F64 },
      { value: v(4), type: EXTERN },
    ],
    spills: [{ value: v(1), type: F64, storage: "slot" }],
    states: [
      {
        id: s(0),
        body: [],
        terminator: {
          kind: "suspend",
          awaited: v(0),
          resume: { state: s(1), value: v(2) },
          rejected: { kind: "handler", handler: h(0) },
          live: [v(1)],
        },
      },
      {
        id: s(1),
        resume: { value: v(2), type: F64, source: "fulfilled" },
        body: [{ kind: "binary", op: "f64.add", lhs: v(1), rhs: v(2), result: v(3), resultType: F64 }],
        terminator: { kind: "resolve", value: v(3) },
      },
      {
        id: s(2),
        resume: { value: v(4), type: EXTERN, source: "rejected" },
        body: [],
        terminator: { kind: "reject", reason: v(4) },
      },
    ],
    handlers: [{ id: h(0), kind: "catch", entry: s(2), parent: null }],
    runtimeIntents: [...intents.ASYNC_RUNTIME_FEATURES, "promise.number.bridge"],
  };
}

function instruction(): IrInstrIntrinsic {
  return { kind: "intrinsic", id: "math.pow", version: 1, args: [v(0), v(1)], result: v(2), resultType: F64 };
}

function use(): IntrinsicUse {
  return {
    id: "math.pow",
    version: 1,
    argumentTypes: [F64, F64],
    resultType: F64,
    location: { file: "semantic-fixture.js", line: 2, column: 3 },
  };
}

describe("canonical export identities and complete catalogs", () => {
  it.each(Object.keys(bindings) as (keyof typeof bindings)[])("forwards callable %s without a wrapper", (name) => {
    expect(oldBindings[name]).toBe(bindings[name]);
  });
  it("keeps the callable export denominator, provenance and compatibility names", () => {
    expect(Object.keys(bindings)).toHaveLength(12);
    expect(Object.keys(oldBindings).sort()).toEqual(Object.keys(bindings).sort());
    const left = bindings.irUnitFuncRef({ unitId: owner, name: "left" });
    const right = bindings.irUnitFuncRef({ unitId: owner, name: "right" });
    expect(bindings.sameIrCallableBinding(left.binding, right.binding)).toBe(true);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.binding)).toBe(true);
    const plain = bindings.irImportFuncRef("env", "f");
    const capability = bindings.irCapabilityImportFuncRef("env", "f", "cap", "provider");
    expect(bindings.sameIrCallableBinding(plain.binding, capability.binding)).toBe(false);
    expect(() => bindings.irImportFuncRef("", "f")).toThrow("import module must be a non-empty string");
    expect(() =>
      Reflect.apply(bindings.irCallableBindingKey, undefined, [
        { kind: "import", module: "env", field: "f", capabilityId: "cap" },
      ]),
    ).toThrow("callable import capability and provider provenance must be paired");
  });
  it("forwards all five effect functions and every intrinsic signature/catalog object", () => {
    expect(Object.keys(effects)).toHaveLength(5);
    for (const name of Object.keys(effects) as (keyof typeof effects)[]) expect(oldEffects[name]).toBe(effects[name]);
    for (const name of Object.keys(catalog) as (keyof typeof catalog)[])
      expect(oldIntrinsics[name]).toBe(catalog[name]);
    expect(oldIntrinsics.IntrinsicEffectEvidence).toBe(intrinsic.IntrinsicEffectEvidence);
    expect(oldIntrinsics.intrinsicEffectEvidence).toBe(intrinsic.intrinsicEffectEvidence);
    expect(oldIntrinsics.verifyIntrinsicUse).toBe(intrinsic.verifyIntrinsicUse);
    expect(Object.keys(catalog.INTRINSIC_DEFINITIONS)).toEqual(catalog.INTRINSIC_IDS);
    expect(Object.isFrozen(catalog.INTRINSIC_DEFINITIONS)).toBe(true);
    for (const [id, row] of Object.entries(catalog.INTRINSIC_DEFINITIONS)) {
      expect(row.feature).toBe(id);
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.signature)).toBe(true);
      expect(Object.isFrozen(row.signature.params)).toBe(true);
      expect(oldIntrinsics.INTRINSIC_DEFINITIONS[row.id]).toBe(row);
    }
    expect(INTRINSIC_RUNTIME_FEATURES).toContain("math.reduce-trig");
    expect(catalog.isIntrinsicId("math.reduce-trig")).toBe(false);
  });
  it("forwards semantic async exports through B's composed historical facade", () => {
    const names = [
      "asAsyncStateId",
      "asAsyncHandlerId",
      "canonicalPromiseAbi",
      "IrAsyncPlanInvariantError",
      "irAsyncPlanNeedsNumberBridge",
      "verifyIrAsyncPlan",
      "assertIrAsyncPlan",
      "createIrAsyncPlan",
      "serializeIrAsyncPlan",
      "hashIrAsyncPlan",
    ] as const;
    expect(Object.keys(asyncPlan).sort()).toEqual([...names].sort());
    for (const name of names) expect(oldAsync[name], name).toBe(asyncPlan[name]);
    expect(oldAsyncProviders.isAsyncRuntimeFeature).toBe(intents.isAsyncRuntimeFeature);
    expect(oldAsyncProviders.ASYNC_RUNTIME_FEATURES).toBe(intents.ASYNC_RUNTIME_FEATURES);
    expect(oldAsyncProviders.ASYNC_OPTIONAL_RUNTIME_FEATURES).toBe(intents.ASYNC_OPTIONAL_RUNTIME_FEATURES);
    for (const feature of [...intents.ASYNC_RUNTIME_FEATURES, ...intents.ASYNC_OPTIONAL_RUNTIME_FEATURES])
      expect(intents.isAsyncRuntimeFeature(feature)).toBe(true);
    expect(intents.isAsyncRuntimeFeature("Promise_resolve")).toBe(false);
  });
});

describe("semantic diagnostics and shared effect authority", () => {
  it("preserves cache identity, conflict ordering and schedule violations", () => {
    const readSlot: IrInstr = { kind: "slot.read", slotIndex: 4, result: v(0), resultType: F64 };
    const writeSlot: IrInstr = { kind: "slot.write", slotIndex: 4, value: v(0), result: null, resultType: null };
    const cache = new Map();
    const readEffect = effects.effectsOf(readSlot, cache);
    expect(effects.effectsOf(readSlot, cache)).toBe(readEffect);
    expect(effects.effectsArePure(readEffect)).toBe(false);
    expect(effects.effectsConflict(readEffect, effects.effectsOf(writeSlot))).toBe(true);
    expect(effects.verifyEmissionSchedule([readSlot, writeSlot], [0, 1], [false, false], () => [])).toEqual([]);
    expect(effects.verifyEmissionSchedule([readSlot, writeSlot], [1, 0], [true, false], () => [])).toEqual([
      {
        defIndex: 0,
        pastIndex: 1,
        reason: "deferred slot.read@0 (emits at 1) crosses conflicting slot.write@1 (emits at 0)",
      },
    ]);
    expect(effects.isSideEffecting(writeSlot)).toBe(true);
  });
  it("accepts only pure evidence from the one private-field class", () => {
    const proof = intrinsic.intrinsicEffectEvidence(instruction());
    expect(proof).toBeInstanceOf(oldIntrinsics.IntrinsicEffectEvidence);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(proof.isPure()).toBe(true);
    expect(intrinsic.verifyIntrinsicUse(use(), proof)).toBeUndefined();
    const impure = intrinsic.IntrinsicEffectEvidence.fromInstruction({
      kind: "slot.write",
      slotIndex: 0,
      value: v(0),
      result: null,
      resultType: null,
    });
    expect(impure.isPure()).toBe(false);
    const refusal = {
      code: "intrinsic-effect-mismatch",
      detail: "math.pow is certified pure but its IR effect authority reports observable effects",
    };
    expect(intrinsic.verifyIntrinsicUse(use(), impure)).toEqual(refusal);
    expect(Reflect.apply(intrinsic.verifyIntrinsicUse, undefined, [use(), { isPure: () => true }])).toEqual(refusal);
    expect(() => Reflect.apply(intrinsic.IntrinsicEffectEvidence.prototype.isPure, {}, [])).toThrow(TypeError);
  });
  it("keeps first-failure ordering for use identity, location, version, signature and effects", () => {
    const proof = intrinsic.intrinsicEffectEvidence(instruction());
    expect(intrinsic.verifyIntrinsicUse(Object.assign(use(), { id: "unknown" }), proof)).toEqual({
      code: "unknown-intrinsic",
      detail: "unknown intrinsic unknown",
    });
    expect(
      intrinsic.verifyIntrinsicUse(
        Object.assign(use(), { location: { file: "", line: 0, column: -1 }, version: 2 }),
        proof,
      ),
    ).toEqual({ code: "invalid-intrinsic-location", detail: "math.pow has an invalid source location" });
    expect(intrinsic.verifyIntrinsicUse(Object.assign(use(), { version: 2, argumentTypes: [] }), proof)).toEqual({
      code: "intrinsic-version-mismatch",
      detail: "math.pow uses signature v2; expected v1",
    });
    expect(intrinsic.verifyIntrinsicUse({ ...use(), argumentTypes: [] }, proof)).toEqual({
      code: "intrinsic-signature-mismatch",
      detail: "math.pow expects 2 argument(s), received 0",
    });
  });
  it("preserves signature diagnostic order and appends provider diagnostics afterward", () => {
    const bad = Object.assign(instruction(), {
      version: 2,
      args: [v(0), v(1), v(3)],
      resultType: I32,
      provider: { kind: "callable" as const, target: bindings.irRuntimeFuncRef("foreign") },
    });
    const types = new Map([
      [v(0), I32],
      [v(1), F64],
    ]);
    const semantic = [
      "math.pow uses signature v2; expected v1",
      "math.pow expects 2 argument(s), got 3",
      "math.pow argument 0 does not match its v2 signature",
      "math.pow result does not match its v2 signature",
    ];
    expect(intrinsic.verifyIrIntrinsicSignature(bad, types)).toEqual(semantic);
    expect(verifyIrIntrinsicInstruction(bad, types)).toEqual([
      ...semantic,
      "math.pow callable provider target runtime:foreign is not an admitted physical provider",
    ]);
    expect(intrinsic.verifyIrIntrinsicSignature(instruction(), new Map())).toEqual([]); // Existing absent-type handling.
    expect(() => intrinsic.verifyIrIntrinsicSignature(Object.assign(instruction(), { id: "unknown" }), types)).toThrow(
      TypeError,
    ); // Preserve malformed-ID failure rather than inventing a diagnostic.
  });
});

describe("nonempty async plan preservation", () => {
  it("preserves suspension/spill/handler data, canonical ordering, deep freeze and exact old serialization/hash", () => {
    const input = plan();
    expect(input.states).toHaveLength(3);
    expect(input.spills).toHaveLength(1);
    expect(input.handlers).toHaveLength(1);
    expect(input.states.flatMap((state) => state.body)).toHaveLength(1);
    expect(asyncPlan.verifyIrAsyncPlan(input)).toEqual([]);
    expect(asyncPlan.irAsyncPlanNeedsNumberBridge(input)).toBe(true);
    const reversed = {
      ...input,
      values: [...input.values].reverse(),
      states: [...input.states].reverse(),
      runtimeIntents: [...input.runtimeIntents].reverse(),
    };
    const canonical = asyncPlan.createIrAsyncPlan(reversed);
    expect(canonical).not.toBe(input);
    expect(Object.getPrototypeOf(canonical)).toBeNull();
    expect(Object.isFrozen(canonical.states[1]!.body[0])).toBe(true);
    expect(canonical.states.map((state) => state.id)).toEqual([0, 1, 2]);
    expect(asyncPlan.serializeIrAsyncPlan(reversed)).toBe(oldAsync.serializeIrAsyncPlan(input));
    expect(asyncPlan.hashIrAsyncPlan(reversed)).toBe(oldAsync.hashIrAsyncPlan(input));
    expect(asyncPlan.hashIrAsyncPlan(reversed)).toMatch(/^ir-async-plan:v1:[0-9a-f]{16}$/);
    expect(asyncPlan.serializeIrAsyncPlan(canonical)).toBe(asyncPlan.serializeIrAsyncPlan(input));
    expect(asyncPlan.hashIrAsyncPlan({ ...input, ownerUnitId: identity.unit(1) })).not.toBe(
      asyncPlan.hashIrAsyncPlan(input),
    );
  });
  it("retains exact missing-spill and liveness diagnostics", () => {
    const missing = { ...plan(), spills: [] };
    expect(asyncPlan.verifyIrAsyncPlan(missing)).toEqual([
      { code: "missing-spill", message: "live value 1 has no frame spill" },
    ]);
    expect(asyncPlan.verifyIrAsyncPlan(missing)).toEqual(oldAsync.verifyIrAsyncPlan(missing));
    const input = plan();
    const first = input.states[0]!;
    if (first.terminator.kind !== "suspend") throw new Error("fixture lost suspension");
    const wrong = {
      ...input,
      states: [{ ...first, terminator: { ...first.terminator, live: [] } }, ...input.states.slice(1)],
    };
    expect(asyncPlan.verifyIrAsyncPlan(wrong)).toEqual([
      { code: "liveness-mismatch", message: "state 0 live set [] must equal [1]", state: s(0) },
    ]);
    expect(asyncPlan.verifyIrAsyncPlan(wrong)).toEqual(oldAsync.verifyIrAsyncPlan(wrong));
  });
  it("retains complete missing-intent diagnostic ordering and invariant error contents", () => {
    const input = { ...plan(), runtimeIntents: [] };
    const required = [
      "promise.capability.create",
      "promise.resolve",
      "promise.react",
      "scheduler.enqueue",
      "scheduler.drain",
      "promise.settle.fulfill",
      "promise.settle.reject",
    ];
    const errors = required.map((intent) => ({
      code: "missing-runtime-intent",
      message: "runtime intent " + intent + " is required",
    }));
    expect(asyncPlan.verifyIrAsyncPlan(input)).toEqual(errors);
    expect(asyncPlan.verifyIrAsyncPlan(input)).toEqual(oldAsync.verifyIrAsyncPlan(input));
    let caught: unknown;
    try {
      asyncPlan.assertIrAsyncPlan(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(asyncPlan.IrAsyncPlanInvariantError);
    expect(caught).toBeInstanceOf(oldAsync.IrAsyncPlanInvariantError);
    if (!(caught instanceof asyncPlan.IrAsyncPlanInvariantError)) throw new Error("expected invariant");
    expect(caught.errors).toEqual(errors);
    expect(caught.message).toBe(errors.map((error) => error.code + ": " + error.message).join("\n"));
    expect(caught.name).toBe("IrAsyncPlanInvariantError");
    expect(Object.isFrozen(caught.errors)).toBe(true);
  });
  it("does not admit source-node fields or undefined metadata", () => {
    const input = Object.assign(plan(), { sourceNode: undefined });
    const expected = [
      {
        code: "forbidden-data",
        path: "$plan.sourceNode",
        message: "property sourceNode crosses the async-plan boundary",
      },
      { code: "forbidden-data", path: "$plan.sourceNode", message: "contains non-data value undefined" },
    ];
    expect(asyncPlan.verifyIrAsyncPlan(input)).toEqual(expected);
    expect(asyncPlan.verifyIrAsyncPlan(input)).toEqual(oldAsync.verifyIrAsyncPlan(input));
    expect(() => asyncPlan.createIrAsyncPlan(input)).toThrow(asyncPlan.IrAsyncPlanInvariantError);
  });
});

// Await a real checker child so TypeScript cannot block Vitest's RPC loop.
// Compile the complete imported canonical/compatibility closure of these
// virtual roots with the repository's options. This is not whole-project
// typecheck; no diagnostic from any imported module is discarded.
const compilerChild = [
  'const ts = require("typescript");',
  'const { resolve } = require("node:path");',
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", chunk => { input += chunk; });',
  'process.stdin.on("end", () => {',
  "  try {",
  "    const { root, entries } = JSON.parse(input);",
  '    if (resolve(process.cwd()) !== root) throw new Error("foreign compiler root");',
  '    const configPath = resolve(root, "tsconfig.json");',
  "    const config = ts.readConfigFile(configPath, ts.sys.readFile);",
  "    const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, root, undefined, configPath);",
  "    const sources = new Map(entries);",
  "    const options = { ...parsed.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined, rootDir: root };",
  "    const host = ts.createCompilerHost(options);",
  "    const originalGet = host.getSourceFile.bind(host);",
  "    host.getSourceFile = (path, version, onError, fresh) => sources.has(path)",
  "      ? ts.createSourceFile(path, sources.get(path), version, true) : originalGet(path, version, onError, fresh);",
  "    const program = ts.createProgram({ rootNames: [...sources.keys()], options, host });",
  "    const diagnostics = [...(config.error ? [config.error] : []), ...parsed.errors, ...ts.getPreEmitDiagnostics(program)];",
  "    process.stdout.write(JSON.stringify({",
  "      fixtureTexts: [...sources.keys()].map(path => [path, program.getSourceFile(path)?.text]),",
  "      loadedFiles: program.getSourceFiles().map(file => file.fileName),",
  "      diagnostics: diagnostics.map(d => ({ code: d.code, file: d.file?.fileName,",
  "        line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null,",
  '        message: ts.flattenDiagnosticMessageText(d.messageText, "\\n") })),',
  "    }));",
  "  } catch (error) { process.stderr.write(error.stack ?? String(error)); process.exitCode = 1; }",
  "});",
].join("\n");

interface Compilation {
  fixtureTexts: readonly (readonly [string, string])[];
  loadedFiles: readonly string[];
  diagnostics: readonly { code: number; file?: string; line: number | null; message: string }[];
}

async function compileCompatibility(entries: readonly (readonly [string, string])[]): Promise<Compilation> {
  return await new Promise((resolveCompilation, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=2048", "--input-type=commonjs", "-e", compilerChild], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (failure) => {
      error = failure;
    });
    child.stdin.on("error", (failure) => {
      error ??= failure;
    });
    child.on("close", (code, signal) => {
      if (error || code !== 0 || signal !== null || stderr.length > 0) {
        reject(
          new Error("type fixture child failed: " + JSON.stringify({ code, signal, error: error?.message, stderr })),
        );
        return;
      }
      try {
        resolveCompilation(JSON.parse(stdout) as Compilation);
      } catch (failure) {
        reject(new Error("invalid type fixture report: " + String(failure) + "\n" + stdout));
      }
    });
    child.stdin.end(JSON.stringify({ root, entries }));
  });
}

it("actually compiles legacy/core types, wider runtime features and located negative controls", async () => {
  const imports =
    [
      'import * as Core from "../src/ir/core/intrinsic-contracts.js";',
      'import * as Runtime from "../src/ir/runtime/contracts/intrinsics.js";',
      'import * as Legacy from "../src/ir/intrinsics.js";',
      'import * as Catalog from "../src/ir/core/intrinsics.js";',
      'import * as Intrinsic from "../src/ir/analysis/intrinsics.js";',
      'import * as Effects from "../src/ir/analysis/effects.js";',
      'import * as OldEffects from "../src/ir/effects.js";',
      'import * as Bindings from "../src/ir/core/callable-bindings.js";',
      'import * as OldBindings from "../src/ir/callable-bindings.js";',
    ].join("\n") + "\n";
  const pairs = [
    "IntrinsicSignature",
    "IntrinsicSourceLocation",
    "IntrinsicUse",
    "IntrinsicVerificationCode",
    "IntrinsicVerificationFailure",
  ].flatMap((name) => [
    ["Core." + name, "Runtime." + name],
    ["Core." + name, "Legacy." + name],
  ]);
  pairs.push(
    ["Runtime.IntrinsicDefinition", "Core.IntrinsicDefinition<Runtime.RuntimeFeature>"],
    ["Legacy.IntrinsicDefinition", "Runtime.IntrinsicDefinition"],
    ["OldEffects.IrEffects", "Effects.IrEffects"],
    ["OldEffects.EmissionScheduleViolation", "Effects.EmissionScheduleViolation"],
    ["typeof Legacy.IntrinsicEffectEvidence", "typeof Intrinsic.IntrinsicEffectEvidence"],
  );
  expect(pairs).toHaveLength(15);
  const equalities = pairs.map(
    ([left, right], index) => "const identity" + index + ": Equal<" + left + ", " + right + "> = true;",
  );
  const positive =
    imports +
    [
      "type Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
      ...equalities,
      'const providerOnly: Runtime.IntrinsicDefinition = { id: "math.sin", signature: Catalog.F64_UNARY_INTRINSIC_SIGNATURE, feature: "math.reduce-trig" };',
      "const oldProviderOnly: Legacy.IntrinsicDefinition = providerOnly;",
      "const coreWide: Core.IntrinsicDefinition<Runtime.RuntimeFeature> = oldProviderOnly;",
      "const runtimeTable: Readonly<Record<Catalog.IntrinsicId, Runtime.IntrinsicDefinition>> = Catalog.INTRINSIC_DEFINITIONS;",
      "const oldTable: typeof Legacy.INTRINSIC_DEFINITIONS = runtimeTable;",
      "const bindingApi: typeof OldBindings = Bindings;",
      "const reverseBindingApi: typeof Bindings = OldBindings;",
      "const effectApi: typeof OldEffects = Effects;",
      "const reverseEffectApi: typeof Effects = OldEffects;",
      "const effectVerifier: typeof Legacy.verifyIntrinsicUse = Intrinsic.verifyIntrinsicUse;",
      "void [coreWide, oldTable, bindingApi, reverseBindingApi, effectApi, reverseEffectApi, effectVerifier];",
    ].join("\n");
  const negatives = [
    {
      name: "provider-only-is-not-an-intrinsic",
      code: 2322,
      body: 'const invalid: Catalog.IntrinsicId = "math.reduce-trig";',
    },
    {
      name: "feature-remains-required",
      code: 2741,
      body: 'const invalid: Runtime.IntrinsicDefinition = { id: "math.sin", signature: Catalog.F64_UNARY_INTRINSIC_SIGNATURE };',
    },
    {
      name: "runtime-vocabulary-is-closed",
      code: 2322,
      body: 'const invalid: Runtime.RuntimeFeature = "not-a-feature";',
    },
    {
      name: "feature-remains-readonly",
      code: 2540,
      body: 'declare const row: Runtime.IntrinsicDefinition; row.feature = "math.sin";',
    },
    { name: "generic-feature-is-a-string", code: 2344, body: "type Invalid = Core.IntrinsicDefinition<number>;" },
    {
      name: "evidence-constructor-remains-private",
      code: 2673,
      body: "const invalid = new Intrinsic.IntrinsicEffectEvidence();",
    },
    {
      name: "wide-runtime-row-cannot-narrow-to-core",
      code: 2322,
      body: "declare const row: Runtime.IntrinsicDefinition; const invalid: Core.IntrinsicDefinition<Catalog.IntrinsicId> = row;",
    },
    { name: "core-row-requires-feature-parameter", code: 2314, body: "type Invalid = Core.IntrinsicDefinition;" },
  ] as const;
  expect(negatives).toHaveLength(8);
  const positivePath = resolve(root, "tests/__semantic-types-positive.ts");
  const entries: [string, string][] = [
    [positivePath, positive],
    ...negatives.map((item): [string, string] => [
      resolve(root, "tests/__semantic-types-" + item.name + ".ts"),
      imports + item.body + "\n",
    ]),
  ];
  const report = await compileCompatibility(entries);
  expect(report.fixtureTexts).toEqual(entries);
  for (const path of [
    "src/ir/core/intrinsic-contracts.ts",
    "src/ir/core/intrinsics.ts",
    "src/ir/analysis/intrinsics.ts",
    "src/ir/analysis/effects.ts",
    "src/ir/core/callable-bindings.ts",
    "src/ir/runtime/contracts/intrinsics.ts",
    "src/ir/intrinsics.ts",
    "src/ir/effects.ts",
    "src/ir/callable-bindings.ts",
  ])
    expect(report.loadedFiles).toContain(resolve(root, path));
  // Assert the entire diagnostic vector, not just diagnostics matching probes.
  expect(report.diagnostics.map(({ code, file, line }) => ({ code, file, line }))).toEqual(
    negatives
      .map((item) => ({
        code: item.code,
        file: resolve(root, "tests/__semantic-types-" + item.name + ".ts"),
        line: imports.split("\n").length,
      }))
      .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)),
  );
  expect(report.diagnostics.every((diagnostic) => diagnostic.message.length > 0)).toBe(true);
}, 120_000);
