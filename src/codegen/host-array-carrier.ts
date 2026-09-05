// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4649) The JS-HOST half of #2047's fix: a LATE-BOUND "is this externref one
// of this module's compiled array carriers?" predicate.
//
// Standalone already had one. `Object.getOwnPropertyDescriptor`-style
// reflection aside, `Array.isArray` over an externref is a `ref.test` ladder
// over every registered vec struct type, and the host lane built that ladder
// INLINE from `Array.from(ctx.vecTypeMap.values())` — an EMISSION-TIME
// snapshot. Whatever the module registers afterwards is invisible to it.
//
// That is not a corner case for test262: `assembleOriginalHarness` compiles the
// harness PREFIX and then the test BODY as one unit, so every `Array.isArray`
// inside `deepEqual.js` / `compareArray.js` / `propertyHelper.js` bakes its
// ladder before the body has minted a single carrier. A `boolean[]` first seen
// in the body (`__vec_i32`) therefore answered `false`, `deepEqual` fell
// through to its structural walk, found no own keys on either side, and judged
// `{b:[true]}` equal to `{b:[false]}` (`test/harness/deepEqual-deep.js`).
//
// The fix mirrors `fillExternIsArray` exactly — mint a placeholder function on
// first use, fill its body at FINALIZE from the same
// `collectStandaloneArrayCarrierTypeIdxs` list (which is where the §7.2.2
// byte-carrier exclusions live) — so declaration order stops mattering. Two
// alternatives are deliberately NOT taken:
//
//   * pre-registering the missing carriers in `createCodegenContext`: it puts
//     `__vec_i32` in modules that never build an i32 array, which the #1197
//     "promotion did NOT fire" WAT assertions read as a promotion;
//   * a single `ref.test $__vec_base`: every byte vec, subview, TypedArray view
//     and the regexp match-result struct also subtype it (#3562/#4443), so
//     `Array.isArray(new Uint8Array(2))` would answer `true`.

import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import type { CodegenContext } from "./context/types.js";
import type { Instr } from "../ir/types.js";
import { collectStandaloneArrayCarrierTypeIdxs } from "./object-runtime.js";
import { addFuncType } from "./registry/types.js";

const HOST_ARRAY_CARRIER = "__host_array_carrier";

/**
 * Get (minting on first use) the module-local `(externref) -> i32` predicate
 * that answers "is this value one of THIS module's compiled array carriers?".
 *
 * The body is a placeholder `i32.const 0` until
 * {@link fillHostArrayCarrierPredicate} runs at finalize; callers only ever
 * bake the funcIdx, which is stable.
 */
export function ensureHostArrayCarrierPredicate(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(HOST_ARRAY_CARRIER);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$__host_array_carrier_type");
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: HOST_ARRAY_CARRIER,
    typeIdx,
    locals: [{ name: "any", type: { kind: "anyref" } }],
    body: [{ op: "i32.const", value: 0 }],
    exported: false,
  });
  ctx.funcMap.set(HOST_ARRAY_CARRIER, funcIdx);
  return funcIdx;
}

/**
 * Fill the predicate once every module-local carrier type is registered. No-op
 * when no call site ever minted it, so modules without a dynamic
 * `Array.isArray` are byte-identical.
 */
export function fillHostArrayCarrierPredicate(ctx: CodegenContext): void {
  const funcIdx = ctx.funcMap.get(HOST_ARRAY_CARRIER);
  if (funcIdx === undefined) return;
  const fn = definedFuncAt(ctx, funcIdx);
  if (!fn) return;

  const anyLocal = 1;
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocal },
  ];
  let chain: Instr[] = [{ op: "i32.const", value: 0 }];
  const carrierTypeIdxs = collectStandaloneArrayCarrierTypeIdxs(ctx);
  for (let i = carrierTypeIdxs.length - 1; i >= 0; i--) {
    chain = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: carrierTypeIdxs[i]! },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 }],
        else: chain,
      },
    ];
  }
  body.push(...chain);
  fn.locals = [{ name: "any", type: { kind: "anyref" } }];
  fn.body = body;
}
