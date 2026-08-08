// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4220) `<array>.constructor` for a standalone array whose receiver is only
 * known at RUNTIME.
 *
 * ## The gap
 *
 * Every static spelling of `.constructor` on an array already resolves: #3133
 * routes an ARRAY-typed receiver to the `__builtin_Array` namespace-object
 * singleton, so `[1,2].constructor === Array` is genuinely true by `ref.eq`.
 * But that arm is **static-type driven** (`property-access-dispatch.ts`,
 * `classifyPlainCtorReceiverNamespace`). When the receiver's TS type is `any` —
 * a parameter, or the `externref` result of a reflective builtin closure — the
 * read falls through to the dynamic `__extern_get(obj, "constructor")` native,
 * whose `$__vec_base` arm (#3183) answers only `"length"` and numeric index
 * keys. Everything else misses, so a dynamically-typed array reads
 * `.constructor === undefined`.
 *
 * That is what blocks the ES5 `String.prototype.split` battery: those tests
 * transfer the method onto a non-string receiver and then assert
 * `__split.constructor === Array` on the (necessarily `any`-typed) result.
 *
 * ## The carrier
 *
 * The runtime arm must hand back the SAME object the bare `Array` identifier
 * reads, or the identity comparison is a null≡null tautology. That object is
 * the `__builtin_Array` global, and it is **lazily** materialized at each read
 * site (`emitBuiltinNamespaceObject`) — a bare `global.get` from inside
 * `__extern_get` would therefore read `null` whenever the array's
 * `.constructor` is evaluated BEFORE the module's first `Array` mention, which
 * is exactly the argument order of `assert.sameValue(a.constructor, Array)`.
 *
 * So this module mints a zero-argument accessor, `__vec_ctor_Array()`, holding
 * that same guarded lazy-init + `global.get`. The finalize-time `__extern_get`
 * vec arm calls it, which materializes the singleton on first demand from
 * either direction.
 *
 * ## Why it is demand-minted, not unconditional
 *
 * Minting the carrier drags the `Array` namespace object (and its static-method
 * closures) into the module. #4034 is the standing reminder of how expensive an
 * unconditional pull-in on the array path is — it cost ~21 kB of unstrippable
 * exports in every arith-only module. So the accessor is minted only where a
 * consumer asks for it, and `fillDynamicForinVecArms` installs the
 * `"constructor"` arm only when the accessor exists. A module that never
 * demands it emits byte-identical output.
 *
 * Minting must happen DURING ordinary codegen (it can register late imports),
 * never from finalize — callers do it alongside their other late-import-adding
 * setup and flush before reading any funcIdx by name.
 */

import type { Instr, ValType } from "../ir/types.js";
import { emitBuiltinNamespaceObject } from "./builtin-static-globals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** Name of the minted accessor, and the key the finalize arm looks it up by. */
export const VEC_CONSTRUCTOR_CARRIER_FN = "__vec_ctor_Array";

/**
 * Mint (idempotently) `__vec_ctor_Array() -> externref` — the runtime accessor
 * for the `Array` namespace-object singleton. Returns its funcIdx, or
 * `undefined` outside standalone / when the carrier is unavailable.
 *
 * Call from ordinary codegen only, and treat it as a late-import adder: run it
 * before any funcIdx is captured by name and flush afterwards.
 */
export function ensureVecConstructorCarrier(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get(VEC_CONSTRUCTOR_CARRIER_FN);
  if (existing !== undefined) return existing;

  const resultType: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [], [resultType]);
  const fctx: FunctionContext = {
    name: VEC_CONSTRUCTOR_CARRIER_FN,
    params: [],
    locals: [],
    localMap: new Map(),
    returnType: resultType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  // Emit BEFORE minting: `emitBuiltinNamespaceObject` mints the static-method
  // closures itself, and nested mints must get their ordinals first (the same
  // order `ensureStandaloneNativeMethodClosure` uses).
  if (emitBuiltinNamespaceObject(ctx, fctx, "Array") === null) return undefined;

  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: VEC_CONSTRUCTOR_CARRIER_FN,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  ctx.funcMap.set(VEC_CONSTRUCTOR_CARRIER_FN, funcIdx);
  return funcIdx;
}

/**
 * The `"constructor"` arm of `__extern_get`'s `$__vec_base` block (installed by
 * `fillDynamicForinVecArms`, object-runtime.ts).
 *
 * `keyEqualsConstructor` is the caller's `key == "constructor"` test (it owns
 * the param/local numbering); this returns the guarded delegation to the
 * accessor above. It answers `[]` — no arm at all — when either the accessor
 * was never demanded or the key test is unavailable, so a module that never
 * asked for the carrier emits byte-identical output and keeps today's
 * `undefined` miss.
 *
 * The accessor call, not a bare `global.get`, is what makes the read work when
 * it is the module's FIRST demand for `Array`: the singleton's lazy init rides
 * inside it. That case is not exotic — it is the argument order of
 * `assert.sameValue(a.constructor, Array)`.
 *
 * `constructor` is an ordinary writable INHERITED property, so an own write
 * (`a.constructor = 5`) must shadow it (§7.3.2). Unlike the sibling `"length"`
 * arm — whose key can never be an own expando — this one therefore consults the
 * #3537 expando side table first and declines to answer when the array carries
 * its own entry, letting the main body's `__vec_prop_get` miss arm return it.
 * Without the bag helper the guard degrades to the unconditional answer, which
 * is still strictly better than the `undefined` this replaces.
 */
export function vecConstructorArmInstrs(ctx: CodegenContext, keyEqualsConstructor: Instr[] | null): Instr[] {
  const carrierIdx = ctx.funcMap.get(VEC_CONSTRUCTOR_CARRIER_FN);
  if (carrierIdx === undefined || !keyEqualsConstructor) return [];
  const bagHasIdx = ctx.funcMap.get("__carrier_bag_has");
  const answer: Instr[] = [{ op: "call", funcIdx: carrierIdx }, { op: "return" }];
  return [
    ...keyEqualsConstructor,
    {
      op: "if",
      blockType: { kind: "empty" },
      then:
        bagHasIdx === undefined
          ? answer
          : [
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: bagHasIdx },
              { op: "i32.eqz" }, // no own `constructor` → the inherited carrier wins
              { op: "if", blockType: { kind: "empty" }, then: answer },
            ],
    },
  ];
}
