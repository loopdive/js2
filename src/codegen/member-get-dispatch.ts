// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2674 — deferred-fill member-READ dispatcher `__get_member_<name>`.
 *
 * The SYMMETRIC read-side counterpart of #2664's `__set_member_<name>`. The
 * member-READ multi-struct dispatch (`findAlternateStructsForField` +
 * `ref.test`/`struct.get` chain in property-access.ts) was enumerated INLINE at
 * each read site, freezing its struct-candidate set at the read's compile time.
 * A field reader (a lifted parser-method closure reading `this` via
 * `__current_this`) compiled BEFORE a later-registered struct type for the same
 * logical object (acorn's Parser gets two shapes — `$__anon_5` then
 * `$__fnctor_Parser`, registered later) only got the earlier candidate's
 * `ref.test` arm. The real instance is the later type, so its `ref.test` fails
 * and the read falls through to `__extern_get` → `undefined` while WRITES (via
 * the #2664 deferred-fill dispatcher) hit the slot — read/write diverge and the
 * expression-parse loops never terminate (the acorn 9th dogfood wall).
 *
 * Fix (mirrors #2664 exactly): a per-property dispatcher
 * `__get_member_<name>(recv: externref) -> externref` reserved at the read site
 * (where `name` is a static string) with a placeholder body, and FILLED at
 * FINALIZE — when the FULL struct-type table is known — so it enumerates EVERY
 * struct candidate that owns the field, regardless of which function compiled
 * first. Reserve-then-fill discipline matches `fillClosedMethodDispatch` (#2151)
 * / `fillMemberSetDispatch` (#2664): all fill-body deps registered at reserve
 * time so the fill only READS funcMap (no funcIdx churn); the placeholder body is
 * replaced once at finalize (no rebuild of a funcIdx-baked body).
 *
 *   __get_member_<name>(recv: externref) -> externref
 *     any = any.convert_extern(recv)
 *     if ref.test S1: ref.cast S1; struct.get S1 <slot>; <box fieldType->externref>
 *     elif ref.test S2: …
 *     else: __extern_get(recv, "<name>")   ;; genuine host externrefs / sidecar
 *
 * The dispatcher returns a UNIFORM externref; the read SITE coerces it to the
 * type it needs (matching how #2664's write dispatcher took a uniform externref
 * value). Used as the ALTERNATES fallback — each read site keeps its own primary
 * fast-path (and any Phase-3 primitive narrowing); only the frozen multi-struct
 * alternates chain is replaced by this complete, finalize-filled dispatcher.
 *
 * Applies to BOTH gc/host and standalone (the dual-struct-type compile-order
 * hazard is mode-independent — acorn dogfoods in gc/host mode).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { findAlternateStructsForField } from "./property-access.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { coercionInstrs } from "./type-coercion.js";
import { definedFuncAt } from "./func-space.js"; // (#1916 S2) positional-read chokepoint

/** Mangle a property name into the reserved member-get dispatcher name. */
function dispatcherName(propName: string): string {
  return `__get_member_${propName}`;
}

/**
 * Reserve (or fetch) the member-get dispatcher `__get_member_<name>(recv) ->
 * externref` funcIdx with a placeholder body. The real body is built by
 * {@link fillMemberGetDispatch} at finalize. Idempotent; records the property
 * name in `ctx.memberGetDispatchNames`. Returns the reserved funcIdx, or
 * `undefined` if the `__extern_get` fallback import can't be registered.
 *
 * ALL fill-body deps are registered NOW (reserve time) so the fill only READS
 * funcMap (no funcIdx churn at finalize):
 *   - `__extern_get` (the terminal host-read fallback),
 *   - the property-name string constant (the fallback's key),
 *   - `__box_number` (union import — a per-struct arm box-coerces an f64/i32
 *     field result up to externref via `coercionInstrs`).
 *
 * (#2674-residual / #2043 late-import index-shift hardening) The
 * `ensureLateImport`/`addUnionImportsViaRegistry` calls below register imports
 * that shift the function index space. The READ call sites bake the returned
 * `funcIdx` into a DETACHED instruction array (the `buildFallback` terminal) AND
 * immediately follow it with a `coercionInstrs(…, fctx)` that may itself allocate
 * locals and register more late imports — both of which assume a SETTLED index
 * space. Unlike the WRITE side (which pushes straight into `fctx.body`, so the
 * body-level batched flush reaches it), a detached array left across a dangling
 * `pendingLateImportShift` is fragile: when another import-adding pass runs before
 * the body's deferred flush (the failure mode that surfaced only when #2075 was
 * batched with another import-adding PR in the merge_group — `local index out of
 * range at __module_init`, the #2043 class), the staged indices desync. So when a
 * caller passes its `fctx`, FLUSH the pending shift here (ensure→flush discipline,
 * matching `buildVecFromExternref`/`emitUndefined`) so the dispatcher's imports
 * settle before the caller emits anything further. No-op when there is no pending
 * shift or the helpers were already registered (idempotent reserve).
 */
export function reserveMemberGetDispatch(
  ctx: CodegenContext,
  propName: string,
  fctx?: FunctionContext,
): number | undefined {
  const name = dispatcherName(propName);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (getIdx === undefined) return undefined;
  addStringConstantGlobal(ctx, propName);
  addUnionImportsViaRegistry(ctx);

  // (#2681) Settle the index-space shift the imports above staged BEFORE reserving
  // this dispatcher's funcIdx. Previously the flush ran AFTER `funcMap.set(name,
  // funcIdx)`, so `flushLateImportShifts` re-shifted the JUST-SET entry by `added`
  // (an OVER-shift): `funcMap[name]` then pointed `added` slots PAST the real
  // dispatcher, so `fillMemberGetDispatch` wrote the dispatcher body into the
  // WRONG function (e.g. `__module_init` — a 0-param fn → `local.tee 1` out of
  // range) and every baked `call funcIdx` targeted it. Flushing FIRST settles
  // `numImportFuncs`, so the funcIdx computed below is final and the entry is
  // never shifted again. (The earlier shift already reached the caller's `fctx`
  // body + every PRE-EXISTING funcMap entry; nothing the dispatcher bakes runs
  // before this point.) All callers pass `fctx`.
  if (fctx) flushLateImportShifts(ctx, fctx);

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$member_get_dispatch_type");
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  (ctx.memberGetDispatchNames ??= new Set<string>()).add(propName);
  return funcIdx;
}

/**
 * Fill every reserved `__get_member_<name>` dispatcher body at FINALIZE, after
 * every struct type (incl. late-registered fnctor structs) is known. READ-ONLY
 * over funcMap. No-op when no read site reserved a dispatcher.
 *
 * Body local layout: param 0 = recv (externref), local 1 = `__any` (anyref, the
 * converted receiver tested against each struct candidate).
 */
export function fillMemberGetDispatch(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const getIdx = ctx.funcMap.get("__extern_get");

  for (const propName of ctx.memberGetDispatchNames ?? []) {
    const dispIdx = ctx.funcMap.get(dispatcherName(propName));
    if (dispIdx === undefined) continue;
    const dispFn = definedFuncAt(ctx, dispIdx);
    if (!dispFn) continue;

    // Complete candidate set (full type table). Unlike the WRITE side, a READ
    // does not need the mutable filter — reading an immutable field is fine.
    const candidates = findAlternateStructsForField(ctx, propName, -1);

    // Terminal else-arm: __extern_get(recv, "<name>") -> externref. Covers
    // genuine host externrefs and dynamic sidecar-only props.
    const fallback: Instr[] =
      getIdx !== undefined
        ? [
            { op: "local.get", index: 0 } as Instr, // recv
            ...stringConstantExternrefInstrs(ctx, propName),
            { op: "call", funcIdx: getIdx } as Instr,
          ]
        : [{ op: "ref.null.extern" } as Instr];

    const buildGetDispatch = (idx: number): Instr[] => {
      if (idx >= candidates.length) return fallback;
      const cand = candidates[idx]!;
      // Read the slot, then box-coerce the field's wasm type UP to externref (the
      // dispatcher's uniform result). Via the single coercion engine (#1917 /
      // #2108) — box helpers were registered at reserve so this is funcMap-read
      // only. externref field → no-op; f64/i32 → __box_number; ref → extern.convert_any.
      const box = coercionInstrs(ctx, cand.fieldType, { kind: "externref" });
      const readInstrs: Instr[] = [
        { op: "local.get", index: 1 } as Instr, // __any
        { op: "ref.cast", typeIdx: cand.structTypeIdx } as Instr,
        { op: "struct.get", typeIdx: cand.structTypeIdx, fieldIdx: cand.fieldIdx } as Instr,
        ...box,
      ];
      return [
        { op: "local.get", index: 1 } as Instr, // __any
        { op: "ref.test", typeIdx: cand.structTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: readInstrs,
          else: buildGetDispatch(idx + 1),
        } as Instr,
      ];
    };

    dispFn.locals = [{ name: "__any", type: { kind: "anyref" } }];
    dispFn.body = [
      { op: "local.get", index: 0 } as Instr, // recv (externref)
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 1 } as Instr, // __any
      ...buildGetDispatch(0),
    ];
  }
}
