// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 H4) `__getOwnPropertySymbols`' missing `$__vec_base` arm — the SYMBOL
 * twin of `fillGopnVecArm`.
 *
 * ## The defect, measured standalone on the base tree
 *
 * ```js
 * var symA = Symbol("a"), symB = Symbol("b");
 * var arr = [1, 2];
 * arr[symA] = 10;
 * Object.defineProperty(arr, symB, { value: 20, configurable: true });
 * ```
 *
 * | question                                  | base | spec |
 * | ----------------------------------------- | ---: | ---: |
 * | `Object.getOwnPropertySymbols(arr).length` |  `0` |  `2` |
 * | `arr[symA]` / `arr[symB]`                  | `10` / `20` ✓ | `10` / `20` |
 * | `Object.getOwnPropertyNames(arr)`          | `0,1,length` ✓ | `0,1,length` |
 * | the same two defines on a PLAIN object     |  `2` ✓ | `2` |
 *
 * The values are right, the names surface is right, and the plain-object
 * carrier is right — which is exactly what identifies this as a carrier gap
 * rather than a symbol-key gap. #2866 PR1 made `__getOwnPropertySymbols`
 * carrier-correct for `$Object`, and H2 (#6651) routed symbol keys on an array
 * into the #3251 overlay companion and the #3537 bag. Nothing ever taught the
 * gOPS native to LOOK in either of those for a `$__vec_base` receiver: its
 * non-`$Object` branch returns a fresh empty vec and returns.
 *
 * ## Why this is a splice and not a rewrite
 *
 * The two stores that can hold a symbol key on an array already have ordered,
 * filtered, spec-sequenced walkers — `__carrier_bag_push_keys` (#3537 bag) and
 * `__vec_overlay_push_keys` (#3251 overlay). Both walked STRING keys only. They
 * now take a key-kind mode (`KEY_MODE_SYMBOLS_ONLY`), so this arm is the same
 * two calls `fillGopnVecArm` makes, with the mode flipped and the index /
 * `length` prologue dropped — an array has no intrinsic symbol-keyed own
 * property, so there is nothing to seed and nothing to de-duplicate against.
 *
 * `includeNonEnum` is TRUE, and not by symmetry with gOPN: §20.1.2.10 returns
 * every own symbol key regardless of enumerability, so a non-enumerable
 * `defineProperty`'d symbol (the second row of the table above) must be listed.
 *
 * ## KNOWN GAP — the #4230 demand gate does not list `getOwnPropertySymbols`
 *
 * `vecOwnKeysEnumerationActive` reads `ctx.vecOwnKeysDirty`, a syntactic
 * pre-scan (`array-holes.ts`) that looks for `defineProperty` /
 * `defineProperties` / two-arg `create` / `getOwnPropertyNames` / `ownKeys` /
 * `getOwnPropertyDescriptors`. **`getOwnPropertySymbols` is not on that list**,
 * so a module whose ONLY own-key call is `gOPS` still emits none of this and
 * still answers `[]`. Measured, and pinned in the test file as a gap rather
 * than left to be rediscovered.
 *
 * Adding the name to the pre-scan is the fix and it is one line — but it WIDENS
 * the gate (more modules get the whole vec key-walk machinery), so it wants its
 * own neighbourhood sweep instead of a free ride on this slice's. Measured cost
 * of deferring it: **zero rows** in this slice's 1,732-row neighbourhood, where
 * every `built-ins/Object/getOwnPropertySymbols` row either already passed or
 * mentions `defineProperty`.
 *
 * ## Ordering
 *
 * Filled from `fillObjVecReflectionHelpers` AFTER `fillVecOverlayPushKeys`, for
 * the same reason `fillGopnVecArm` is: the overlay pusher is RESERVED early and
 * given its real body late, and this arm bakes the reserved index.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { buildBagPushKeys } from "./carrier-bag-visibility.js";
import { getOrRegisterVecBaseType } from "./registry/types.js";
import { buildOverlayPushKeys, vecOwnKeysEnumerationActive } from "./vec-overlay-keys.js";

/**
 * Prepend a `$__vec_base` arm to `__getOwnPropertySymbols`. Idempotent; a no-op
 * unless the #4230 demand gate is open, the native exists, and the module has a
 * `$Symbol` type at all (no symbols in the type space ⇒ no symbol key can
 * exist ⇒ the empty answer was already correct).
 */
export function fillGopsVecArm(ctx: CodegenContext): void {
  if (!vecOwnKeysEnumerationActive(ctx) || ctx.symbolTypeIdx < 0) return;
  const state = ctx as CodegenContext & { gopsVecArmFilled?: boolean };
  if (state.gopsVecArmFilled) return;
  const fn = ctx.mod.functions.find((f) => f.name === "__getOwnPropertySymbols");
  if (!fn) return;
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  if (objVecNewIdx === undefined) return;
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);

  // Anchor on the native's own result-vector init (`__objvec_new` →
  // `local.set 7`) rather than a positional index — the same anchor, and the
  // same reason, as `fillGopnVecArm`: other finalize fills may already have
  // prepended arms, and this one must sit AFTER `vec = __objvec_new()` so it
  // has a vector to push into.
  const initIdx = fn.body.findIndex((instr, index) => {
    const next = fn.body[index + 1];
    return instr.op === "call" && instr.funcIdx === objVecNewIdx && next?.op === "local.set" && next.index === 7;
  });
  if (initIdx < 0) return;

  const VEC = 7; // the native's own result vector
  const A = 1 + fn.locals.length; // anyref scratch
  fn.locals.push({ name: "__gopsarm_any", type: { kind: "anyref" } });

  const pushes: Instr[] = [
    ...buildBagPushKeys(ctx, { vecLocal: VEC, includeNonEnum: true, symbolsOnly: true }),
    ...buildOverlayPushKeys(ctx, { vecLocal: VEC, includeNonEnum: true, symbolsOnly: true }),
  ];
  // Both builders return [] when their native was never reserved. With neither
  // there is nothing to add, so leave the body alone rather than splicing an
  // arm that returns the same empty vec by a longer route.
  if (pushes.length === 0) return;

  fn.body.splice(
    initIdx + 2,
    0,
    {
      op: "local.get",
      index: 0,
    } satisfies Instr,
    ...([
      { op: "any.convert_extern" },
      { op: "local.tee", index: A },
      { op: "ref.test", typeIdx: vecBaseIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...pushes, { op: "local.get", index: VEC }, { op: "return" }],
      },
    ] satisfies Instr[]),
  );
  state.gopsVecArmFilled = true;
}
