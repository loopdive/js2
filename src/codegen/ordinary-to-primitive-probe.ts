// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4492 wave-5) The RUNTIME §7.1.1.1 OrdinaryToPrimitive walk, as a reusable
 * instruction builder.
 *
 * ## Why this exists as one builder
 *
 * The standalone backend resolves `valueOf`/`toString` at COMPILE time wherever
 * it can — per-struct dispatchers (`__call_valueOf`/`__call_toString`), the
 * `tryStructToString` closure/method walk, the `funcSourceText` fold. Every one
 * of those is keyed by a struct type or a binding name, so none of them can see
 * a method that arrives on the PROTOTYPE at runtime (`Function.prototype
 * .toString = …`, `F.prototype.toString = …`) or on an object the compiler
 * cannot name. `__extern_get` can: it walks own slots and the whole prototype
 * chain, including the #4176 brand companion that a `<Ctor>.prototype.<m> = …`
 * write lands on.
 *
 * #4491's `emitAddOrdinaryToPrimitiveResidue` (add-to-primitive.ts) proved the
 * shape works, and deliberately scoped it to the `+` operator. That scoping is
 * why the SAME function rendered four different ways in one module (measured
 * 2026-08-23, `.tmp/probes/t6.js`: `"" + f` → `OWN_F_TS` while `String(f)` and
 * `` `${f}` `` → `[object Object]`). Rather than copy the residue a third and
 * fourth time, the walk lives here and the callers differ only in what they do
 * with a primitive result.
 *
 * ## Contract
 *
 * `buildOrdinaryToPrimitiveProbe` emits, for each method name in `order`:
 *
 *   m = __extern_get(recv, "<name>")
 *   if (m is present && IsCallable(m)) {
 *     r = __call_accessor_get(recv, m)          // the arity-0 call bridge
 *     if (r is a PRIMITIVE) { <onPrimitive>; }  // caller returns from here
 *   }
 *
 * and falls out of the emitted region when nothing produced a primitive, so the
 * caller keeps its existing fall-through byte-for-byte.
 *
 * **`null` is not an accepted primitive.** In standalone `undefined` and `null`
 * are the same null externref (`__typeof_undefined` is a bare `ref.is_null`,
 * object-runtime.ts), so a method returning either is indistinguishable here —
 * and the module already contains BOTH renderings of that one value
 * (`tryStructToString`'s `normaliseToString` says `"undefined"`,
 * `__any_to_string`'s #4621-D raw-null arm says `"null"`). Choosing one would
 * make this walk disagree with the other for a value it cannot tell apart, so
 * it declines and lets the caller's existing path answer (absent-not-wrong).
 *
 * `onPrimitive` is a FACTORY, not an array: the walk emits it once per method
 * name, and aliasing one `Instr[]` into two tree positions double-shifts the
 * `funcIdx` fields inside it when a post-codegen pass walks the tree (the #1448
 * corruption class).
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

/** The runtime natives the walk is built from. */
export interface OrdinaryToPrimitiveProbeDeps {
  readonly typeofFunctionIdx: number;
  readonly typeofObjectIdx: number;
  readonly externGetIdx: number;
  readonly callMethod0Idx: number;
  readonly nullishToNullIdx: number | undefined;
  /** `__hasOwnProperty` — required by {@link OrdinaryToPrimitiveProbeOpts.ownOnly}. */
  readonly hasOwnIdx: number | undefined;
}

/**
 * Resolve the walk's dependencies, or `undefined` when any is unavailable — in
 * which case the caller must emit nothing and keep its previous lowering.
 *
 * The `__call_accessor_get` stub check is load-bearing, not defensive: the
 * driver is reserved with a bare `unreachable` body and only FILLED when the
 * module has a real arity-0 closure (accessor-driver.ts). Calling an unfilled
 * stub is an uncatchable Wasm trap — strictly worse than the "[object Object]"
 * or NaN the walk is trying to improve on. Callers must therefore run after
 * `fillAccessorDrivers`.
 */
export function resolveOrdinaryToPrimitiveProbeDeps(ctx: CodegenContext): OrdinaryToPrimitiveProbeDeps | undefined {
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const callMethod0Idx = ctx.funcMap.get("__call_accessor_get");
  if (
    typeofFunctionIdx === undefined ||
    typeofObjectIdx === undefined ||
    externGetIdx === undefined ||
    callMethod0Idx === undefined
  ) {
    return undefined;
  }
  const driver = definedFuncAt(ctx, callMethod0Idx);
  if (!driver || (driver.body.length === 1 && driver.body[0]?.op === "unreachable")) return undefined;
  return {
    typeofFunctionIdx,
    typeofObjectIdx,
    externGetIdx,
    callMethod0Idx,
    nullishToNullIdx: ctx.funcMap.get("__nullish_to_null"),
    hasOwnIdx: ctx.funcMap.get("__hasOwnProperty"),
  };
}

export interface OrdinaryToPrimitiveProbeOpts {
  /** Pushes the receiver as an `externref`. A FACTORY — emitted several times. */
  readonly recv: () => Instr[];
  /** externref scratch for the resolved method. */
  readonly methodLocal: number;
  /** externref scratch for the method's result; `onPrimitive` reads it. */
  readonly resultLocal: number;
  /** §7.1.1.1: `["toString","valueOf"]` for hint string, reversed otherwise. */
  readonly order: readonly ("toString" | "valueOf")[];
  /** Emitted with a PRIMITIVE in `resultLocal`; must not fall through. */
  readonly onPrimitive: () => Instr[];
  /**
   * NEST the later steps inside the first step's "present, but returned a
   * non-primitive" branch, instead of running them when the first step is merely
   * ABSENT.
   *
   * Required for the STRING hint, and not a nicety — measured as a regression:
   *
   * ```js
   * var o = { valueOf: function () { return "[object MyObj]"; } };  // no toString
   * String(o)                       // must be "[object Object]"
   * ```
   *
   * `test262 built-ins/String/S9.8_A5_T1` check #13. An absent OWN `toString` is
   * not an absent `toString`: `Get(O, "toString")` finds
   * `Object.prototype.toString`, which returns a primitive, so `valueOf` is
   * never reached. A flat two-step walk answered `"[object MyObj]"`.
   *
   * The NUMBER hint is the genuine mirror image and must NOT set this: an absent
   * `valueOf` resolves to `Object.prototype.valueOf`, which returns the OBJECT,
   * so the walk does continue to `toString` there.
   */
  readonly stopWhenFirstAbsent?: boolean;
  /**
   * Run a step only when the program actually INSTALLED that method on this
   * receiver — an own slot (`__hasOwnProperty`) or a `<Ctor>.prototype.<m> = …`
   * write recorded on the #4176 brand companion (`__protoidx_has_r`, which under
   * `protoNamedDirty` is seeded with nothing else, so its answer IS "the user
   * overrode this member" — see builtin-proto-member-override.ts).
   *
   * Measured, not defensive. On the externref path `__extern_get` resolves a
   * CALLABLE's inherited `toString` to `Object.prototype.toString` rather than
   * `Function.prototype.toString`, so an unrestricted chain walk answered
   * `"[object Function]"` for a plain function —
   * `test262 built-ins/Function/prototype/toString/Function.js`, which had been
   * passing on the §20.2.3.5 NativeFunction constant. That mis-resolution is a
   * defect in the receiver-aware prototype consult, upstream of this walk.
   *
   * A compile-time `ctx.protoNamedDirty` gate does NOT substitute: the flag is
   * set by the test262 harness prelude in nearly every module, so it admits the
   * ambient resolution exactly where it must not.
   */
  readonly userInstalledOnly?: boolean;
}

export function buildOrdinaryToPrimitiveProbe(
  ctx: CodegenContext,
  deps: OrdinaryToPrimitiveProbeDeps,
  opts: OrdinaryToPrimitiveProbeOpts,
): Instr[] {
  const { typeofFunctionIdx, typeofObjectIdx, externGetIdx, callMethod0Idx, nullishToNullIdx, hasOwnIdx } = deps;
  const { recv, methodLocal, resultLocal, order, onPrimitive, stopWhenFirstAbsent, userInstalledOnly } = opts;
  const gateInstalled = userInstalledOnly === true && hasOwnIdx !== undefined;

  // When the first step is ABSENT, `stopWhenFirstAbsent` means the inherited
  // intrinsic would have answered — so the later steps must NOT run as siblings;
  // they move inside the "present but non-primitive" branch of step i.
  const nested = stopWhenFirstAbsent === true;

  /** Steps `[i…]` of the walk. `rest` runs when step `i` yields a non-primitive. */
  const probe = (i: number): Instr[] => {
    if (i >= order.length) return [];
    const name = order[i]!;
    addStringConstantGlobal(ctx, name);
    const rest = probe(i + 1);
    const afterCall: Instr[] = [
      { op: "local.get", index: resultLocal },
      { op: "call", funcIdx: typeofObjectIdx },
      { op: "local.get", index: resultLocal },
      { op: "call", funcIdx: typeofFunctionIdx },
      { op: "i32.or" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: onPrimitive() },
      // Not a primitive → the next method (only in the nested regime; the flat
      // regime emits `rest` as a sibling after this whole block).
      ...(nested ? rest : []),
    ];
    const body: Instr[] = [
      ...recv(),
      ...stringConstantExternrefInstrs(ctx, name),
      { op: "call", funcIdx: externGetIdx },
      // (#2106 S1) An ABSENT member is the non-null `$undefined` singleton under
      // the singleton regime; normalize so `ref.is_null` means "absent" here.
      ...(nullishToNullIdx === undefined ? [] : ([{ op: "call", funcIdx: nullishToNullIdx }] satisfies Instr[])),
      { op: "local.tee", index: methodLocal },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // §7.1.1.1 step 2.b — a non-callable slot is skipped, not called.
          { op: "local.get", index: methodLocal },
          { op: "call", funcIdx: typeofFunctionIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...recv(),
              { op: "local.get", index: methodLocal },
              { op: "call", funcIdx: callMethod0Idx },
              { op: "local.set", index: resultLocal },
              { op: "local.get", index: resultLocal },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              { op: "if", blockType: { kind: "empty" }, then: afterCall },
            ],
          },
        ],
      },
    ];
    // The installed-by-the-program gate wraps STEP i only. In the flat
    // (number-hint) regime the later steps stay siblings, so a receiver with no
    // own `valueOf` still gets its `toString` step.
    const step: Instr[] = gateInstalled
      ? [
          ...recv(),
          ...stringConstantExternrefInstrs(ctx, name),
          { op: "call", funcIdx: hasOwnIdx },
          { op: "if", blockType: { kind: "empty" }, then: body },
        ]
      : body;
    return nested ? step : [...step, ...rest];
  };

  return probe(0);
}
