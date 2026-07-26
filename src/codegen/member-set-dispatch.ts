// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2664 — deferred-fill member-WRITE dispatcher `__set_member_<name>`.
 *
 * The symmetric struct.set write dispatch (#2659, `emitAlternateStructSetDispatch`)
 * resolves an `any`/`externref` receiver that is actually a typed WasmGC struct
 * and writes the field SLOT (mirroring the member-READ fast path), falling
 * through to `__extern_set_strict` (the JS-side sidecar) for genuine host
 * externrefs / accessors / dynamic-only props.
 *
 * The original implementation enumerated the struct candidates and emitted the
 * `ref.test`/`struct.set` chain INLINE at each write site. That froze the
 * candidate set at the write's compile time: a field-writing CLOSURE (e.g.
 * acorn's `finishToken`, a lifted closure reading `this` from `__current_this`)
 * compiled BEFORE a later-registered struct type for the same logical object
 * (acorn's Parser gets TWO struct shapes — an anonymous `$__anon_5` and the
 * constructor `$__fnctor_Parser`, registered later) only got the earlier
 * candidate's arm. The real instance is the later type, so its `ref.test` failed
 * → the write leaked to the sidecar while reads used the slot →
 * `while (this.type !== eof)` never terminated (the 8th acorn dogfood wall).
 *
 * Fix: reserve a per-property dispatcher `__set_member_<name>(recv, val)` at the
 * write site (where `name` is a static string) with a placeholder body, and FILL
 * it at FINALIZE — when the FULL struct-type table is known, so it enumerates
 * EVERY mutable struct candidate that owns the field, regardless of which
 * function compiled first. Mirrors the reserve-then-fill discipline of
 * `fillClosedMethodDispatch` (#2151) / `fillExternGetIdxVecArms` (#2190).
 *
 *   __set_member_<name>(recv: externref, val: externref)
 *     any = any.convert_extern(recv)
 *     if ref.test S1: ref.cast S1; <coerce val externref->fieldType>; struct.set S1 <slot>
 *     elif ref.test S2: …
 *     else: __extern_set_strict(recv, "<name>", val)   ;; sidecar / accessor throw
 *
 * Applies to BOTH gc/host and standalone — the dual-struct-type compile-order
 * hazard is mode-independent (acorn dogfoods in gc/host mode).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { findAlternateStructsForField } from "./property-access.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { buildVecFromExternMaterializer, coercionInstrs, getVecInfo } from "./type-coercion.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2/S3) positional-read chokepoint + stable-regime minting

/**
 * Mangle a property name + fallback strictness into the reserved dispatcher name.
 * STRICT (`__extern_set_strict`, throws on a getter-only accessor per the spec
 * [[Set]]) is used by plain `obj.x = v` writes (#2017); NON-strict
 * (`__extern_set`) by read-modify-write `obj.x += v` / `obj.x++` writes, where
 * the property was already read so the sidecar update never hits an accessor
 * throw. The two need DISTINCT dispatchers (different terminal else-arm), so the
 * variant is part of the key — mirrors `__call_m_<name>_<arity>` vs `_vararg`.
 */
function dispatcherName(propName: string, strict: boolean): string {
  return strict ? `__set_member_${propName}` : `__set_member_nonstrict_${propName}`;
}

/**
 * Reserve (or fetch) the member-set dispatcher `__set_member_<name>(recv, val)`
 * funcIdx with a placeholder body. The real body is built by
 * {@link fillMemberSetDispatch} at finalize. Idempotent; records the property
 * name in `ctx.memberSetDispatchNames`. Returns the reserved funcIdx.
 *
 * ALL of the fill body's dependencies are registered NOW (at reserve time) so
 * the fill only READS funcMap — registering imports/globals at FINALIZE would
 * shift baked call/global indices (the addUnionImports hazard the reserve-then-
 * fill pattern exists to avoid):
 *   - `__extern_set_strict` (the terminal sidecar/accessor-throw fallback),
 *   - the property-name string constant (the fallback's key),
 *   - `__box_number`/`__unbox_number` (union imports — the per-struct arms may
 *     unbox the externref value into an f64/i32 field via `coercionInstrs`).
 */
export function reserveMemberSetDispatch(
  ctx: CodegenContext,
  propName: string,
  strict: boolean,
  fctx?: FunctionContext,
): number | undefined {
  const name = dispatcherName(propName, strict);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  // Terminal else-arm dependency: the sidecar/host write. STRICT throws on a
  // getter-only accessor (#2017 spec [[Set]]); NON-strict is the plain
  // read-modify-write sidecar update. Match the inline fallback each call site
  // used to build.
  const fallbackName = strict ? "__extern_set_strict" : "__extern_set";
  const setIdx = ensureLateImport(
    ctx,
    fallbackName,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  if (setIdx === undefined) return undefined;
  // The fallback's string key + the union box/unbox helpers the arm coercions need.
  addStringConstantGlobal(ctx, propName);
  addUnionImportsViaRegistry(ctx);

  // (#2681) Settle the import shifts staged above BEFORE reserving this
  // dispatcher's funcIdx — symmetric with `reserveMemberGetDispatch`. Setting
  // `funcMap[name]` and letting a LATER caller flush re-shifted this just-set
  // entry by `added` (over-shift), so `fillMemberSetDispatch` wrote the dispatcher
  // body into the wrong function. Flushing FIRST (when the caller passes `fctx`)
  // makes the funcIdx final and unshiftable.
  if (fctx) flushLateImportShifts(ctx, fctx);

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [], "$member_set_dispatch_type");
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    // Placeholder; filled by fillMemberSetDispatch. `unreachable` keeps the stub
    // valid (no results) if the fill is ever skipped (it never is — the fill
    // iterates the same name set this reserve populates).
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  (ctx.memberSetDispatchNames ??= new Set<string>()).add(`${propName}\0${strict ? "S" : "N"}`);
  return funcIdx;
}

/**
 * Fill every reserved `__set_member_<name>` dispatcher body at FINALIZE, after
 * every struct type (incl. late-registered fnctor structs) is known. READ-ONLY
 * over funcMap (all deps registered at reserve time), so no funcIdx churn. Sets
 * the placeholder body to the full `ref.test`/`struct.set` chain. No-op when no
 * write site reserved a dispatcher.
 *
 * Body local layout: param 0 = recv (externref), param 1 = val (externref),
 * local 2 = `__any` (anyref, the converted receiver tested against each struct).
 */
export function fillMemberSetDispatch(ctx: CodegenContext): void {
  const mod = ctx.mod;

  for (const key of ctx.memberSetDispatchNames ?? []) {
    // key is `<propName>\0<S|N>` — strict (S) vs non-strict (N) fallback variant.
    const sep = key.lastIndexOf("\0");
    const propName = sep >= 0 ? key.slice(0, sep) : key;
    const strict = sep >= 0 ? key.slice(sep + 1) === "S" : true;
    const dispIdx = ctx.funcMap.get(dispatcherName(propName, strict));
    if (dispIdx === undefined) continue;
    const dispFn = definedFuncAt(ctx, dispIdx);
    if (!dispFn) continue;

    // Enumerate the COMPLETE candidate set now (full type table). Only mutable
    // fields can take a `struct.set` (an immutable field is a hard validator
    // error — the #2657 boxed-primitive-wrapper case); immutable-field structs
    // fall through to the sidecar, which is correct for `(new String("x")).value`.
    const candidates = findAlternateStructsForField(ctx, propName, -1).filter((c) => c.mutable);

    // Terminal else-arm: the host write (strict throws on a getter-only accessor;
    // non-strict is the plain sidecar update). Covers genuine host externrefs,
    // accessors (no struct candidate matches → strict-throw preserved), and
    // dynamic sidecar-only props.
    const fallbackIdx = ctx.funcMap.get(strict ? "__extern_set_strict" : "__extern_set");
    const fallback: Instr[] =
      fallbackIdx !== undefined
        ? [
            { op: "local.get", index: 0 }, // recv
            ...stringConstantExternrefInstrs(ctx, propName),
            { op: "local.get", index: 1 }, // val
            { op: "call", funcIdx: fallbackIdx },
          ]
        : [];

    const buildSetDispatch = (idx: number): Instr[] => {
      if (idx >= candidates.length) return fallback;
      const cand = candidates[idx]!;
      // Coerce the boxed externref value into the candidate field's wasm type via
      // the SINGLE coercion engine (#1917 / #2108 — never hand-roll a fresh
      // box/unbox matrix). For an externref field (the common acorn `type`/`value`
      // case) this is a no-op; scalar fields unbox via the union helpers, which
      // are registered at reserve time so the engine's idempotent addUnionImports
      // is a no-op at fill (no funcIdx churn). No fctx is needed: externref→scalar
      // and externref→ref coercions resolve through funcMap, not temp locals.
      const coerce = coercionInstrs(ctx, { kind: "externref" }, cand.fieldType);
      const setFieldInstrs: Instr[] = [
        { op: "local.get", index: 2 }, // __any
        { op: "ref.cast", typeIdx: cand.structTypeIdx },
        { op: "local.get", index: 1 }, // val (externref)
        ...coerce,
        { op: "struct.set", typeIdx: cand.structTypeIdx, fieldIdx: cand.fieldIdx },
      ];
      if (cand.presenceFieldIdx !== undefined && cand.presenceFieldIdx >= 0) {
        setFieldInstrs.push(
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: cand.structTypeIdx },
          { op: "i32.const", value: 1 },
          { op: "struct.set", typeIdx: cand.structTypeIdx, fieldIdx: cand.presenceFieldIdx },
        );
      }
      return [
        { op: "local.get", index: 2 }, // __any
        { op: "ref.test", typeIdx: cand.structTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: setFieldInstrs,
          else: buildSetDispatch(idx + 1),
        },
      ];
    };

    dispFn.locals = [{ name: "__any", type: { kind: "anyref" } }];
    dispFn.body = [
      { op: "local.get", index: 0 }, // recv (externref)
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 }, // __any
      ...buildSetDispatch(0),
    ];
  }
}

/**
 * (#2831) FINALIZE sub-pass — reserve ONE host-externref → wasm-vec materializer
 * `__vec_from_extern_<vecTypeIdx>` per DISTINCT vec-typed struct field that a
 * dynamic write can target, BEFORE the value-coercion fills bake.
 *
 * Why a separate up-front pass: the materializer body (`buildVecFromExternref`)
 * `ensureLateImport`s its helpers and `flushLateImportShifts` — registering an
 * import after the index-space freeze, or mid-`fill*`, shifts already-baked func
 * indices (the addUnionImports hazard the reserve-then-fill pattern exists to
 * avoid). Reserving here — where shifts are still legal and this pass OWNS them —
 * lets `coercionInstrs` (member-set-dispatch + inline) and `buildSetterStore`
 * (`__sset_*`) merely `call` the materializer (read-only over funcMap), with NO
 * funcIdx churn at fill. Must run BEFORE `emitStructFieldSetters`,
 * `fillMemberSetDispatch`, and `fillMemberGetDispatch`.
 *
 * Scope: every MUTABLE vec-typed field reachable from
 *   (a) the member-set dispatcher candidates (`findAlternateStructsForField`),
 *       i.e. the dynamic `any`-receiver write path (the acorn `this.x = []` trap);
 *   (b) the `__sset_<field>` exported host setters (the same mutable struct
 *       fields the `_safeSet` MOP-write path narrows).
 * No-op when no vec-typed write target exists ⇒ byte-identical.
 */
export function reserveVecFieldMaterializers(ctx: CodegenContext): void {
  const targetVecIdxs = new Set<number>();
  const consider = (ft: ValType | undefined): void => {
    if (!ft || (ft.kind !== "ref" && ft.kind !== "ref_null")) return;
    const idx = (ft as { typeIdx: number }).typeIdx;
    if (getVecInfo(ctx, idx)) targetVecIdxs.add(idx);
  };

  // (a) member-set dispatcher candidates — the dynamic any-receiver write path.
  for (const key of ctx.memberSetDispatchNames ?? []) {
    const sep = key.lastIndexOf("\0");
    const propName = sep >= 0 ? key.slice(0, sep) : key;
    for (const cand of findAlternateStructsForField(ctx, propName, -1)) {
      if (cand.mutable) consider(cand.fieldType);
    }
  }

  // (b) `__sset_<field>` exported host setters — mirror the field-enumeration
  // skip rules of `_emitStructFieldSettersInner` (mutable, non-`$`, non-carrier).
  for (const [structName, fields] of ctx.structFields) {
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    ) {
      continue;
    }
    for (const field of fields) {
      if (!field || !field.type || !field.name || field.name.startsWith("$") || !field.mutable) continue;
      consider(field.type);
    }
  }

  for (const vecIdx of targetVecIdxs) {
    buildVecFromExternMaterializer(ctx, vecIdx);
  }
}
