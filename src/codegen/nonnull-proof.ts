// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157 entry 15) Elide the member-access null guard where the receiver is
 * PROVABLY non-null.
 *
 * ## Why this exists
 *
 * `__new_TypeError` is emitted at 3,917 static sites in the compiled acorn
 * build — the single largest emitted item in the program, ahead of every
 * property or boxing helper. It is the null-dereference check JS semantics
 * require on member access: V8 pays nothing for it (the load faults and a
 * signal handler raises), we emit an explicit `ref.is_null` test plus a
 * constructor call at every site.
 *
 * Those paths are COLD — they throw — so they cost almost nothing directly.
 * What they cost is SIZE: each guard is ~8 instructions plus a local in the
 * enclosing function, and `wasm-opt` inlines on a static size budget with no
 * profile. Compiled acorn averages 682 WAT lines per function, so essentially
 * nothing qualifies for inlining; **our code size is itself the optimisation
 * barrier** (#4157 entry 15). Removing provably-dead guards is a code-size
 * lever aimed at that barrier, not a speed lever aimed at the guard.
 *
 * ## The proof discipline
 *
 * Eliding a check that WAS needed turns a correct, catchable `TypeError` into
 * a wasm trap (`struct.get` on null) or, worse, a wrong value. So every proof
 * here is a statement about the **wasm value on the stack**, not about a
 * TypeScript type:
 *
 * - `nonnull-ref` — the compiled receiver's `ValType` is a NON-NULLABLE
 *   `(ref $T)`. `extern.convert_any` of a non-null `anyref` is a non-null
 *   `externref`, so `ref.is_null` on it is a constant 0. This is a wasm type
 *   system guarantee and holds regardless of what the checker believes.
 * - `boxed-number` — the receiver was an `f64`/`i32` that codegen just routed
 *   through `__box_number`, whose every return path is `ref.i31` or
 *   `struct.new` (`registry/imports.ts`). Restricted to no-JS-host mode, where
 *   `__box_number` is the in-module native rather than an `env` import whose
 *   behaviour we cannot see.
 * - `syntactic-producer` — `isProvablyNonNull` (property-access.ts): `new X()`,
 *   object/array/string/template literals, and `const` bindings of those.
 *
 * **Deliberately NOT used as a proof: TypeScript nullability.** `ctx.oracle`'s
 * `nullabilityOf` answers from the declared type, and the corpus that motivates
 * this work is plain JS compiled with `skipSemanticDiagnostics` and without
 * `strictNullChecks` — there, "the type does not include null" is not evidence
 * about the value. A type-level proof would silently elide live guards.
 *
 * **Also NOT a proof: a bare `this` receiver.** `this` can arrive null through
 * a detached method reference; the trampolines that check it (#see
 * `closures/method-trampolines.ts`) are not universal. When `this` is compiled
 * to a non-nullable struct ref the `nonnull-ref` proof already covers it, which
 * is the sound half of that idea.
 *
 * ## Flag
 *
 * **Default ON** since the #4157 tuned-set flip — see `src/perf-flags.ts` for
 * the token rule. `JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR=0` disables the
 * elision, and every call site takes the byte-identical legacy path.
 * `JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR_DEBUG=1` prints the per-site census
 * and runs FLAG-INDEPENDENTLY, so candidate counts can be measured without
 * changing a single emitted byte.
 */
import ts from "typescript";

import type { Instr, ValType } from "../ir/types.js";
import { tunedFlagEnabled } from "../perf-flags.js";

import type { CodegenContext, FunctionContext } from "./context/types.js";
import { readEnv } from "../env.js";

/** How a receiver was shown to be non-null. Each is a wasm-value fact. */
export type NonNullProof = "nonnull-ref" | "boxed-number" | "syntactic-producer";

/** `JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR` — default ON, `=0` disables. */
export function elideProvenNonNullTypeErrorEnabled(): boolean {
  return tunedFlagEnabled(readEnv("JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR"));
}

function censusEnabled(): boolean {
  return readEnv("JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR_DEBUG") === "1";
}

const census = new Map<string, number>();
let censusHookInstalled = false;

function bump(key: string): void {
  census.set(key, (census.get(key) ?? 0) + 1);
  if (censusHookInstalled) return;
  censusHookInstalled = true;
  process.on("exit", () => {
    const rows = [...census.entries()].sort((a, b) => b[1] - a[1]);
    let elided = 0;
    let kept = 0;
    for (const [key, n] of rows) {
      if (key.includes(" proven=")) elided += n;
      else kept += n;
    }
    process.stderr.write(`[nonnull-proof] candidates=${elided + kept} provable=${elided} kept=${kept}\n`);
    for (const [key, n] of rows) process.stderr.write(`[nonnull-proof] ${String(n).padStart(6)}  ${key}\n`);
  });
}

/** Cheap syntax label for a declined receiver, so the residue is diagnosable. */
function receiverShape(expr: ts.Expression | undefined): string {
  if (!expr) return "no-expr";
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isIdentifier(expr)) return "identifier";
  if (ts.isPropertyAccessExpression(expr)) return "property-access";
  if (ts.isElementAccessExpression(expr)) return "element-access";
  if (ts.isCallExpression(expr)) return "call";
  return ts.SyntaxKind[expr.kind] ?? "other";
}

export interface NonNullProofQuery {
  /** A stable label for the emission site, used by the census. */
  site: string;
  /**
   * The enclosing function, used ONLY by the census to price a hypothetical
   * dominance proof ("this receiver was already guarded earlier in this
   * function"). Never consulted by `classify`.
   */
  fnKey?: string;
  /** The receiver's compiled `ValType`, exactly as `compileExpression` returned it. */
  compiled?: ValType | null;
  /** The receiver expression, for the syntactic producer proof. */
  expr?: ts.Expression;
  /**
   * True when codegen routed an `f64`/`i32` receiver through `__box_number`
   * between `compiled` and the null guard.
   */
  boxed?: boolean;
  /**
   * Set when a guarded `ref.cast` may have replaced the value with `ref.null`
   * for a TYPE mismatch (`fctx.__lastGuardedCastBackup`). A null from a failed
   * cast is not a null receiver, so no receiver-level proof applies.
   */
  guardedCastMayNull?: boolean;
  /** `isProvablyNonNull(expr, ctx.checker)` — passed in to avoid an import cycle. */
  syntacticNonNull?: boolean;
}

/**
 * Return the proof that the value about to be null-guarded cannot be null, or
 * `undefined` to keep the guard. Always records the census (flag-independent);
 * returns a proof only when the flag is on, so an OFF build is byte-identical.
 */
export function proveReceiverNonNull(ctx: CodegenContext, q: NonNullProofQuery): NonNullProof | undefined {
  const proof = classify(ctx, q);
  if (censusEnabled()) {
    bump(proof ? `${q.site} proven=${proof}` : `${q.site} kept recv=${receiverShape(q.expr)}`);
    priceDominance(q);
  }
  if (!elideProvenNonNullTypeErrorEnabled()) return undefined;
  return proof;
}

/**
 * Ceiling estimate for a dominance proof that this module does NOT implement:
 * how many guards re-check a receiver that a previous guard in the same
 * function already tested. This is an UPPER bound — it ignores control flow and
 * intervening reassignment, both of which a real implementation must respect.
 */
const seenReceivers = new Set<string>();
function priceDominance(q: NonNullProofQuery): void {
  const expr = q.expr;
  if (!q.fnKey || !expr) return;
  const simple =
    expr.kind === ts.SyntaxKind.ThisKeyword ? "this" : ts.isIdentifier(expr) ? `id:${expr.text}` : undefined;
  if (simple === undefined) {
    bump("dominance-ceiling: receiver not a simple binding");
    return;
  }
  const key = `${q.fnKey}\0${simple}`;
  if (seenReceivers.has(key)) bump(`dominance-ceiling: REPEAT of ${simple === "this" ? "this" : "an identifier"}`);
  else {
    seenReceivers.add(key);
    bump("dominance-ceiling: first guard of this binding");
  }
}

/** What a call site can offer about its receiver without building a full query. */
export interface ReceiverProofHint {
  site: string;
  compiled?: ValType | null;
  expr?: ts.Expression;
}

/**
 * Resolve a {@link ReceiverProofHint} against the guarded-cast state of `fctx`.
 *
 * `__lastGuardedCastBackup` is the load-bearing input: a failed guarded
 * `ref.cast` replaces a perfectly non-null receiver with `ref.null`, so when a
 * backup exists the null on the stack may mean "wrong struct type" rather than
 * "null receiver" and NO receiver-level proof applies.
 *
 * `syntactic` is injected because `isProvablyNonNull` lives in
 * `property-access.ts`, which imports this module.
 */
export function receiverProofHolds(
  ctx: CodegenContext,
  fctx: FunctionContext,
  hint: ReceiverProofHint | undefined,
  syntactic: (expr: ts.Expression) => boolean,
): boolean {
  if (hint === undefined) return false;
  return (
    proveReceiverNonNull(ctx, {
      site: hint.site,
      fnKey: fctx.name,
      compiled: hint.compiled,
      expr: hint.expr,
      guardedCastMayNull: (fctx as { __lastGuardedCastBackup?: number }).__lastGuardedCastBackup !== undefined,
      syntacticNonNull: hint.expr ? syntactic(hint.expr) : false,
    }) !== undefined
  );
}

/**
 * Store the externref/ref receiver on the stack into `tmp`, guarding it against
 * null unless {@link proveReceiverNonNull} holds.
 *
 * `local.tee; ref.is_null; if` and a bare `local.set` have the same net stack
 * effect (tee pushes the value back, `ref.is_null` consumes it, `if` consumes
 * the i32), so the elided form is a drop-in replacement rather than a rewrite.
 *
 * `throwInstrs` is a THUNK so this leaf module never imports the throw builder
 * from `property-access.ts` (which imports this one) — the same shape
 * `tryEmitFnctorTypedFieldGet` already uses for the identical cycle.
 *
 * ## (#4519) `nullishTest` — why the null test is not always `ref.is_null`
 *
 * This is the §7.3.2 RequireObjectCoercible check for a member access, and
 * §7.3.2 rejects `null` AND `undefined`. `ref.is_null` alone spells only the
 * first. That was a faithful spelling until #4489 made `undefined` a tag-1
 * `$AnyValue` SINGLETON in the standalone S1 regime — a genuinely NON-null
 * reference. From then on this guard read a real `undefined` receiver as
 * "an object", declined to throw, and let the read answer a fallback value:
 * `o.foo` on an `undefined` `o` returned `undefined` where the spec requires a
 * TypeError (measured on this branch, 6 shapes; #4489 residual 5).
 *
 * `nullishTest` is a THUNK for the same cycle reason as `throwInstrs`: the
 * `is_null ∨ is-singleton` builder lives in `any-helpers.ts`, beside the rest of
 * the #2106 S1 singleton vocabulary, and the callers here are the ones that own
 * the §7.3.2 semantics. It returns `undefined` when the regime is inactive, and
 * then this function emits exactly the bytes it emitted before — so the JS-host
 * and gc lanes are byte-identical.
 *
 * Note the `local.tee` becomes a `local.set` in the widened form: the test reads
 * the receiver back OUT of `tmp` (twice, scratch-free) rather than off the
 * stack. Net stack effect is unchanged — value in, i32 out.
 */
export function emitReceiverNullGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  tmp: number,
  q: NonNullProofQuery,
  throwInstrs: () => Instr[],
  nullishTest?: () => Instr[] | undefined,
): boolean {
  if (proveReceiverNonNull(ctx, { ...q, fnKey: q.fnKey ?? fctx.name }) !== undefined) {
    fctx.body.push({ op: "local.set", index: tmp });
    return true;
  }
  const widened = nullishTest?.();
  if (widened !== undefined) {
    fctx.body.push({ op: "local.set", index: tmp });
    fctx.body.push(...widened);
  } else {
    fctx.body.push({ op: "local.tee", index: tmp });
    fctx.body.push({ op: "ref.is_null" });
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs(), else: [] });
  return false;
}

function classify(ctx: CodegenContext, q: NonNullProofQuery): NonNullProof | undefined {
  // A failed guarded cast produces `ref.null` from a perfectly non-null
  // receiver. Nothing about the receiver can rule that out.
  if (q.guardedCastMayNull) return undefined;
  const kind = q.compiled?.kind;
  // The wasm type system already forbids null here.
  if (kind === "ref") return "nonnull-ref";
  // `__box_number` returns `ref.i31`/`struct.new` on every path — but only the
  // in-module native is ours to reason about.
  if (q.boxed === true && (kind === "f64" || kind === "i32")) return "boxed-number";
  if (q.syntacticNonNull === true) return "syntactic-producer";
  return undefined;
}
