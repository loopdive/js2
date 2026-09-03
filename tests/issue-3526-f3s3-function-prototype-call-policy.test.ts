// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #3526 F3-S3 — `%Function.prototype%.[[Call]]` moves under manifest authority.
//
// Family 3's second slice, and the first policy in the whole issue with exactly
// ONE admitting arm. `%Function.prototype%` is a callable intrinsic object whose
// `[[Call]]` discards every argument and returns `undefined` (ES5 §15.3.4):
//
//  * **native** — the host-free standalone lane owns the entry point through the
//    compiler-minted zero-parameter helper `__function_prototype_call`.
//
//  * **unsupported** — everywhere else. That is not a refusal of live traffic:
//    the selector's `standalone-function-prototype-call` backend capability
//    (`backend/legality.ts`: `target === "standalone" && !allowHostImports`)
//    already declines the whole call shape one stage earlier, so no front-end
//    arm ever asks. There is deliberately no `host` arm — on a JS-host lane the
//    real `Function.prototype` object answers the call itself.
//
// Two consequences shape this file:
//
//  * **The decision is settled at BUILD, not at resolve (census open question
//    4).** The consumer (`from-ast.ts:7554`) runs in Phase 1, before the freeze
//    and before any owner is claimed, so F3-S1's post-freeze admission model
//    would turn a clean pre-claim demote into a post-claim one. The resolver arm
//    therefore projects an already-resolved policy value and the frozen row is
//    the resolve-time backstop behind it.
//
//  * **The row is requested on the demand AND the policy.** Requesting it on the
//    demand alone would refuse a hand-built `unsupported` policy inside
//    `freeze()` with `provider-target-unavailable` — a GLOBAL preparation
//    failure. Leaving the row out instead routes that case to the resolve-time
//    admission, which names the seam and the arm.
//
// Census neutrality is the contract, and it held: the five-cell table below and
// the 105-row corpus byte matrix are identical before and after.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { admitEmittedFunctionPrototypeCall } from "../src/ir/integration.js";
import { prepareIrRuntimeManifest, preparedFunctionPrototypeCallProvider } from "../src/ir/intrinsic-support.js";
import { irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { asBlockId, asValueId, irVal, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import {
  FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED,
  FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,
  FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  type FunctionPrototypeCallPolicy,
  type RuntimeManifestPolicy,
} from "../src/ir/runtime-manifest.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-f3s3-function-prototype-call");
const INTEGRATION_SOURCE = readFileSync(new URL("../src/ir/integration.ts", import.meta.url), "utf8");

const HELPER = "__function_prototype_call";
const FEATURE = FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES[0];
const PROVIDER_ID = FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS[0];

const NATIVE: FunctionPrototypeCallPolicy = { call: "native" };
const UNSUPPORTED: FunctionPrototypeCallPolicy = { call: "unsupported" };

/** The pinned fixture: the zero-argument and the two-argument shapes. */
const SOURCE = `
export function zero(): void {
  Function.prototype();
}
export function two(): void {
  Function.prototype(1, 2);
}
`;

/**
 * One hand-built owner carrying exactly the `call` from-ast emits for
 * `Function.prototype()` — and nothing else.
 *
 * It carries no `intrinsic` instruction and no async plan, which is the point:
 * without `functionPrototypeCallDemand` this owner freezes NO manifest at all,
 * so the emitted call would have no authority to be admitted by.
 */
function callerFunction(name: string, symbol: string): IrFunction {
  const call = {
    kind: "call",
    target: irRuntimeFuncRef(symbol),
    args: [],
    result: asValueId(0),
    resultType: irVal({ kind: "externref" }),
  } as unknown as IrInstr;
  return {
    unitId: identities.next(name).unitId,
    name,
    params: [],
    resultTypes: [{ kind: "externref" }],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [call],
        terminator: { kind: "return", values: [asValueId(0)] },
      },
    ],
    exported: false,
    valueCount: 1,
    funcKind: "regular",
  } as unknown as IrFunction;
}

function policy(
  functionPrototypeCall: FunctionPrototypeCallPolicy | undefined,
  target: RuntimeManifestPolicy["target"] = "standalone",
): RuntimeManifestPolicy {
  return { target, backend: "wasmgc", ...(functionPrototypeCall ? { functionPrototypeCall } : {}) };
}

function prepare(
  functionPrototypeCall: FunctionPrototypeCallPolicy | undefined,
  target: RuntimeManifestPolicy["target"] = "standalone",
  options: { readonly demand?: boolean; readonly symbol?: string } = {},
) {
  return prepareIrRuntimeManifest({
    functions: [callerFunction("zero", options.symbol ?? HELPER)],
    sourceFile: "/repo/function-prototype.ts",
    policy: policy(functionPrototypeCall, target),
    functionPrototypeCallDemand: options.demand ?? true,
  });
}

async function compileFixture(options: Parameters<typeof compile>[1] = {}): Promise<CompileResult> {
  return compile(SOURCE, {
    fileName: "issue-3526-f3s3.ts",
    trackIrOutcomes: true,
    emitWat: true,
    ...options,
  });
}

/** The measured census row for one lane, in the shape section (b) pins. */
function censusRow(result: CompileResult): string {
  const rows = (result.irOutcomes ?? [])
    .filter((outcome) => outcome.displayName === "zero" || outcome.displayName === "two")
    .map(
      (outcome) =>
        `${outcome.displayName}:${outcome.kind}` +
        `${(outcome as { code?: string }).code ? `/${String((outcome as { code?: string }).code)}` : ""}` +
        `@${outcome.stage}[ir=${String(outcome.irBodyEmitted)}]`,
    )
    .sort()
    .join(" ");
  return `success=${String(result.success)} helper=${String((result.wat ?? "").includes(HELPER))} ${rows}`;
}

describe("#3526 F3-S3 — (a) the frozen row follows the resolved policy", () => {
  it("a standalone non-wasi adapter freezes the native provider row", () => {
    const prepared = prepare(NATIVE);
    expect(prepared).toBeDefined();
    const row = prepared!.manifest.providers.find((candidate) => candidate.feature === FEATURE);
    expect(row).toBeDefined();
    expect(row!.id).toBe(PROVIDER_ID);
    expect(row!.implementation).toEqual({ kind: "runtime-callable", symbol: HELPER });
    // No host capability is cited, because the seam has no host arm at all.
    expect(row!.hostCapabilities).toEqual([]);
    expect(prepared!.manifest.policy.functionPrototypeCall).toEqual({ call: "native" });
  });

  it("gc and wasi adapters resolve `unsupported` and freeze NO row", () => {
    for (const target of ["host", "wasi"] as const) {
      const prepared = prepare(UNSUPPORTED, target);
      // Nothing else in this owner demands a manifest, so the whole freeze is
      // skipped — which is exactly "carries no row".
      expect(prepared).toBeUndefined();
    }
    // …and when something else does freeze one, the row is still absent.
    const withRow = prepare(NATIVE);
    expect(withRow!.manifest.features).toContain(FEATURE);
  });

  it("omitting the policy resolves to the disabled arm on the frozen twin", () => {
    const builder = new RuntimeManifestBuilder({ target: "standalone", backend: "wasmgc" });
    expect(builder.freeze().policy.functionPrototypeCall).toEqual(FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED);
  });

  it("requesting the feature under an unsupported policy is refused by name", () => {
    const builder = new RuntimeManifestBuilder({
      target: "standalone",
      backend: "wasmgc",
      functionPrototypeCall: UNSUPPORTED,
    });
    builder.requestFeature(FEATURE);
    // One shot only — the builder latches "failed" after the first refusal, so
    // a second `freeze()` reports that latch instead of the policy refusal.
    let refusal: unknown;
    try {
      builder.freeze();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(RuntimeManifestInvariantError);
    expect((refusal as RuntimeManifestInvariantError).message).toContain("function-prototype-call policy");
    expect((refusal as RuntimeManifestInvariantError).message).toContain("call=unsupported");
  });

  it("the integration projection is the arm's only truth table", () => {
    const start = INTEGRATION_SOURCE.indexOf("function integrationFunctionPrototypeCallPolicy(");
    expect(start).toBeGreaterThan(0);
    const projection = INTEGRATION_SOURCE.slice(start, INTEGRATION_SOURCE.indexOf("\n}", start));
    expect(projection).toContain('ctx.standalone && !ctx.wasi ? ("native" as const) : ("unsupported" as const)');
    // Resolved once, above the arms — the arm itself must not read the mode.
    expect(INTEGRATION_SOURCE).toContain(
      "const functionPrototypeCallPolicy = integrationFunctionPrototypeCallPolicy(ctx);",
    );
    expect(INTEGRATION_SOURCE).toContain('if (functionPrototypeCallPolicy.call !== "native") return null;');
    expect(INTEGRATION_SOURCE).not.toContain("if (!ctx.standalone || ctx.wasi) return null;");
  });
});

describe("#3526 F3-S3 — (b) census-unchanged guard", () => {
  // Green on base BY CONSTRUCTION: this is the acceptance bar, not a new
  // capability. Any cell that moves is a defect of this slice.
  const CELLS: { readonly name: string; readonly options: Parameters<typeof compile>[1]; readonly row: string }[] = [
    {
      name: "gc/compat",
      options: { target: "gc", fast: false },
      row:
        "success=true helper=false " +
        "two:unsupported/call-resolution-unsupported@select[ir=false] " +
        "zero:unsupported/call-resolution-unsupported@select[ir=false]",
    },
    {
      name: "gc/fast",
      options: { target: "gc", fast: true },
      row:
        "success=true helper=false " +
        "two:unsupported/call-resolution-unsupported@select[ir=false] " +
        "zero:unsupported/call-resolution-unsupported@select[ir=false]",
    },
    {
      name: "standalone/compat",
      options: { target: "standalone", fast: false },
      row: "success=true helper=true two:emitted@patch[ir=true] zero:emitted@patch[ir=true]",
    },
    {
      name: "standalone/fast",
      options: { target: "standalone", fast: true },
      row: "success=true helper=true two:emitted@patch[ir=true] zero:emitted@patch[ir=true]",
    },
    {
      name: "wasi",
      options: { target: "wasi" },
      // The helper IS present on wasi — the LEGACY arm
      // (`codegen/expressions/call-builtin-static.ts`) mints it there. The IR
      // arm is `unsupported`, which is why both owners demote at select.
      row:
        "success=true helper=true " +
        "two:unsupported/call-resolution-unsupported@select[ir=false] " +
        "zero:unsupported/call-resolution-unsupported@select[ir=false]",
    },
  ];

  for (const cell of CELLS) {
    it(`${cell.name} is unmoved`, { timeout: 120_000 }, async () => {
      expect(censusRow(await compileFixture(cell.options))).toBe(cell.row);
    });
  }
});

describe("#3526 F3-S3 — (c) the resolve-time backstop", () => {
  it("a hand-built unsupported policy freezes no row for a program that emits the call", () => {
    // The demand is real (the owner carries the call), but the policy refuses
    // the seam — so the freeze succeeds and simply carries no arm. That is the
    // exact input the admission below refuses, and the reason the refusal is a
    // resolve-time `IrInvariantError` rather than a global freeze failure.
    const prepared = prepare(UNSUPPORTED, "standalone", { demand: true });
    expect(preparedFunctionPrototypeCallProvider(prepared)).toBeUndefined();
  });

  it("the production admission refuses an emitted call with no native arm", () => {
    const call = callerFunction("zero", HELPER).blocks[0]!.instrs[0]!;
    expect(() => admitEmittedFunctionPrototypeCall(call, undefined)).toThrowError(
      /selection-preparation-mismatch|no native arm in the frozen manifest/,
    );
    try {
      admitEmittedFunctionPrototypeCall(call, undefined);
      expect.unreachable("admission must refuse an absent arm");
    } catch (error) {
      const invariant = error as { code?: string; stage?: string; message: string };
      expect(invariant.code).toBe("selection-preparation-mismatch");
      expect(invariant.stage).toBe("resolve");
      expect(invariant.message).toContain(HELPER);
      expect(invariant.message).toContain("arm=none");
    }
  });

  it("the production admission ADMITS the call the frozen native row names", () => {
    const arm = preparedFunctionPrototypeCallProvider(prepare(NATIVE));
    expect(arm).toEqual({ arm: "native", target: irRuntimeFuncRef(HELPER) });
    const call = callerFunction("zero", HELPER).blocks[0]!.instrs[0]!;
    expect(admitEmittedFunctionPrototypeCall(call, arm)).toBe(true);
  });

  it("the admission ignores every call that is not this seam", () => {
    const other = callerFunction("zero", "__box_number").blocks[0]!.instrs[0]!;
    expect(admitEmittedFunctionPrototypeCall(other, undefined)).toBe(false);
  });

  it("the preregister scan invokes the admission (non-vacuity of the backstop)", () => {
    // `preregisterDynamicSupport` is internal and has no policy injection point,
    // so this pin is what makes the previous cases non-vacuous: revert the scan
    // alone and this assertion goes red.
    expect(INTEGRATION_SOURCE).toContain(
      "const functionPrototypeCallArm = preparedFunctionPrototypeCallProvider(prepared);",
    );
    expect(INTEGRATION_SOURCE).toContain(
      "if (admitEmittedFunctionPrototypeCall(i, functionPrototypeCallArm)) usesFunctionPrototypeCall = true;",
    );
    expect(INTEGRATION_SOURCE).toContain(
      "if (usesFunctionPrototypeCall) observeNativeRuntimeProvider(ctx, FUNCTION_PROTOTYPE_CALL_HELPER);",
    );
  });
});

describe("#3526 F3-S3 — (d) the prepared arm's exact ABI", () => {
  it("returns the runtime-callable arm with the `() -> externref` signature", () => {
    const prepared = prepare(NATIVE);
    expect(preparedFunctionPrototypeCallProvider(prepared)).toEqual({
      arm: "native",
      target: irRuntimeFuncRef(HELPER),
    });
    const row = prepared!.manifest.providers.find((candidate) => candidate.feature === FEATURE)!;
    expect(row.signature?.params).toEqual([]);
    expect(row.signature?.result).toEqual(irVal({ kind: "externref" }));
  });

  it("returns undefined when no manifest carries the row", () => {
    expect(preparedFunctionPrototypeCallProvider(undefined)).toBeUndefined();
    expect(preparedFunctionPrototypeCallProvider(prepare(UNSUPPORTED, "standalone", { demand: true }))).toBeUndefined();
  });
});
