// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 E7) A STATIC `$__ta_view` that reaches a generic (externref) slot.
 *
 * `new Int8Array(buffer)` over a statically-known ArrayBuffer lowers to the
 * shared-backing `$__ta_view_<Name>` struct (#3054 B1) — `{length, buf,
 * byteOffset, kind}` — and every STATIC access on the binding decodes through
 * the typed view lowering. Once the value crosses into an `any`/externref
 * slot (a closure result, a harness argument, `assert.sameValue`), only the
 * standalone dynamic-object natives see it, and those have §10.4.5 arms for
 * the DYNAMIC carrier `$__ta_dyn_view` alone (`ta-dyn-mop.ts`). The static
 * view fell through to the generic `$__vec_base` handling instead:
 *
 *  - `__extern_length` answered the STORED field 0 — no detach check (a
 *    detached buffer still read its construction length), and the `-1`
 *    auto-length sentinel of a length-tracking view read as `-1`;
 *  - `__extern_get_idx` / `__extern_get` answered `undefined` for every
 *    element, BEFORE any detach (a `$__ta_view` is no carrier those arms know);
 *  - element writes through `__extern_set` were dropped.
 *
 * The two carriers share their first four fields field-for-field — the dyn
 * view only APPENDS `expando` and `constructProto` (registry/types.ts) — and
 * the `kind` field of both indexes `TA_CTOR_KINDS` (`taCtorKindOf`). So a
 * static view is re-expressed as a dyn view over the SAME backing buffer, same
 * `byteOffset`, same stored length (sentinel included) and same kind, and the
 * native re-enters itself with it: every existing dyn-view arm — element
 * codec, IsValidIntegerIndex (detach included), the named accessors, the
 * canonical-numeric-key rules — then answers for the static view too. Writes
 * land in the shared bytes, so they are visible through the static binding.
 *
 * What the re-expression does NOT carry is identity-bearing state: an EXPANDO
 * property written through the generic path lands on the transient dyn view
 * and is not retained. That is no regression — the generic path dropped it
 * before too — and identity itself is unaffected: the value in the externref
 * slot is still the original `$__ta_view` (only the native's own recursion
 * sees the transient), so `result === target` holds.
 *
 * Byte discipline: a no-op unless the module is standalone AND registered both
 * a static view type and the dyn-view type, i.e. a module with no TypedArray
 * view — or with only one of the two carriers — compiles byte-identically.
 * Runs AFTER `fillTaDynViewMopArms` / `fillTaDynViewOwnKeyArms` and prepends,
 * so this arm sits in front of theirs; the receivers are disjoint (`$__ta_view`
 * is `final` and not a supertype of `$__ta_dyn_view`), so the order only
 * matters against the generic `$__vec_base` arms the static view subtypes.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { inferNativeTaViewConstructType } from "./dataview-native.js";
import { definedFuncAt, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { noJsHost } from "./js-errors.js";
import { addFuncType, isTaViewTypeIdx } from "./registry/types.js";

/** The dynamic-object natives whose dyn-view arm the static view re-enters. */
const STATIC_VIEW_MOP_NATIVES: readonly string[] = [
  "__extern_length",
  "__extern_get_idx",
  "__extern_has_idx",
  "__extern_get",
  "__extern_has",
  "__extern_set",
  "__getPrototypeOf",
];

/**
 * `__ta_view_as_dyn(externref) -> externref`: the caller has already
 * `ref.test`ed the argument as a `$__ta_view`. Builds the `$__ta_dyn_view`
 * over the same backing store (see the module doc).
 */
function ensureTaViewAsDynHelper(ctx: CodegenContext, taViewIdx: number, dynIdx: number): number {
  const name = "__ta_view_as_dyn";
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const extern: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [extern], [extern]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  const view: ValType = { kind: "ref", typeIdx: taViewIdx };
  const field = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: taViewIdx, fieldIdx },
  ];
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [{ name: "view", type: view }],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: taViewIdx },
      { op: "local.set", index: 1 },
      ...field(0), // length (stored; −1 = length-tracking)
      ...field(1), // buf — the SAME backing byte-vec
      ...field(2), // byteOffset
      ...field(3), // kind (TA_CTOR_KINDS index)
      { op: "ref.null.extern" }, // expando
      { op: "ref.null.extern" }, // constructProto (intrinsic)
      { op: "struct.new", typeIdx: dynIdx },
      { op: "extern.convert_any" },
    ],
    exported: false,
  });
  return funcIdx;
}

/**
 * Is `expr` a bare identifier whose binding holds a STATIC `$__ta_view` — a
 * variable initialized with `new <View>(<ArrayBuffer>)` on the host-free lane?
 *
 * A closure whose body `return`s such a binding must not take the checker's
 * return type: `resolveWasmType(Int8Array)` is the packed-vec carrier, and the
 * guarded return cast of a `$__ta_view` to it answers NULL. `function () {
 * return target; }` handed to `%TypedArray%.from.call` as its `this` was the
 * measured case (`from-{array,typedarray}-mapper-detaches-result.js`: the
 * construct driver saw null, not `target`). The caller keeps such a closure's
 * result on the externref carrier, which holds the view itself.
 */
export function isStaticTaViewBinding(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!noJsHost(ctx) || !ts.isIdentifier(expr)) return false;
  const decl = ctx.oracle.variableDeclarationOf(expr);
  if (decl?.initializer === undefined) return false;
  const carrier = inferNativeTaViewConstructType(ctx, decl.initializer);
  return carrier !== null && carrier.kind === "ref_null" && isTaViewTypeIdx(ctx, carrier.typeIdx);
}

export function fillTaStaticViewMopArms(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const dynIdx = ctx.taDynViewTypeIdx;
  if (dynIdx < 0) return;
  // WasmGC canonicalizes the per-name `$__ta_view_<Name>` structs (identical
  // definitions), so one `ref.test` / `ref.cast` answers for every kind.
  const taViewIdx = ctx.taViewTypeMap.values().next().value;
  if (taViewIdx === undefined) return;

  const targets: { fnIdx: number; arity: number }[] = [];
  for (const name of STATIC_VIEW_MOP_NATIVES) {
    const fnIdx = ctx.funcMap.get(name);
    if (fnIdx === undefined || !definedFuncAt(ctx, fnIdx)) continue;
    const sig = funcSignatureOf(ctx, fnIdx);
    if (!sig || sig.params.length < 1 || sig.params[0]!.kind !== "externref") continue;
    targets.push({ fnIdx, arity: sig.params.length });
  }
  if (targets.length === 0) return;
  const asDynIdx = ensureTaViewAsDynHelper(ctx, taViewIdx, dynIdx);

  for (const { fnIdx, arity } of targets) {
    const fn = definedFuncAt(ctx, fnIdx)!;
    const reenter: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: asDynIdx },
    ];
    for (let p = 1; p < arity; p++) reenter.push({ op: "local.get", index: p });
    reenter.push({ op: "call", funcIdx: fnIdx }, { op: "return" });
    fn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: taViewIdx },
      { op: "if", blockType: { kind: "empty" }, then: reenter },
    );
  }
}
