// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2660 S3b, #4157 Workstream 1) Retype a function-local binding that PROVABLY
 * holds only instances of ONE escape-gate-approved fnctor: the local slot
 * becomes `(ref null $__fnctor_<F>)` instead of `externref`.
 *
 * ## Why this exists (the three measured nulls it multiplies)
 *
 *   - #4155 Phase 1 typed the SLOTS (fields) but measured zero runtime effect —
 *     the read side never consulted them.
 *   - #4155 Phase 2 built the read side (`fnctor-typed-reads.ts`) but found only
 *     78 candidate sites on acorn, because at most member sites the receiver is
 *     a BINDING that was already erased to externref before any read compiled.
 *   - The #743 fixpoint recovered 0 slots because inference chains bottom out
 *     in untyped bindings.
 *
 * Retyping the instance-holding bindings is the convergence point: every read
 * off a retyped binding becomes a Phase-2 candidate, and every ctor argument
 * fed from one becomes typed for #743.
 *
 * ## Why this is the SAFE version of what #1712 tried (and regressed)
 *
 * `src/codegen/index.ts:7672` (#1712) records that resolving a fnctor instance
 * TYPE to the ctor struct regressed because "the member-call static/dynamic
 * split keys off this type". That split keys off the CHECKER type. This module
 * does not touch type resolution at all — it changes only the LOCAL SLOT's
 * ValType, for bindings whose checker type stays whatever it was (usually
 * `any`). Consequences, verified in source before this was written:
 *
 *   - member READS on the binding reach the dynamic member path (checker-type
 *     driven) with a struct-typed COMPILED receiver — exactly the
 *     static-any/compiled-struct mismatch #4155 Phase 2's hooks consume
 *     (`tryEmitPinnedStructMemberGet`, `finalizeStructAndDynamicMemberGet`'s
 *     isExternObj arm). With the reads flag off they box via the pre-existing
 *     `coerceType(ref → externref)` fallbacks at those exact sites.
 *   - member CALLS keep their checker-type-driven dynamic lowering; every
 *     dynamic call path boxes a non-externref receiver
 *     (`call-receiver-method.ts` coerces `recvType !== externref` receivers).
 *     A member call is NEVER static off the struct type.
 *   - the binding flowing into an externref position (argument, array element,
 *     field store, return) boxes via `coerceType`'s `ref_null → externref`
 *     (`extern.convert_any`).
 *
 * ## Admission (all must hold — every decline leaves byte-identical output)
 *
 *   1. standalone; flag `JS2WASM_FNCTOR_TYPED_BINDINGS` (**ON by default since
 *      2026-08-08**, `=0` disables — census runs flag-independently).
 *   2. `const`/`let`/`var x = new F(...)` where the callee identifier resolves
 *      (by declaration identity, so shadows can't spoof the name) to a
 *      gate-APPROVED fnctor with an up-front reserved struct index. Approval
 *      matters: approved fnctors own a native dispatcher receiver arm and a
 *      per-fnctor prototype `$Object`, so a boxed struct receiver resolves
 *      prototype methods dynamically. Non-approved fnctors carry the #4155
 *      Phase 0 `it.fails` bugs and are refused.
 *   3. The containing function is a plain function (non-async, non-generator —
 *      a generator/async body would desync the #2864 spill-slot mirror, which
 *      replicates the slot-type cascade).
 *   4. Every use is LINEARLY DOMINATED by the declaration
 *      ({@link declDominatesUse}): it hangs off a statement in the SAME
 *      statement list as the declaration statement, at-or-after it. Then any
 *      execution reaching a use has executed the initializer, so dropping the
 *      hoisted `undefined` seed for a `var` (a ref_null slot pre-inits to
 *      null, observably different) cannot be observed. This admits the
 *      block/loop-body shapes and declines the hazardous ones: use after a
 *      loop whose body declares, sibling branch, `catch` reading a `try`
 *      declaration, cross-`switch`-clause reads. Every use must also be in
 *      the SAME function (no closure capture — capture cells/globals are
 *      typed at hoist time).
 *   5. Assignment-compatibility scan: every WRITE to the binding provably
 *      yields the SAME fnctor's instance (direct `new F(...)`, or a
 *      write-once-proven `this.m(...)` — Slice 2). Anything else — null,
 *      undefined, another type, compound assignment, ++/--, destructuring
 *      target, for-in/of target, redeclaration — refuses the retype (the slot
 *      then stays the boxed externref carrier and semantics are untouched).
 *   6. No direct `eval` in the containing function (eval reifies locals into
 *      externref cells).
 *
 * ## Where it is consulted (the three slot-minting sites, in lockstep)
 *
 *   - `hoistVarDecl` (index.ts) — `var` slots; also skips the entry
 *     `__get_undefined()` seed (a ref_null local defaults to null and admission
 *     rule 3 proves no read can observe the pre-init value).
 *   - the let/const pre-hoist allocator (index.ts, `walkStmtForLetConst`) — the
 *     AUTHORITATIVE let/const slot-typer.
 *   - `compileVariableStatement` (statements/variables.ts) — so the
 *     decl-compile cascade agrees with the pre-hoisted slot.
 *
 * All three apply it only when their own cascade produced `externref`, so this
 * never overrides a non-externref inference.
 */
import { ts, forEachChild } from "../ts-api.js";
import { fnctorTypedBindingsFlagEnabled } from "../derivation-flags.js";
import type { CodegenContext } from "./context/types.js";
import type { ValType } from "../ir/types.js";
import { writeOnceThisCallReturnStruct } from "./fnctor-escape-gate.js";

/**
 * **ON by default since 2026-08-08** (#743 derivation-defaults flip);
 * `JS2WASM_FNCTOR_TYPED_BINDINGS=0` restores the externref binding slots.
 * Spelling rule: `src/derivation-flags.ts`.
 *
 * The previous default came from the #4157 Workstream 1 `standaloneDynamic`
 * A/B — see plan/issues/4155-*.md. Two numbers from it stay relevant after the
 * flip: the retype multiplies typed-read candidate sites 78 → 424 on acorn
 * (5.4x, which is why flipping the reads flag without this one ships only the
 * small version), and it is the family's one measurable *cost* — +25,031 B
 * (+2.9 %) on the acorn standalone binary, from inlined presence read-modify-
 * write. Every admission rule is sound-by-refusal, so a decline is
 * byte-identical rather than merely safe.
 */
export function fnctorTypedBindingsEnabled(): boolean {
  return fnctorTypedBindingsFlagEnabled();
}

/**
 * `JS2WASM_FNCTOR_TYPED_BINDINGS_DEBUG=1` — per-compile tallies of admissions
 * and declines, printed at process exit. Flag-independent (mirrors
 * `fnctor-typed-reads.ts`): one compile with the flag off reports exactly how
 * many bindings the flag would retype.
 */
export const fnctorTypedBindingStats = {
  admitted: 0,
  bindings: new Map<string, number>(),
  declines: new Map<string, number>(),
};
let statsHookInstalled = false;
function censusEnabled(): boolean {
  return process.env.JS2WASM_FNCTOR_TYPED_BINDINGS_DEBUG === "1";
}
function note(bucket: Map<string, number>, key: string): void {
  if (!censusEnabled()) return;
  if (!statsHookInstalled) {
    statsHookInstalled = true;
    process.on("exit", () => {
      const top = (m: Map<string, number>, n: number): string =>
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
      process.stderr.write(
        `[fnctor-typed-bindings] admitted=${fnctorTypedBindingStats.admitted}\n` +
          `[fnctor-typed-bindings] bindings: ${top(fnctorTypedBindingStats.bindings, 40)}\n` +
          `[fnctor-typed-bindings] declines: ${top(fnctorTypedBindingStats.declines, 30)}\n`,
      );
    });
  }
  bucket.set(key, (bucket.get(key) ?? 0) + 1);
}

/** Paren/cast/nonnull unwrap (mirrors the escape gate's `unwrapExpr`). */
function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) {
    x = (x as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  return x;
}

/**
 * Does `calleeId` resolve — by DECLARATION IDENTITY, via `ctx.oracle` — to the
 * exact fnctor declaration the escape gate recorded? Name-text matching alone
 * would let a local shadow (`var TokenType = somethingElse`) spoof the retype.
 */
function calleeResolvesToCtorDecl(
  ctx: CodegenContext,
  calleeId: ts.Identifier,
  ctorDecl: ts.FunctionDeclaration | ts.FunctionExpression,
): boolean {
  const d = ctx.oracle.valueDeclarationOf(calleeId);
  if (d === undefined) return false;
  if (d === (ctorDecl as ts.Declaration)) return true;
  // `var F = function () {…}` — the symbol's declaration is the
  // VariableDeclaration; the gate recorded its initializer FunctionExpression.
  if (ts.isVariableDeclaration(d) && d.initializer !== undefined) {
    return unwrap(d.initializer) === (ctorDecl as ts.Expression);
  }
  return false;
}

/** `new F(...)` (unwrapped) of the exact recorded fnctor declaration. */
function isAdmissibleNewOfSameFnctor(
  ctx: CodegenContext,
  expr: ts.Expression,
  ctorDecl: ts.FunctionDeclaration | ts.FunctionExpression,
): boolean {
  const e = unwrap(expr);
  if (!ts.isNewExpression(e)) return false;
  const callee = unwrap(e.expression);
  return ts.isIdentifier(callee) && calleeResolvesToCtorDecl(ctx, callee, ctorDecl);
}

/**
 * (Slice 2) The `__fnctor_<F>` struct a `this.m(...)` call provably returns —
 * the `var node = this.startNode()` acorn shape — or `undefined`. Composes the
 * gate's write-once PROTOTYPE-slot evidence (`writeOnceThisCallReturnStruct`,
 * #3683 S1) with the receiver-shape OWN-shadow argument #3683 S3 documents in
 * typed-this.ts: in standalone a `$__fnctor_<owner>` instance is a CLOSED
 * struct (the expando sidecar is host-mode-only), so an own-property shadow of
 * `m` is impossible unless `m` is a declared field or accessor of that struct
 * — rejected by name here. Never uses the speculative flow-map inference: a
 * wrong verdict here would be a guarded-cast-to-null corruption at the slot
 * store, not a missed fast path.
 */
function provenThisCallStruct(ctx: CodegenContext, call: ts.CallExpression): string | undefined {
  const gate = ctx.fnctorEscapeGate;
  if (gate === undefined) return undefined;
  const v = writeOnceThisCallReturnStruct(ctx.checker, gate, call);
  if (v === undefined) return undefined;
  const ownerStruct = `__fnctor_${v.ownerName}`;
  const ownerFields = ctx.structFields.get(ownerStruct);
  // Owner struct must be registered (reserved) so its CLOSED field list is
  // known — and the method name must not be one of its fields or accessors
  // (the only own-property shadows a closed struct admits).
  if (ownerFields === undefined) return undefined;
  if (ownerFields.some((f) => f.name === v.methodName)) return undefined;
  if (ctx.classAccessorSet.has(`${ownerStruct}_${v.methodName}`)) return undefined;
  // An owner with an EMPTY ctor body can have `$Object`-repped instances (the
  // #2660 S3a reconstruction) — open objects, own-prop-writable — so the
  // closed-struct argument only holds for owners with a real ctor body.
  const ownerCtor = gate.ctorDeclByName.get(v.ownerName);
  if (ownerCtor?.body === undefined || ownerCtor.body.statements.length === 0) return undefined;
  // A class extending the owner re-opens the receiver set (a subclass instance
  // is `this` in inherited methods and can override `m`).
  for (const parent of ctx.classParentMap.values()) {
    if (parent === v.ownerName) return undefined;
  }
  return v.returnedStructName;
}

/**
 * (Slice 2) An RHS that PROVABLY yields an `F` instance: a direct
 * `new F(...)` (Slice 1), or a write-once-proven `this.m(...)` call
 * ({@link provenThisCallStruct}).
 */
function rhsYieldsFnctorStruct(
  ctx: CodegenContext,
  expr: ts.Expression,
  ctorDecl: ts.FunctionDeclaration | ts.FunctionExpression,
  structName: string,
): boolean {
  if (isAdmissibleNewOfSameFnctor(ctx, expr, ctorDecl)) return true;
  const e = unwrap(expr);
  if (!ts.isCallExpression(e)) return false;
  return provenThisCallStruct(ctx, e) === structName;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** Nearest enclosing function-like declaration, or undefined at module scope. */
function containingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) return cur;
    if (ts.isSourceFile(cur)) return undefined;
  }
  return undefined;
}

/** Nearest function-like ancestor of `node` (the node's `this`/locals scope). */
function containingFunctionOf(node: ts.Node): ts.Node | undefined {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) return cur;
    if (ts.isSourceFile(cur)) return undefined;
  }
  return undefined;
}

/**
 * Is `use` strictly inside the LEFT side of a destructuring assignment
 * (`[x] = arr`, `({a: x} = o)`)? Walks up through assignment-PATTERN containers
 * only — a member write through the binding (`x.f = v`) stops at the
 * PropertyAccess (receiver position, a read of the binding) and is NOT a
 * binding write.
 */
function isDestructuringAssignmentTarget(use: ts.Identifier): boolean {
  let child: ts.Node = use;
  for (let a: ts.Node | undefined = use.parent; a !== undefined; a = a.parent) {
    if (ts.isBinaryExpression(a) && isAssignmentOperator(a.operatorToken.kind)) {
      return a.left === child && child !== (use as ts.Node);
    }
    const patternContainer =
      ts.isArrayLiteralExpression(a) ||
      ts.isObjectLiteralExpression(a) ||
      ts.isPropertyAssignment(a) ||
      ts.isShorthandPropertyAssignment(a) ||
      ts.isSpreadElement(a) ||
      ts.isSpreadAssignment(a) ||
      ts.isParenthesizedExpression(a);
    if (!patternContainer) return false;
    child = a;
  }
  return false;
}

/**
 * LINEAR DOMINANCE of the declaration over a use, without a CFG: the use must
 * hang off a statement in the SAME statement list as the declaration
 * statement, at a position at-or-after it. Then any execution that reaches the
 * use has already executed the declaration (statement lists run in order and
 * nothing jumps backwards into one), so no use can observe the slot's pre-init
 * value — which is what licenses dropping the hoisted `undefined` seed for a
 * `var` (a ref_null slot pre-inits to null, observably different). This
 * admits the common block/loop-body shapes (`while (…) { var n = this.f(); …
 * n … }`) and declines exactly the hazardous ones: a use after a loop whose
 * body declares, a use in a sibling branch, a `catch` reading a `try`-block
 * declaration, a `switch` clause read from another clause.
 */
function declDominatesUse(declStmt: ts.Statement, decl: ts.VariableDeclaration, use: ts.Identifier): boolean {
  const container = declStmt.parent;
  let anchor: ts.Node = use;
  while (anchor.parent !== undefined && anchor.parent !== container) {
    if (ts.isSourceFile(anchor.parent)) return false;
    anchor = anchor.parent;
  }
  if (anchor.parent !== container) return false;
  if (anchor === (declStmt as ts.Node)) {
    // Same statement (a later declarator of the same list): positional check.
    return use.getStart() > decl.getEnd();
  }
  return anchor.getStart() > declStmt.getEnd();
}

/**
 * One pass over the containing function for every use of the binding:
 *
 *   - every WRITE must be an RHS that provably yields the same fnctor struct
 *     ({@link rhsYieldsFnctorStruct}); compound assignment, ++/--,
 *     destructuring targets, for-in/of targets and redeclarations refuse;
 *   - every use must be in the SAME function (a closure capture's cell/global
 *     was typed at hoist time) and LINEARLY DOMINATED by the declaration
 *     ({@link declDominatesUse});
 *   - a direct `eval` call anywhere in the function refuses (eval reifies
 *     locals into externref cells).
 *
 * Returns null when compatible, else the decline reason.
 */
function usesAreAssignmentCompatible(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
  fn: ts.Node,
  fnBody: ts.Block,
  ctorDecl: ts.FunctionDeclaration | ts.FunctionExpression,
  structName: string,
): string | null {
  const declName = decl.name as ts.Identifier;
  const nameText = declName.text;
  const declStmt = decl.parent !== undefined ? decl.parent.parent : undefined;
  if (declStmt === undefined || !ts.isVariableStatement(declStmt)) return "no-decl-statement";
  let reason: string | null = null;
  const visit = (node: ts.Node): void => {
    if (reason !== null) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "eval") {
        reason = "direct-eval";
        return;
      }
    }
    if (ts.isIdentifier(node) && node !== declName && node.text === nameText) {
      // Cheap text prefilter above; only then resolve the symbol via the oracle.
      if (ctx.oracle.valueDeclarationOf(node) === (decl as ts.Declaration)) {
        if (containingFunctionOf(node) !== fn) {
          reason = "closure-capture";
          return;
        }
        if (!declDominatesUse(declStmt, decl, node)) {
          reason = "use-not-dominated";
          return;
        }
        const p = node.parent;
        if (ts.isBinaryExpression(p) && p.left === node) {
          const op = p.operatorToken.kind;
          if (op === ts.SyntaxKind.EqualsToken) {
            if (!rhsYieldsFnctorStruct(ctx, p.right, ctorDecl, structName)) {
              reason = "incompatible-assignment";
              return;
            }
          } else if (isAssignmentOperator(op)) {
            reason = "compound-assignment";
            return;
          }
        } else if (
          (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
          (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
        ) {
          reason = "increment";
          return;
        } else if ((ts.isForInStatement(p) || ts.isForOfStatement(p)) && p.initializer === node) {
          reason = "for-in-of-target";
          return;
        } else if (ts.isVariableDeclaration(p) && p.name === node) {
          // A second `var x` declaration (same symbol) — its initializer is a
          // write this scan would have to model; refuse instead.
          reason = "redeclaration";
          return;
        } else if (isDestructuringAssignmentTarget(node)) {
          reason = "destructuring-target";
          return;
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(fnBody);
  return reason;
}

// Keyed per CodegenContext: the same AST can be re-compiled with a different
// type section (struct indices differ per compile), so a verdict — it embeds a
// typeIdx — must never leak across compiles. The inner key is the declaration
// node, so the var hoister, the let/const pre-hoister and the declaration
// compile all read ONE verdict per (compile, decl).
const verdictCache = new WeakMap<CodegenContext, WeakMap<ts.VariableDeclaration, ValType | null>>();

/**
 * The `(ref null $__fnctor_<F>)` ValType for an admissible binding, or null to
 * leave the caller's (externref) slot type untouched. Callers apply this ONLY
 * when their own cascade produced externref. The verdict is computed once per
 * declaration (the var hoister, the let/const pre-hoister and the declaration
 * compile all consult it and must agree).
 */
export function resolveFnctorTypedBindingType(ctx: CodegenContext, decl: ts.VariableDeclaration): ValType | null {
  const enabled = fnctorTypedBindingsEnabled();
  if (!enabled && !censusEnabled()) return null;
  if (!ctx.standalone) return null;
  let perCtx = verdictCache.get(ctx);
  if (perCtx === undefined) {
    perCtx = new WeakMap();
    verdictCache.set(ctx, perCtx);
  }
  const cached = perCtx.get(decl);
  if (cached !== undefined) return enabled ? cached : null;
  const verdict = computeVerdict(ctx, decl);
  perCtx.set(decl, verdict);
  return enabled ? verdict : null;
}

function computeVerdict(ctx: CodegenContext, decl: ts.VariableDeclaration): ValType | null {
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
  const gate = ctx.fnctorEscapeGate;
  if (gate === undefined) return null;
  const init = unwrap(decl.initializer);
  let name: string;
  let initForm: "new" | "call";
  if (ts.isNewExpression(init)) {
    const callee = unwrap(init.expression);
    if (!ts.isIdentifier(callee)) return null;
    name = callee.text;
    initForm = "new";
  } else if (ts.isCallExpression(init)) {
    // (Slice 2) `var node = this.startNode()` — write-once-proven single-return
    // `new F(...)` chain, one hop. See `provenThisCallStruct`.
    const structOfCall = provenThisCallStruct(ctx, init);
    if (structOfCall === undefined) {
      // Census only the interesting near-misses: `this.m(...)` calls that the
      // write-once evidence could not prove.
      const callee = unwrap(init.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        !ts.isPrivateIdentifier(callee.name) &&
        unwrap(callee.expression).kind === ts.SyntaxKind.ThisKeyword
      ) {
        note(fnctorTypedBindingStats.declines, `call-not-proven:${callee.name.text}`);
      }
      return null;
    }
    name = structOfCall.slice("__fnctor_".length);
    initForm = "call";
  } else {
    return null;
  }
  // Everything below this line is a genuine candidate — census the declines.
  if (!gate.approvedNames.has(name)) {
    note(fnctorTypedBindingStats.declines, `not-approved:${name}`);
    return null;
  }
  const reserved = ctx.fnctorReservedTypeIdx.get(name);
  const structName = `__fnctor_${name}`;
  if (reserved === undefined || ctx.structMap.get(structName) !== reserved) {
    note(fnctorTypedBindingStats.declines, `no-reserved-struct:${name}`);
    return null;
  }
  const ctorDecl = gate.ctorDeclByName.get(name);
  if (ctorDecl === undefined) {
    note(fnctorTypedBindingStats.declines, `no-ctor-decl:${name}`);
    return null;
  }
  if (initForm === "new" && !isAdmissibleNewOfSameFnctor(ctx, init, ctorDecl)) {
    note(fnctorTypedBindingStats.declines, `callee-shadowed:${name}`);
    return null;
  }
  // (#2660 S3a carve-out) An approved EMPTY-BODY zero-arg site is reconstructed
  // as a `$proto`-seeded `$Object` when its result lands in an externref slot —
  // that reconstruction serves inherited reads and must keep winning.
  if (
    initForm === "new" &&
    ts.isNewExpression(init) &&
    gate.approved.has(init) &&
    ctorDecl.body !== undefined &&
    ctorDecl.body.statements.length === 0 &&
    (init.arguments?.length ?? 0) === 0
  ) {
    note(fnctorTypedBindingStats.declines, `s3a-reconstruct:${name}`);
    return null;
  }
  const fn = containingFunction(decl);
  if (fn === undefined) {
    note(fnctorTypedBindingStats.declines, `module-scope:${name}`);
    return null;
  }
  const fnLike = fn as ts.FunctionLikeDeclaration;
  if (fnLike.asteriskToken !== undefined) {
    note(fnctorTypedBindingStats.declines, `generator:${name}`);
    return null;
  }
  if (ts.canHaveModifiers(fn) && ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true) {
    note(fnctorTypedBindingStats.declines, `async:${name}`);
    return null;
  }
  const body = fnLike.body;
  if (body === undefined || !ts.isBlock(body)) {
    note(fnctorTypedBindingStats.declines, `no-block-body:${name}`);
    return null;
  }
  const declsOfSym = ctx.oracle.declarationsOf(decl.name);
  if (declsOfSym.length !== 1 || declsOfSym[0] !== (decl as ts.Declaration)) {
    note(fnctorTypedBindingStats.declines, `multi-declaration:${name}`);
    return null;
  }
  const incompat = usesAreAssignmentCompatible(ctx, decl, fn, body, ctorDecl, structName);
  if (incompat !== null) {
    note(fnctorTypedBindingStats.declines, `${incompat}:${name}`);
    return null;
  }
  fnctorTypedBindingStats.admitted++;
  note(fnctorTypedBindingStats.bindings, `${initForm}:${name}:${decl.name.text}`);
  return { kind: "ref_null", typeIdx: reserved };
}
