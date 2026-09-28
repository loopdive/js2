// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { buildObjectSameValueBody } from "../runtime/wasmgc/values/object-same-value-body.js";
import type { CodegenContext } from "./context/types.js";
import type { ObjectEnumerationHelperState } from "./object-runtime-enumeration.js";
import { ensureBigIntCarrierEq } from "./bigint-wide.js";
import { addUnionImportsViaRegistry } from "./shared.js";

/** Register SameValue at its original final enumeration step, using captured string bindings. */
export function registerObjectSameValueHelper(
  ctx: CodegenContext,
  bindings: Pick<ObjectEnumerationHelperState, "registerNative" | "anyStrTypeIdx" | "strFlattenIdx" | "strEqualsIdx">,
): void {
  const { registerNative, anyStrTypeIdx, strFlattenIdx, strEqualsIdx } = bindings;
  // ── __object_is(externref a, externref b) -> i32 (#2042 S3 — Object.is) ────
  //
  // SameValue (§7.2.10) over two boxed externrefs. Tag-dispatched like the
  // union-helper `===` lowering, but with the SameValue numeric rule:
  // NaN is SameValue NaN, and +0 is NOT SameValue -0. Comparing the f64 bit
  // patterns (`i64.reinterpret_f64` + `i64.eq`) gives exactly that — equal NaN
  // bit patterns compare equal, and +0 (0x0…) vs -0 (0x8000…) compare unequal.
  // boolean → unbox i32; bigint → exact carrier equality; both-null → equal; else ref identity.
  //
  // NATIVE-PROVIDER (`semanticProviders === "native-first"`), not merely
  // standalone-only (#2609/#4397). The
  // native `__defineProperty_value` block below is registered UNCONDITIONALLY by
  // this runtime and its #2042-S4 ValidateAndApplyPropertyDescriptor preflight
  // bakes a direct `call __object_is` for the SameValue value-change check. WASI
  // is host-free too (no JS `__object_is` import — `--target wasi` sets
  // `ctx.wasi` but leaves `ctx.standalone` false), so gating this registration on
  // `ctx.standalone` alone left `funcMap.get("__object_is")` undefined in WASI,
  // and the define helper baked an undefined funcIdx → "function index out of
  // range — undefined at __defineProperty_value" hard emit error (loopdive/js2wasm#389).
  // The compatibility-provider path still owns `__object_is` via its JS import,
  // so its output stays byte-identical.
  if (ctx.targetProfile.semanticProviders === "native-first") {
    addUnionImportsViaRegistry(ctx);
    const bigintEqualityIdx = ensureBigIntCarrierEq(ctx);
    if (bigintEqualityIdx === undefined) throw new Error("native SameValue requires canonical BigInt carrier equality");
    const typeofNumIdx = ctx.funcMap.get("__typeof_number")!;
    const typeofBoolIdx = ctx.funcMap.get("__typeof_boolean")!;
    const typeofBigIdx = ctx.funcMap.get("__typeof_bigint")!;
    const unboxNumIdx = ctx.funcMap.get("__unbox_number")!;
    const unboxBoolIdx = ctx.funcMap.get("__unbox_boolean")!;
    registerNative(
      "__object_is",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "aa", type: { kind: "anyref" } },
        { name: "ba", type: { kind: "anyref" } },
      ],
      buildObjectSameValueBody({
        typeofNumIdx,
        typeofBoolIdx,
        typeofBigIdx,
        unboxNumIdx,
        unboxBoolIdx,
        bigint: { kind: "carrier", equalIdx: bigintEqualityIdx },
        anyStrTypeIdx,
        strFlattenIdx,
        strEqualsIdx,
      }),
    );
  }
}
