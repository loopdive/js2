// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157 slice B) Receiver CSE — resolve the host-dispatched `this` ONCE per
 * straight-line sequence instead of once per member OPERAND.
 *
 * A lifted-closure body reads its receiver from the `__current_this` module
 * global through a ~15-instruction ladder (expressions.ts, the
 * `fctx.readsCurrentThis` arm): `global.get` → `ref.is_null` → the §10.4.3
 * unbound-`this` substitute → `ref.test $AnyValue` → sentinel `ref.eq` against
 * the #4203 explicit-null marker. It is emitted per `this` OPERAND, so
 * `this.lastTokEnd = this.end` pays it twice for a value that cannot differ
 * between the two reads. Measured on the standalone acorn build (#4157 entry
 * 30): 5,974 ladders.
 *
 * WHY THE CACHE IS KEYED ON THE INSTRUCTION ARRAY — AND WHY THAT IS NOT
 * ENOUGH BY ITSELF. Reusing a value across emission points needs DOMINANCE,
 * and an AST-walking emitter that builds branch bodies by swapping `fctx.body`
 * to a detached array has no dominance information: caching `this` from an
 * `if`'s then-arm and reusing it in the else-arm would read a local that was
 * never set (a silent wrong answer — the local's default is
 * `ref.null.extern`, not a validation error).
 *
 * A Wasm instruction array is entered at the top and flows down — a
 * `br`/`return` can only leave it, never jump into its middle — so an
 * instruction earlier in the SAME array dominates every later instruction in
 * it, and reuse restricted to one array identity needs no analysis. Nested
 * blocks are separate arrays and simply miss (each re-resolves once).
 *
 * That argument silently assumes the array is APPEND-ONLY, and it is not: ~8
 * emitters relocate an already-emitted range out of `fctx.body` into a
 * `try`/`if`/guard arm via `fctx.body.splice(start)` (expressions.ts' async
 * rejection wrap, array-methods' guard arms, char-at-transfer's deferred
 * position). A `local.tee` that has been moved into a conditional arm no
 * longer dominates what is emitted next, and the acorn self-parse hits exactly
 * that: with the naive rule the parse throws, and bisecting the reuse count
 * lands on one reuse whose recorded position is PAST the current array end.
 * So each lookup re-verifies that the `tee` instruction OBJECT is still at the
 * index it was left at; a relocation costs a reuse (20 of 2,005 on acorn),
 * never correctness.
 *
 * WHY THE VALUE IS INVARIANT WITHIN THAT SEQUENCE. `__current_this` is
 * installed by `__call_fn_method_N` and restored on return (closure-exports.ts),
 * so a call between two reads leaves it unchanged. The one path that does not
 * restore is an exception unwinding through the dispatcher — and an unwind
 * leaves the array, so it cannot be observed by a later `local.get` in the same
 * array (a `catch` body is its own array and re-resolves).
 *
 * The cache key also carries the two per-node predicates the ladder's arms
 * depend on (`unboundThisIsGlobalObject`, `explicitNullReceiverActive`, plus
 * the direct-eval fallback flag), so two `this` nodes that would lower to
 * DIFFERENT ladders never share a slot — the #4190 top-level-IIFE case, where
 * an inlined body's strictness differs from `__module_init`'s around it.
 *
 * **Default ON** since the #4157 tuned-set flip (`src/perf-flags.ts`). With
 * `JS2WASM_RECEIVER_CSE=0` nothing here runs and the emitted binary is
 * byte-identical to the pre-#4157 base.
 */
import type ts from "typescript";
import { SyntaxKind } from "typescript";

import type { Instr } from "../ir/types.js";
import { tunedFlagEnabled, tunedFlagExplicit } from "../perf-flags.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { explicitNullReceiverActive } from "./explicit-null-receiver.js";
import { unboundThisIsGlobalObject } from "./helpers/sloppy-this-global.js";

/** Flag gate. Default ON; `=0` ⇒ every `this` operand keeps its own ladder. */
export function receiverCseEnabled(): boolean {
  return tunedFlagEnabled(process.env.JS2WASM_RECEIVER_CSE);
}

/** Per-instruction-array cache: lowering-shape key → the slot holding `this`. */
const cacheByArray = new WeakMap<Instr[], Map<string, CacheEntry>>();

/** The slot, plus where its `local.tee` was left so a relocation can be seen. */
interface CacheEntry {
  slot: number;
  at: number;
  tee: Instr;
}

/** Hit/emit counters — proof the mechanism fired, reported at finalize. */
let hits = 0;
let slots = 0;

function shapeKey(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Node): string {
  return `${thisContainerPos(expr)}:${unboundThisIsGlobalObject(ctx, expr) ? "g" : "-"}${
    explicitNullReceiverActive(ctx, expr) ? "n" : "-"
  }${fctx.directEvalSloppyThisFallback ? "e" : "-"}`;
}

/**
 * Position of the construct that BINDS this `this` — the nearest enclosing
 * non-arrow function, or the file. Two `this` nodes with different binders are
 * different values even when they lower identically and land in one sequence,
 * which is exactly what an INLINED callee body produces (#4190's top-level
 * IIFE, inlined into `__module_init` alongside its own `this`).
 */
function thisContainerPos(expr: ts.Node): number {
  for (let n: ts.Node | undefined = expr.parent; n !== undefined; n = n.parent) {
    const k = n.kind;
    if (
      k === SyntaxKind.FunctionDeclaration ||
      k === SyntaxKind.FunctionExpression ||
      k === SyntaxKind.MethodDeclaration ||
      k === SyntaxKind.Constructor ||
      k === SyntaxKind.GetAccessor ||
      k === SyntaxKind.SetAccessor ||
      k === SyntaxKind.ClassStaticBlockDeclaration ||
      k === SyntaxKind.SourceFile
    ) {
      return n.pos;
    }
  }
  return -1;
}

/**
 * Emit the receiver from the slot the ladder already filled in the sequence
 * being emitted, for this exact lowering shape. Returns false — having emitted
 * nothing — when the ladder must run.
 */
export function emitCachedResolvedThis(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Node): boolean {
  if (!receiverCseEnabled()) return false;
  const entry = cacheByArray.get(fctx.body)?.get(shapeKey(ctx, fctx, expr));
  if (entry === undefined) return false;
  // The array is NOT append-only: emitters relocate an already-emitted range
  // out of `fctx.body` into a `try`/`if`/guard arm (`fctx.body.splice(start)`,
  // ~8 sites). If that moved the `local.tee`, it no longer dominates what comes
  // next here, and reusing the slot would read an unset local. Verify the tee is
  // still exactly where it was left — the only relocation signal available.
  if (fctx.body[entry.at - 1] !== entry.tee) return false;
  const limit = process.env.JS2WASM_RECEIVER_CSE_LIMIT;
  if (limit !== undefined && hits >= Number(limit)) return false;
  if (process.env.JS2WASM_RECEIVER_CSE_TRACE === "1") {
    process.stderr.write(
      `[receiver-cse] reuse#${hits} in ${fctx.name} @${expr.pos} gap=${fctx.body.length - entry.at}\n`,
    );
  }
  fctx.body.push({ op: "local.get", index: entry.slot });
  hits++;
  return true;
}

/**
 * Record the receiver the caller has just resolved (its value is on the stack)
 * into a function-scoped slot, leaving it on the stack via `local.tee`. Every
 * later `this` in the same sequence with the same lowering shape reads the slot.
 */
export function recordResolvedThis(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Node): void {
  if (!receiverCseEnabled()) return;
  const slot = allocLocal(fctx, `__this_cse_${fctx.locals.length}`, { kind: "externref" });
  const tee: Instr = { op: "local.tee", index: slot };
  fctx.body.push(tee);
  let perArray = cacheByArray.get(fctx.body);
  if (perArray === undefined) {
    perArray = new Map<string, CacheEntry>();
    cacheByArray.set(fctx.body, perArray);
  }
  perArray.set(shapeKey(ctx, fctx, expr), { slot, at: fctx.body.length, tee });
  slots++;
}

/**
 * One line of evidence that the pass fired, printed at finalize — only when the
 * flag was asked for. On a default build the pass always runs, so an
 * unconditional line here would print on every single compile.
 */
export function reportReceiverCse(): void {
  if (!receiverCseEnabled()) return;
  if (!tunedFlagExplicit(process.env.JS2WASM_RECEIVER_CSE) && process.env.JS2WASM_RECEIVER_CSE_TRACE !== "1") return;
  process.stderr.write(`[receiver-cse] ladders=${slots} reuses=${hits}\n`);
}
