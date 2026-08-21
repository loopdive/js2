// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr } from "../ir/types.js";
import { ensureArrayNativeProtoGlue } from "./array-object-proto.js";
import { definedFuncAt } from "./func-space.js";
import { emitLazyNativeProtoGet } from "./native-proto.js";
import { fillVecOverlayHelpers } from "./vec-overlay.js";
import { fillCarrierBagDelete } from "./carrier-bag-delete.js";
import { fillCarrierBagVisibility } from "./carrier-bag-visibility.js";
import { fillVecPropsKeySource } from "./vec-props-key-source.js";
import { fillGopnVecArm, fillVecOverlayPushKeys } from "./vec-overlay-keys.js";
import { fillVecIndexEnumerable } from "./vec-index-enumerable.js";

/** Finalize the generic vec overlay before installing the exact `$ObjVec` prototype arm. */
export function fillObjVecReflectionHelpers(ctx: CodegenContext): void {
  fillVecOverlayHelpers(ctx);
  // (#4010 S2) `__carrier_bag_delete`'s body needs `__delete_property`'s own
  // funcIdx, so it is reserved early and filled here — the same finalize pass
  // that owns the rest of the overlay↔bag seam. Order-independent: every caller
  // baked the reserved index, and both bag lookups are funcMap entries from
  // RESERVE time, not fill time.
  fillCarrierBagDelete(ctx);
  // (#4010 S3) Same reason, same pass: `__carrier_bag_gopd` needs
  // `__getOwnPropertyDescriptor`'s funcIdx and the key walker needs
  // `__obj_ordered`/`__obj_ordered_all`, none of which exist at reserve time.
  fillCarrierBagVisibility(ctx);
  // (#4230) Same pass, same reason: `__vec_props_keysrc` unions the #3537 bag
  // with the #3251 overlay companion, and `__vec_overlay_lookup` is minted by
  // `fillVecOverlayHelpers` above — it does not exist at reserve time. A
  // skipped fill leaves the null placeholder, i.e. the caller keeps refusing.
  fillVecPropsKeySource(ctx);
  // (#4230 L1) Same pass, same reason as the two above: `__vec_overlay_lookup`
  // is minted by `fillVecOverlayHelpers`, so the overlay key pusher reserved in
  // `fillDynamicForinVecArms` gets its real body here. `fillGopnVecArm` is the
  // other half — the `$__vec_base` arm `__getOwnPropertyNames` never had — and
  // is placed here so it can bake the same (now-filled) index.
  fillVecOverlayPushKeys(ctx);
  // (#4491) Same pass, same reason: the `for…in` `[[Enumerable]]` gate reserved
  // at for-in emit time reads `__vec_overlay_lookup`, which only exists after
  // `fillVecOverlayHelpers` above. A skipped fill leaves the "enumerable"
  // placeholder, i.e. the pre-#4491 answer.
  fillVecIndexEnumerable(ctx);
  fillGopnVecArm(ctx);
  fillObjVecArrayPrototypeArm(ctx);
}

/**
 * #3666 — make the internal `$ObjVec` array carrier report the exact shared
 * `%Array.prototype%` identity through the dynamic Object/Reflect prototype
 * helper. `$ObjVec` backs RegExp match-indices arrays and their `[s,e]` pairs,
 * but deliberately is not a normal `vecTypeMap` entry.
 *
 * The arm is exact-carrier gated rather than `$__vec_base` gated: typed-array
 * and other vec-shaped values retain their own prototype semantics.
 */
export function fillObjVecArrayPrototypeArm(ctx: CodegenContext): void {
  const state = ctx as CodegenContext & { objVecArrayPrototypeArmFilled?: boolean };
  if (state.objVecArrayPrototypeArmFilled || !ctx.standalone) return;
  const objVecTypeIdx = ctx.objectRuntimeTypes?.objVecTypeIdx;
  const getProtoIdx = ctx.funcMap.get("__getPrototypeOf");
  const getProtoFn = getProtoIdx === undefined ? undefined : definedFuncAt(ctx, getProtoIdx);
  if (objVecTypeIdx === undefined || !getProtoFn) return;

  const brand = ensureArrayNativeProtoGlue(ctx);
  if (brand === undefined) return;
  const protoBody: Instr[] = [];
  const fctxLike = {
    name: "__getPrototypeOf",
    body: protoBody,
    locals: getProtoFn.locals,
    params: [{ name: "obj", type: { kind: "externref" } }],
    localMap: new Map(),
  } as unknown as FunctionContext;
  if (!emitLazyNativeProtoGet(ctx, fctxLike, brand)) return;
  protoBody.push({ op: "return" });
  getProtoFn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: protoBody },
  );
  state.objVecArrayPrototypeArmFilled = true;
}
