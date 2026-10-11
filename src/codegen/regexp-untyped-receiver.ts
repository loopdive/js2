// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B10) `%RegExp.prototype%` as seen through an UNTYPED
 * RegExp, under `--target standalone`.
 *
 * ## The measured defect
 *
 * A RegExp the checker can see (`var re = /a/; re.test`) is lowered statically.
 * One it cannot — `var r; r = /./g;` read inside a nested function, where `r`
 * is `any`, or `var result = eval('/1/g')` — goes through the runtime MOP, and
 * two of its answers were wrong (probes `.tmp/b10/p/{w2,g3,s1}.js`, base tree):
 *
 * | expression                         | base                        | spec                   |
 * | ---------------------------------- | --------------------------- | ---------------------- |
 * | `r.test` / `r.exec` (value read)   | `undefined`                 | `RegExp.prototype.<m>` |
 * | `r.toString()`, `String(r)`, `r+""`| `"null"`                    | `"/./g"`               |
 * | `Object.getPrototypeOf(r)`         | `null`                      | `RegExp.prototype`     |
 *
 * `__extern_get` on a `$NativeRegExp` reached `%RegExp.prototype%` only through
 * the proto-index companion's terminal-miss consult, and that companion is
 * seeded only when the pre-scan arms `protoMemberDirty` (B9's root cause). A
 * file with no such arming read `undefined` for every method — and for
 * `toString` it read something worse: the implicit `%Object.prototype%`
 * consult answered `Object.prototype.toString`, so the #4564 `__to_primitive`
 * RegExp arm found a callable `toString`, called the wrong one, and never
 * reached its own RegExp intrinsic. `__getPrototypeOf` had no `$NativeRegExp`
 * arm at all (the static fold answers the typed spelling; nothing answered the
 * dynamic one).
 *
 * ## The fix — answer the miss from the builtin method list
 *
 * Two finalize arms, both `ref.test $NativeRegExp`-guarded, so no other
 * receiver can reach them:
 *
 *  - `__extern_get(rx, "<m>")` — an OWN entry in the carrier bag still shadows
 *    (fall through); otherwise answer `%RegExp.prototype%.<m>`: the seeded
 *    companion when the module seeded that member (it is the mutable own
 *    table, so a user replacement / `delete` stays observable), else the
 *    identity-stable builtin singleton — the same value the static
 *    `RegExp.prototype.<m>` read yields. This runs before the implicit
 *    `%Object.prototype%` consult, which is §10.1.8's order: RegExp.prototype
 *    sits between the instance and Object.prototype.
 *  - `__getPrototypeOf(rx)` → the lazy `%RegExp.prototype%` singleton. The
 *    carrier has no `[[Prototype]]` slot (a `setPrototypeOf` on a RegExp is
 *    not representable, which is why the TYPED spelling already folds to this
 *    exact singleton), so this makes the dynamic answer agree with the static
 *    one.
 *
 * ## Demand gate — no module that cannot reach the miss changes bytes
 *
 * Both arms are installed only in a source file that DEMANDS them, decided by
 * one cached AST walk ({@link untypedRegExpDemandOf}):
 *
 *  1. an identifier binding with REGEXP EVIDENCE: its declaration initializer,
 *     or the right side of a plain `=` to it, is a regexp literal,
 *     `new RegExp(…)` / `RegExp(…)`, or `eval(<string>)` whose text parses to a
 *     regexp literal (the six `statementList/eval-*-regexp-literal*` rows);
 *  2. a USE of that binding where the checker types it `any`/`unknown`
 *     (`ctx.oracle.typeFactOf`): a non-call read of `exec`/`test`/`compile`,
 *     any spelling of `toString` (a `.toString()` call and the implicit
 *     ToString of `String(x)` / `x + …` / a template span all go through
 *     `__to_primitive` → `__extern_get(x, "toString")`), or
 *     `Object|Reflect.getPrototypeOf(x)`.
 *
 * A typed RegExp binding (`const RE = /…/` — every harness file's spelling) is
 * not `any`, so it demands nothing; a method CALL on an untyped RegExp
 * (`r.test(s)`) already dispatches correctly and demands nothing. Only the
 * demanded members are minted (at module-init start, where a
 * `FunctionContext` exists to absorb late-import shifts); the finalize arms
 * answer only what was minted.
 */
import { ts } from "../ts-api.js";
import type { Instr } from "../ir/types.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { CARRIER_BAG_HAS } from "./carrier-bag-visibility.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import {
  buildLazyNativeProtoGetInstrs,
  ensureStandaloneNativeMethodClosure,
  seededNativeProtoOwnMembersByBrand,
} from "./native-proto.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { demandRegExpProtoToStringBody } from "./regexp-proto-to-string.js";
import { ensureRegExpNativeProtoGlue, standaloneRegExpStructTypeIdx } from "./regexp-standalone.js";

/** The `%RegExp.prototype%` METHODS a runtime read can miss (getters: B4). */
const METHODS: ReadonlySet<string> = new Set(["exec", "test", "compile", "toString"]);

interface Demand {
  readonly members: ReadonlySet<string>;
  readonly gpo: boolean;
}
const NO_DEMAND: Demand = { members: new Set(), gpo: false };
const demandBySource = new WeakMap<ts.SourceFile, Demand>();

interface ModuleState {
  /** member → minted closure handle. */
  readonly closures: Map<string, { type: { kind: "ref"; typeIdx: number }; funcIdx: number }>;
  gpo: boolean;
  brand: number;
}
const stateByCtx = new WeakMap<CodegenContext, ModuleState>();
const mintedSources = new WeakMap<CodegenContext, Set<ts.SourceFile>>();

function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

function textHasRegExpLiteral(text: string): boolean {
  let found = false;
  const sf = ts.createSourceFile("__b10_eval.js", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Does `expr` evaluate to a RegExp the checker may not type as one? */
function isRegExpSource(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (e.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  if ((ts.isNewExpression(e) || ts.isCallExpression(e)) && ts.isIdentifier(e.expression)) {
    if (e.expression.text === "RegExp") return true;
    if (ts.isCallExpression(e) && e.expression.text === "eval") {
      const arg = e.arguments[0];
      return arg !== undefined && ts.isStringLiteralLike(arg) && textHasRegExpLiteral(arg.text);
    }
  }
  return false;
}

/** Names bound (by initializer or plain `=`) to a regexp source — syntactic prefilter. */
function evidenceNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (isRegExpSource(node.initializer)) names.add(node.name.text);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isRegExpSource(node.right)
    ) {
      names.add(node.left.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/**
 * The per-source-file demand (cached). Pure analysis — emits nothing.
 */
function untypedRegExpDemandOf(ctx: CodegenContext, sf: ts.SourceFile): Demand {
  const cached = demandBySource.get(sf);
  if (cached) return cached;
  const names = evidenceNames(sf);
  if (names.size === 0) {
    demandBySource.set(sf, NO_DEMAND);
    return NO_DEMAND;
  }
  // Declarations that really received a regexp source (resolved, not by name).
  const evidence = new Set<ts.Declaration>();
  const note = (id: ts.Identifier): void => {
    const decl = ctx.oracle.variableDeclarationOf(id);
    if (decl) evidence.add(decl);
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text)) {
      if (node.initializer && isRegExpSource(node.initializer)) evidence.add(node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      names.has(node.left.text) &&
      isRegExpSource(node.right)
    ) {
      note(node.left);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const untyped = (expr: ts.Expression | undefined): boolean => {
    if (!expr) return false;
    const e = unwrap(expr);
    if (!ts.isIdentifier(e) || !names.has(e.text)) return false;
    const decl = ctx.oracle.variableDeclarationOf(e);
    if (!decl || !evidence.has(decl)) return false;
    const kind = ctx.oracle.typeFactOf(e).kind;
    return kind === "any" || kind === "unknown";
  };

  const members = new Set<string>();
  let gpo = false;
  const visit = (node: ts.Node): void => {
    let name: string | undefined;
    let recv: ts.Expression | undefined;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      name = node.name.text;
      recv = node.expression;
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      name = node.argumentExpression.text;
      recv = node.expression;
    }
    if (name !== undefined && METHODS.has(name)) {
      const parent = node.parent;
      const isCallee = ts.isCallExpression(parent) && parent.expression === node;
      const isWrite =
        (ts.isBinaryExpression(parent) &&
          parent.left === node &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ts.isDeleteExpression(parent);
      if (!isWrite && (name === "toString" || !isCallee) && untyped(recv)) members.add(name);
    }
    // Implicit ToString: `String(x)`, `x + …` / `… + x`, a template span.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "String") {
      if (untyped(node.arguments[0])) members.add("toString");
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.PlusToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      if (untyped(node.left) || untyped(node.right)) members.add("toString");
    } else if (ts.isTemplateSpan(node) && untyped(node.expression)) {
      members.add("toString");
    }
    // `Object.getPrototypeOf(x)` / `Reflect.getPrototypeOf(x)`.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Object" || node.expression.expression.text === "Reflect") &&
      node.expression.name.text === "getPrototypeOf" &&
      untyped(node.arguments[0])
    ) {
      gpo = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const demand: Demand = members.size === 0 && !gpo ? NO_DEMAND : { members, gpo };
  demandBySource.set(sf, demand);
  return demand;
}

/**
 * PRE-SCAN — decide `sf`'s demand before any closure is minted, so the
 * `toString` member's real body (regexp-proto-to-string.ts) is chosen before
 * the RegExp companion seeder (or anything else) mints that member.
 */
export function noteUntypedRegExpDemand(ctx: CodegenContext, sf: ts.SourceFile): void {
  if (!ctx.standalone || ctx.wasi) return;
  if (untypedRegExpDemandOf(ctx, sf).members.has("toString")) demandRegExpProtoToStringBody(ctx);
}

/**
 * Mint the demanded `%RegExp.prototype%` method closures for `sf`. Called at
 * module-init start (idempotent per source file); a file with no demand emits
 * nothing. A member the program ASSIGNS on some builtin prototype is left to
 * the existing lookup, exactly as the Date twin does (#6678): a singleton
 * would hide the override.
 */
export function mintUntypedRegExpReceiverMembers(
  ctx: CodegenContext,
  fctx: FunctionContext,
  sf: ts.SourceFile | undefined,
): void {
  if (!ctx.standalone || ctx.wasi || !sf) return;
  let seen = mintedSources.get(ctx);
  if (!seen) mintedSources.set(ctx, (seen = new Set()));
  if (seen.has(sf)) return;
  seen.add(sf);
  const demand = untypedRegExpDemandOf(ctx, sf);
  if (demand.members.size === 0 && !demand.gpo) return;
  const brand = ensureRegExpNativeProtoGlue(ctx);
  if (brand === undefined) return;
  let state = stateByCtx.get(ctx);
  if (!state) stateByCtx.set(ctx, (state = { closures: new Map(), gpo: false, brand }));
  if (demand.gpo) {
    state.gpo = true;
    // Materialize `%RegExp.prototype%` now, in the body-compilation regime:
    // doing it first from the finalize arm could build its companion seeder
    // (closures + meta types) after the dispatchers are closed.
    buildLazyNativeProtoGetInstrs(ctx, brand);
  }
  for (const member of [...demand.members].sort()) {
    if (state.closures.has(member) || ctx.protoNamedWrittenMembers.has(member)) continue;
    const closure = ensureStandaloneNativeMethodClosure(ctx, brand, member, "method");
    if (closure) state.closures.set(member, closure);
  }
  flushLateImportShifts(ctx, fctx);
}

/** `__getPrototypeOf($NativeRegExp)` → the lazy `%RegExp.prototype%` singleton. */
function unshiftGetPrototypeOfArm(ctx: CodegenContext, state: ModuleState, regexpTypeIdx: number): void {
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__getPrototypeOf");
  const proto = buildLazyNativeProtoGetInstrs(ctx, state.brand);
  if (!fn || !proto) return;
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: regexpTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: [...proto, { op: "return" }] },
  );
}

/** `__extern_get($NativeRegExp, "<m>")` → `%RegExp.prototype%.<m>` on an own miss. */
function unshiftExternGetArm(ctx: CodegenContext, state: ModuleState, regexpTypeIdx: number): void {
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const anyStr = ctx.anyStrTypeIdx;
  if (!fn || strFlattenIdx === undefined || strEqualsIdx === undefined || anyStr < 0) return;
  const bagHasIdx = ctx.funcMap.get(CARRIER_BAG_HAS);
  const protoGetIdx = ctx.funcMap.get("__protoidx_get_r");
  const seeded = new Set(
    protoGetIdx === undefined ? [] : (seededNativeProtoOwnMembersByBrand(ctx).get(state.brand) ?? []),
  );
  const keyLocal = 2 + fn.locals.length;

  const ladder: Instr[] = [];
  for (const [member, closure] of [...state.closures].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // The seeded companion is RegExp.prototype's mutable own table: it holds
    // the builtin until the program replaces or deletes the member.
    const answer: Instr[] =
      protoGetIdx !== undefined && seeded.has(member)
        ? [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: protoGetIdx },
          ]
        : [...pushBuiltinFnSingletonValueInstrs(ctx, closure), { op: "extern.convert_any" }];
    ladder.push(
      { op: "local.get", index: keyLocal },
      { op: "ref.as_non_null" },
      ...nativeStringLiteralInstrs(ctx, member),
      { op: "call", funcIdx: strEqualsIdx },
      { op: "if", blockType: { kind: "empty" }, then: [...answer, { op: "return" }] },
    );
  }
  if (ladder.length === 0) return;
  fn.locals.push({ name: "__b10_rk", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } });
  fn.body.unshift({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: regexpTypeIdx },
      { op: "i32.eqz" },
      { op: "br_if", depth: 0 },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: anyStr },
      { op: "i32.eqz" },
      { op: "br_if", depth: 0 },
      // §7.3.2 — an OWN entry (the instance expando bag) shadows the prototype.
      ...(bagHasIdx === undefined
        ? []
        : ([
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: bagHasIdx },
            { op: "br_if", depth: 0 },
          ] satisfies Instr[])),
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStr },
      { op: "call", funcIdx: strFlattenIdx },
      { op: "local.set", index: keyLocal },
      ...ladder,
    ],
  });
}

/**
 * FINALIZE — install the demanded arms. MUST run before
 * `unshiftExternGetProtoCacheArm`, which has to stay `__extern_get`'s prefix.
 */
export function unshiftUntypedRegExpReceiverArms(ctx: CodegenContext): void {
  const state = stateByCtx.get(ctx);
  if (!state) return;
  const regexpTypeIdx = standaloneRegExpStructTypeIdx(ctx);
  if (regexpTypeIdx === undefined) return;
  if (state.gpo) unshiftGetPrototypeOfArm(ctx, state, regexpTypeIdx);
  unshiftExternGetArm(ctx, state, regexpTypeIdx);
}
