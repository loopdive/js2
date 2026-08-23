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

/** The four runtime natives the walk is built from. */
export interface OrdinaryToPrimitiveProbeDeps {
  readonly typeofFunctionIdx: number;
  readonly typeofObjectIdx: number;
  readonly externGetIdx: number;
  readonly callMethod0Idx: number;
  readonly nullishToNullIdx: number | undefined;
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
}

export function buildOrdinaryToPrimitiveProbe(
  ctx: CodegenContext,
  deps: OrdinaryToPrimitiveProbeDeps,
  opts: OrdinaryToPrimitiveProbeOpts,
): Instr[] {
  const { typeofFunctionIdx, typeofObjectIdx, externGetIdx, callMethod0Idx, nullishToNullIdx } = deps;
  const { recv, methodLocal, resultLocal, order, onPrimitive } = opts;

  const probe = (name: "toString" | "valueOf"): Instr[] => {
    addStringConstantGlobal(ctx, name);
    return [
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
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: resultLocal },
                  { op: "call", funcIdx: typeofObjectIdx },
                  { op: "local.get", index: resultLocal },
                  { op: "call", funcIdx: typeofFunctionIdx },
                  { op: "i32.or" },
                  { op: "i32.eqz" },
                  { op: "if", blockType: { kind: "empty" }, then: onPrimitive() },
                ],
              },
            ],
          },
        ],
      },
    ];
  };

  return order.flatMap((name) => probe(name));
}
