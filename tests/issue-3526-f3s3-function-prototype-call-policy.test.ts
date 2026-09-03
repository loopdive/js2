// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F3-S3 — the ES5 `%Function.prototype%` CALL seam under frozen manifest
// authority.
//
// Before this slice the resolver arm read LIVE mode (`ctx.standalone`,
// `ctx.wasi`) at every call to decide whether the seam had a target. This suite
// pins the migrated contract: the truth table is resolved into a
// `functionPrototypeCall` policy BEFORE the freeze, the frozen manifest carries
// the provider row, and the resolver arm projects that decided value.
//
// Three measured facts shape the design and are asserted here rather than
// assumed:
//
//  1. The seam has ONE admitting arm. `%Function.prototype%.[[Call]]` on a
//     JS-host lane is not this seam's business — the host object is real there
//     and is reached by ordinary member access — so there is no `host` sibling
//     to select against, and `unsupported` is an absence rather than a second
//     spelling.
//  2. The policy's table is NOT the helper-minting table.
//     `ensureFunctionPrototypeCallHelper` mints under the wider
//     `standalone || wasi` because the LEGACY direct-AST path emits this call on
//     WASI too. Measured: the WASI cell carries `__function_prototype_call` in
//     its module while its IR unit is refused. Support may therefore never be
//     inferred from helper presence.
//  3. The resolver arm's refusal is UNREACHABLE in production, because the
//     selector's `standalone-function-prototype-call` backend capability
//     refuses the shape one stage earlier, at Phase-1 SELECT. That is why the
//     preregister admission is an invariant backstop, and why this migration
//     moves no bytes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compile } from "../src/index.ts";
import { prepareIrRuntimeManifest, preparedFunctionPrototypeCallProvider } from "../src/ir/intrinsic-support.js";
import { asBlockId, type IrFunction } from "../src/ir/nodes.js";
import {
  FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED,
  FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,
  FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS,
  HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS,
  RUNTIME_PROVIDERS,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  type FunctionPrototypeCallPolicy,
  type RuntimeManifestPolicy,
  type RuntimeTarget,
} from "../src/ir/runtime-manifest.js";
import { FUNCTION_PROTOTYPE_CALL_HELPER } from "../src/codegen/function-prototype-callable.js";

const INTEGRATION_SOURCE = readFileSync(new URL("../src/ir/integration.ts", import.meta.url), "utf8");

const FEATURE = FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES[0];
const NATIVE: FunctionPrototypeCallPolicy = { call: "native" };

/** A body-free unit; the seam's demand is a scan result, passed explicitly. */
function emptyFunction(): IrFunction {
  return {
    name: "main",
    params: [],
    paramTypes: [],
    resultTypes: [],
    blocks: [
      { id: asBlockId(0), blockArgs: [], blockArgTypes: [], instrs: [], terminator: { kind: "return", values: [] } },
    ],
    exported: false,
    valueCount: 0,
    funcKind: "function",
  } as unknown as IrFunction;
}

function policy(target: RuntimeTarget, functionPrototypeCall?: FunctionPrototypeCallPolicy): RuntimeManifestPolicy {
  return { target, backend: "wasmgc", ...(functionPrototypeCall ? { functionPrototypeCall } : {}) };
}

function prepare(target: RuntimeTarget, functionPrototypeCall: FunctionPrototypeCallPolicy, demand = true) {
  return prepareIrRuntimeManifest({
    functions: [emptyFunction()],
    sourceFile: "/repo/function-prototype-call.ts",
    policy: policy(target, functionPrototypeCall),
    functionPrototypeCallDemand: demand,
  });
}

// --------------------------------------------------------------------------
// (a) the frozen manifest carries the row, and only where the policy admits
// --------------------------------------------------------------------------
describe("#3526 F3-S3 functionPrototypeCall policy and provider row", () => {
  it("defaults to a frozen disabled policy and publishes it resolved on the frozen manifest", () => {
    expect(Object.isFrozen(FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED)).toBe(true);
    expect(FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED).toEqual({ call: "unsupported" });
    const frozen = new RuntimeManifestBuilder(policy("host")).freeze();
    expect(frozen.policy.functionPrototypeCall).toEqual(FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED);
    expect(Object.isFrozen(frozen.policy.functionPrototypeCall)).toBe(true);
  });

  it("is a SIBLING of the F3-S1 maker policy, not a widening of it", () => {
    // The maker keeps its two arms; this seam has exactly one. If the two ever
    // merge, a native dispatch licence becomes able to answer a call seam that
    // has no host crossing at all.
    expect([...HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS]).toEqual(["host.callback.wrap", "native.callback.dispatch"]);
    expect([...FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS]).toEqual(["native.js.function.prototype.call"]);
    expect(FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES).toEqual(["js.function.prototype.call"]);
  });

  it("a standalone adapter carries the native.js.function.prototype.call row", () => {
    const prepared = prepare("standalone", NATIVE);
    const provider = prepared?.manifest.providers.find((candidate) => candidate.feature === FEATURE);
    expect(provider?.id).toBe("native.js.function.prototype.call");
    expect(provider?.implementation).toEqual({
      kind: "runtime-callable",
      symbol: FUNCTION_PROTOTYPE_CALL_HELPER,
    });
    // The native arm acquires no host capability: this seam must not pull any
    // import into the manifest's capability closure.
    expect(provider?.hostCapabilities).toEqual([]);
  });

  it("host and wasi adapters carry no row, because the projection resolves them unsupported", () => {
    // Both are `unsupported` under `integrationFunctionPrototypeCallPolicy`, so
    // no demand is ever requested for them and the manifest stays clean.
    for (const target of ["host", "wasi"] as const) {
      expect(prepare(target, FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED, false)).toBeUndefined();
    }
  });

  it("an unsupported policy WITH demand is a typed provider-target-unavailable naming the policy", () => {
    let caught: unknown;
    try {
      prepare("standalone", FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeManifestInvariantError);
    expect((caught as RuntimeManifestInvariantError).code).toBe("provider-target-unavailable");
    expect((caught as Error).message).toContain(FEATURE);
    expect((caught as Error).message).toContain("call=unsupported");
  });
});

// --------------------------------------------------------------------------
// (d) the prepared reader hands back the runtime arm and its exact ABI
// --------------------------------------------------------------------------
describe("#3526 F3-S3 preparedFunctionPrototypeCallProvider", () => {
  it("returns the runtime-callable arm naming the helper, and carries NO signature", () => {
    const arm = preparedFunctionPrototypeCallProvider(prepare("standalone", NATIVE));
    expect(arm?.arm).toBe("native");
    expect(arm?.symbol).toBe(FUNCTION_PROTOTYPE_CALL_HELPER);
    // The plan specified a `() -> externref` signature here. Measured, that
    // spelling is `EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE`, and F2-S8 pins the
    // string-const family as the catalogue's ONLY empty-parameter rows — its
    // stated reason being that an empty-params signature describes a stored
    // VALUE, so an empty-params row can only be a storage row. A nullary CALL is
    // not a storage row. The row therefore carries no signature, exactly like
    // its F3-S1 family sibling, and the physical ABI stays where it already
    // lived: `ensureFunctionPrototypeCallHelper`'s `addFuncType`.
    expect(arm?.signature).toBeUndefined();
    const stringConstOnly = (RUNTIME_PROVIDERS as readonly { id: string; signature?: { params: readonly unknown[] } }[])
      .filter((provider) => provider.signature !== undefined && provider.signature.params.length === 0)
      .map((provider) => provider.id);
    expect(stringConstOnly).not.toContain("native.js.function.prototype.call");
  });

  it("returns undefined when the manifest carries no row", () => {
    expect(preparedFunctionPrototypeCallProvider(undefined)).toBeUndefined();
    expect(
      preparedFunctionPrototypeCallProvider(prepare("standalone", FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED, false)),
    ).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// (b) census guard — the outcome table must not move, in any cell
// --------------------------------------------------------------------------
//
// This block is GREEN ON BASE by construction. It is not a demonstration of new
// behaviour; it is the acceptance bar for the migration, pinned exactly as
// measured on `origin/main` before the edit (2026-09-03). Any cell that moves is
// a defect, not a feature.
//
// AXIS NOTE: `{compat, fast}` is the `fast` axis and is a CONTROL — the policy
// truth table reads only the TARGET axis. The two must not be collapsed.
const CENSUS = [
  {
    label: "gc/compat",
    options: { target: "gc", fast: false },
    code: "call-resolution-unsupported",
    stage: "select",
    helper: false,
  },
  {
    label: "gc/fast",
    options: { target: "gc", fast: true },
    code: "call-resolution-unsupported",
    stage: "select",
    helper: false,
  },
  {
    label: "standalone/compat",
    options: { target: "standalone", fast: false },
    code: "emitted",
    stage: "patch",
    helper: true,
  },
  {
    label: "standalone/fast",
    options: { target: "standalone", fast: true },
    code: "emitted",
    stage: "patch",
    helper: true,
  },
  // WASI refuses the IR unit yet still CARRIES the helper: the legacy
  // direct-AST path mints it under the wider `standalone || wasi` table. This
  // row is the standing proof that helper presence is not support.
  { label: "wasi", options: { target: "wasi" }, code: "call-resolution-unsupported", stage: "select", helper: true },
] as const;

const FIXTURE = `
export function callsFunctionPrototype(): number {
  Function.prototype();
  Function.prototype(1, 2);
  return 0;
}
`;

describe("#3526 F3-S3 census is byte-unchanged across the target and fast axes", () => {
  for (const cell of CENSUS) {
    it(`${cell.label} stays ${cell.code}@${cell.stage} with helper=${cell.helper}`, async () => {
      const result = await compile(FIXTURE, {
        fileName: "f3s3-census.ts",
        trackIrOutcomes: true,
        ...cell.options,
      } as never);
      const row = (result.irOutcomes ?? []).find((entry) => entry.displayName === "callsFunctionPrototype");
      expect(row, "the fixture's unit must appear in the ledger").toBeDefined();
      expect(row!.kind === "emitted" ? "emitted" : (row as { code?: string }).code).toBe(cell.code);
      expect(row!.stage).toBe(cell.stage);
      expect(result.wat?.includes(FUNCTION_PROTOTYPE_CALL_HELPER) ?? false).toBe(cell.helper);
    });
  }
});

// --------------------------------------------------------------------------
// (c) the backstop, and the projection that makes it unreachable
// --------------------------------------------------------------------------
describe("#3526 F3-S3 the resolver projects a decided policy, the preregister admits it", () => {
  it("projects the policy ONCE, before the freeze, from the target axis alone", () => {
    const start = INTEGRATION_SOURCE.indexOf("function integrationFunctionPrototypeCallPolicy(");
    expect(start).toBeGreaterThan(0);
    const projection = INTEGRATION_SOURCE.slice(start, INTEGRATION_SOURCE.indexOf("\n}", start));
    expect(projection).toContain("ctx.standalone && !ctx.wasi");
    // The `fast` axis is a different question and must never enter this table.
    expect(projection).not.toContain("ctx.fast");
    // No live manifest read: this runs before the freeze.
    expect(projection).not.toContain("prepared");
  });

  it("the resolver arm reads the resolved policy, never live mode", () => {
    const start = INTEGRATION_SOURCE.indexOf("    functionPrototypeCallTarget() {");
    expect(start).toBeGreaterThan(0);
    const arm = INTEGRATION_SOURCE.slice(start, INTEGRATION_SOURCE.indexOf("\n    },", start));
    expect(arm).toContain('functionPrototypeCall.call !== "native"');
    // The two mode reads this slice deleted must not come back.
    expect(arm).not.toContain("ctx.standalone");
    expect(arm).not.toContain("ctx.wasi");
  });

  it("refuses a helper call with no native arm in the frozen manifest, at resolve", () => {
    // UNREACHABLE in-tree — the selector refuses the shape one stage earlier —
    // so this is pinned on the source slice, exactly as F3-S1 pinned its own
    // unreachable maker admission, plus the live typed refusal asserted in (a).
    const start = INTEGRATION_SOURCE.indexOf("function admitFunctionPrototypeCall(");
    expect(start).toBeGreaterThan(0);
    const admission = INTEGRATION_SOURCE.slice(start, INTEGRATION_SOURCE.indexOf("\n}", start));
    expect(admission).toContain("selection-preparation-mismatch");
    expect(admission).toContain('"resolve"');
    expect(admission).toContain('arm?.arm !== "native"');
    // Fails closed: no `??` fallback to a locally decided symbol, and the bound
    // symbol comes from the frozen arm rather than being spelled at the seam.
    expect(admission).toContain("observeNativeRuntimeProvider(ctx, arm.symbol)");
    expect(admission).not.toContain("funcMap");
    // The scan that feeds it runs inside the preregister pass.
    expect(INTEGRATION_SOURCE).toContain(
      "admitFunctionPrototypeCall(ctx, usesFunctionPrototypeCall, functionPrototypeCallArm)",
    );
  });

  it("scans the demand exactly where the admission re-reads it", () => {
    expect(INTEGRATION_SOURCE).toContain(
      "functionPrototypeCallDemand: irFunctionPrototypeCallDemand(entries.map((entry) => entry.fn))",
    );
    const start = INTEGRATION_SOURCE.indexOf("function irFunctionPrototypeCallDemand(");
    expect(start).toBeGreaterThan(0);
    const scan = INTEGRATION_SOURCE.slice(start, INTEGRATION_SOURCE.indexOf("\n}", start));
    expect(scan).toContain('instr.kind !== "call" || instr.target.binding.kind !== "runtime"');
    expect(scan).toContain("FUNCTION_PROTOTYPE_CALL_HELPER");
  });
});
