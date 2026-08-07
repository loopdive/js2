// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4203) ES5 §10.4.3 — telling an EXPLICITLY-null receiver apart from an
 * ABSENT one.
 *
 * `__current_this` is a `(mut externref)` whose initial (and restored-to) value
 * is `ref.null.extern`. That single value spells BOTH "no receiver was
 * installed" (a bare `f()`) and "the caller passed `null`" (`f.call(null)` /
 * `f.apply(null)` / `f.bind(null)()`). §10.4.3 gives the two different answers
 * inside a **strict** callee — `undefined` for the first, `null` for the second
 * — so with one spelling the strict rows cannot pass. (`10.4.3-1-{67,72,77}`
 * and their `gs` twins.)
 *
 * ── Why a MARKER rather than re-spelling "absent" ────────────────────────
 *
 * The obvious inversion is to respell ABSENT as the #2106 `$undefined`
 * singleton and leave `ref.null.extern` to mean explicit-null. That reads
 * cheaper than it is: `ref.null.extern` is the global's *initial value*, so
 * every reader in the tree that treats `ref.is_null` as "nothing installed"
 * silently flips meaning at once, and there is no incremental way to land it.
 *
 * This module goes the other way. "Absent" keeps its spelling exactly, and the
 * explicitly-null receiver gets a distinct NON-null marker. Every existing
 * reader therefore keeps its current answer, and the change is additive.
 *
 * ── Why the marker is a second tag-1 `$AnyValue` ─────────────────────────
 *
 * The marker is a fresh instance of the same immutable `{tag:1, …}` `$AnyValue`
 * shape as the `$undefined` singleton, distinguished from it only by REFERENCE
 * IDENTITY (`ref.eq`). That choice is about the failure mode, not economy:
 *
 *   - a reader that has been taught about it answers `null` (strict) /
 *     the global object (sloppy);
 *   - a reader that has NOT been taught about it inspects the tag, sees 1, and
 *     answers `undefined` — which is *exactly today's answer*.
 *
 * A dedicated struct type would have failed every existing `ref.test` and
 * surfaced as an opaque object instead. Degrading to the status quo is worth
 * more than the one extra `ref.test` the identity check costs, because the
 * marker's reach is not statically bounded: a callee entered through the
 * receiver-install trampoline can call further functions that read
 * `__current_this` without installing anything of their own. (Those nested
 * reads are already wrong for a non-null receiver today — the global is not
 * cleared across a direct call — so this does not add a defect class.)
 *
 * ── Availability gate ────────────────────────────────────────────────────
 *
 * `ctx.standalone || ctx.nativeStrings` only. Off that lane, `undefined` has
 * no guaranteed non-null externref representation, so "the trampoline's null
 * arm means the caller passed null" is not a safe reading, and a marker
 * escaping into a JS host would be an opaque object rather than `null`. The
 * host lane deliberately keeps today's answer.
 */
import type { Instr } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { ensureAnyValueType } from "./any-helpers.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isStrictContext } from "./helpers/is-strict-function.js";
import { emitExplicitNullThis } from "./helpers/sloppy-this-global.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";

/** WasmGC `eq` abstract heap type (mirrors `any-helpers.ts`). */
const EQ_HEAP_TYPE = -19;

const sourceBindsReceiverCache = new WeakMap<ts.SourceFile, boolean>();

/**
 * Does `sf` contain any `<expr>.call(…)` / `.apply(…)` / `.bind(…)` call?
 *
 * This is the compile-order-independent gate for the READER side. The marker
 * can only be produced by a receiver-install trampoline, and
 * `named-this-call.ts` only reserves one for a target declared in the SAME
 * source file as the call — so a file with no receiver-passing call site can
 * never observe a marker, and stays byte-identical. Mirrors `sourceHasBindCall`
 * in `expressions/calls.ts` (a body can compile before the call site that
 * reserves the machinery it must tolerate).
 */
export function sourceBindsReceiver(sf: ts.SourceFile): boolean {
  const cached = sourceBindsReceiverCache.get(sf);
  if (cached !== undefined) return cached;
  let found = false;
  const text = sf.text;
  if (text.includes(".call(") || text.includes(".apply(") || text.includes(".bind(")) {
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        if (name === "call" || name === "apply" || name === "bind") {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  sourceBindsReceiverCache.set(sf, found);
  return found;
}

/** The regime gate, without the per-file question. */
export function explicitNullReceiverLane(ctx: CodegenContext): boolean {
  return ctx.standalone === true || ctx.nativeStrings === true;
}

/**
 * Should code compiled for `node` participate in the marker protocol?
 *
 * Regime ∧ the file has a receiver-passing call site ∧ the file contains strict
 * code at all. The last conjunct is sound rather than heuristic: the marker is
 * installed ONLY by a trampoline whose target is a **strict** declaration in
 * the same source file (`resolveNamedThisCallTarget`), so a file with no strict
 * code anywhere can never observe one, and keeps its bytes. A raw `"use strict"`
 * text match is used because the directive can sit in any nested function, not
 * just the file prologue (`10.4.3-1-77-s` puts it inside `f`).
 */
export function explicitNullReceiverActive(ctx: CodegenContext, node: ts.Node): boolean {
  if (!explicitNullReceiverLane(ctx)) return false;
  const sf = node.getSourceFile?.();
  if (sf === undefined || !sourceBindsReceiver(sf)) return false;
  return sf.text.includes("use strict") || isStrictContext(sf, ctx.inferModuleStrictArguments);
}

/**
 * Reserve the immutable `__this_explicit_null` marker global (a `ref $AnyValue`
 * with the `$undefined` payload). Returns its module-global index, or
 * `undefined` when `$AnyValue` is unavailable.
 *
 * The index is parked on the context so the late-string-import global shift
 * (`shiftGlobalIndices` in `registry/imports.ts`) can keep it in step; already
 * emitted `global.get`s are rewritten by that same pass.
 */
export function ensureExplicitNullThisGlobal(ctx: CodegenContext): number | undefined {
  if (ctx.explicitNullThisGlobalIdx !== undefined) return ctx.explicitNullThisGlobalIdx;
  if (!explicitNullReceiverLane(ctx)) return undefined;
  if (ctx.anyValueTypeIdx < 0) ensureAnyValueType(ctx);
  const anyTypeIdx = ctx.anyValueTypeIdx;
  if (anyTypeIdx < 0) return undefined;
  const globalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__this_explicit_null",
    type: { kind: "ref", typeIdx: anyTypeIdx },
    mutable: false,
    init: [
      { op: "i32.const", value: 1 }, // tag = 1 (Undefined) — see the header
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: NaN },
      { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  });
  ctx.explicitNullThisGlobalIdx = globalIdx;
  return globalIdx;
}

/** `global.get $__this_explicit_null; extern.convert_any` — the marker value. */
export function explicitNullThisExternInstrs(ctx: CodegenContext): Instr[] | undefined {
  const idx = ensureExplicitNullThisGlobal(ctx);
  return idx === undefined ? undefined : [{ op: "global.get", index: idx }, { op: "extern.convert_any" }];
}

/**
 * Build the NON-NULL arm of the `ThisKeyword` reader's `__current_this` split.
 *
 * `thisTmpLocal` is the externref temp the reader already `local.tee`d the
 * global into. Normally the arm is one instruction — yield the installed
 * receiver — and off the regime that is exactly what comes back, byte for
 * byte. Under the regime the marker is discriminated out and answered per
 * §10.4.3: `null` in strict code, the global object in sloppy code.
 *
 * The sloppy answer is deliberately the same as the ABSENT one. Getting that
 * backwards ("null now stays null") would fix the handful of strict rows and
 * break every sloppy `f.call(null)`.
 */
export function buildCurrentThisNonNullArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Node,
  thisTmpLocal: number,
): Instr[] {
  const yieldOnly: Instr[] = [{ op: "local.get", index: thisTmpLocal }];
  if (!explicitNullReceiverActive(ctx, expr)) return yieldOnly;
  // `emitExplicitNullThis` writes through `fctx.body`; capture it into a
  // standalone sequence with the established swap.
  const nullAnswer: Instr[] = [];
  const outerBody = fctx.body;
  fctx.body = nullAnswer;
  emitExplicitNullThis(ctx, fctx, expr);
  fctx.body = outerBody;
  return buildExplicitNullThisElseArm(ctx, thisTmpLocal, nullAnswer) ?? yieldOnly;
}

/** Discrimination core of `buildCurrentThisNonNullArm`; no scratch local needed. */
function buildExplicitNullThisElseArm(
  ctx: CodegenContext,
  thisTmpLocal: number,
  nullAnswer: readonly Instr[],
): Instr[] | undefined {
  const markerIdx = ensureExplicitNullThisGlobal(ctx);
  if (markerIdx === undefined || ctx.anyValueTypeIdx < 0) return undefined;
  const t = ctx.anyValueTypeIdx;
  const yieldReceiver: Instr[] = [{ op: "local.get", index: thisTmpLocal }];
  return [
    { op: "local.get", index: thisTmpLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: t },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: thisTmpLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: t },
        { op: "global.get", index: markerIdx },
        { op: "ref.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [...nullAnswer],
          else: yieldReceiver,
        },
      ],
      else: yieldReceiver,
    },
  ];
}
