// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3418 — pre-parse dead-binding elision for host-free targets.
 *
 * A top-level `var`/`let`/`const` statement whose every declarator binds a
 * plain identifier to a side-effect-free initializer, and whose names are
 * never mentioned again anywhere in the program — not as an identifier, not
 * as a property name, not as a string/template chunk — is unobservable: no
 * call edge can ever reach the functions inside its initializer. Eliding it
 * before the parser means the unified import collector
 * (`src/codegen/declarations/import-collector.ts`) never even *requests* the
 * host imports referenced by those never-invoked bodies, so no import-index
 * shifting or post-hoc import-section surgery is needed (the exact
 * late-import hazard class of #2043/#1787 is structurally avoided).
 *
 * Motivating case: the test262 literal-harness runtime shim
 * (`scripts/test262-fyi-runtime.js`) prepends
 *
 *   var print = function (value) { console.log(value); };
 *   var $262 = { ..., detachArrayBuffer: function (b) { structuredClone(...) } };
 *
 * to every non-`raw` test. `console.log` / `structuredClone` become `env`
 * imports for EVERY standalone compile even though the vast majority of tests
 * never mention `print` or `$262`, and the #2961 standalone gate then rejects
 * the whole module as host-dependent (~29.8k official rows). With this pass,
 * shim-only tests compile to genuinely host-free binaries; tests that DO use
 * `print`/`$262` keep the bindings and stay honestly host-dependent.
 *
 * The transform is applied uniformly to all standalone/wasi compiles (the
 * caller gates on target — host `gc`/`linear` lanes stay byte-identical). It
 * is deliberately position-preserving: every elided statement is replaced by
 * `;` followed by same-length whitespace (newlines kept), so all downstream
 * positions — diagnostics, source maps, the harness body-line offset — are
 * untouched and the PositionMap is the identity.
 *
 * Conservativeness ladder (any doubt → keep):
 *  - only top-level, non-exported, non-declare variable statements;
 *  - initializers restricted to a small pure grammar (function/arrow
 *    expressions, literals, `undefined`/`globalThis`/`NaN`/`Infinity`,
 *    object/array literals of pure values without spread/shorthand/computed
 *    keys, `!`/`-`/`+`/`~`/`void` of pure, parens/type casts of pure);
 *  - a "mention" is ANY identifier occurrence of the exact name (this
 *    includes property accesses `a.print` — the member name is an
 *    Identifier node — and shadowing declarations), plus any string literal
 *    or template chunk whose cooked text equals the name (blocks
 *    `globalThis["print"]`-style dynamic lookups);
 *  - mentions inside currently-elided statements don't count; the drop set
 *    is computed to a fixpoint so a live statement's mentions always revive
 *    everything it references.
 */
import { forEachChild, ts } from "./ts-api.js";
import { PositionMap } from "./position-map.js";
import { subtreeHasEarlyError } from "./compiler/early-errors/index.js"; // (#4464)

export interface DeadBindingElisionResult {
  source: string;
  /** Identity — the rewrite is strictly same-length. */
  positionMap: PositionMap;
  /** Names of the elided top-level bindings (empty ⇒ source unchanged). */
  elided: string[];
}

interface Candidate {
  stmt: ts.VariableStatement;
  names: string[];
  start: number;
  end: number;
  dropped: boolean;
}

/**
 * `Function.prototype.<name>` where `<name>` is a statically-known key other
 * than `constructor` — the receiver-uncurry idiom test262's propertyHelper.js
 * opens with (`Function.prototype.call.bind(...)`). The value escaping such a
 * chain is an ordinary prototype method, never the `Function` constructor, so
 * it cannot later receive computed source. Counting it as an unknown dynamic
 * identifier revived EVERY dropped harness binding — including the
 * `$262.evalScript` shim, whose own computed `eval` then poisoned the whole
 * module into runtime-eval carrier mode (and linked the interpreter provider)
 * for every propertyHelper-including test. Mirrors
 * `isFunctionPrototypeMethodChain` in `src/ir/runtime-eval-boundary-plan.ts` —
 * keep the two in sync.
 */
function isFunctionPrototypeMethodReceiver(identifier: ts.Identifier): boolean {
  if (identifier.text !== "Function") return false;
  const proto = identifier.parent;
  if (!ts.isPropertyAccessExpression(proto) || proto.expression !== identifier) return false;
  if (proto.name.text !== "prototype") return false;
  const member = proto.parent;
  if (ts.isPropertyAccessExpression(member) && member.expression === proto) {
    return member.name.text !== "constructor";
  }
  if (ts.isElementAccessExpression(member) && member.expression === proto) {
    const key = member.argumentExpression;
    return ts.isStringLiteralLike(key) && key.text !== "constructor";
  }
  return false;
}

const identityResult = (source: string): DeadBindingElisionResult => ({
  source,
  positionMap: PositionMap.identity(),
  elided: [],
});

/**
 * Elide provably-dead top-level pure bindings (see module doc). Same-length
 * whitespace blanking ⇒ identity PositionMap. `scriptKind` must match the
 * grammar the main pipeline will parse with (JS vs TS), so statement extents
 * agree between this analysis parse and the real parse.
 */
export function elideDeadTopLevelBindings(
  source: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS,
): DeadBindingElisionResult {
  // Cheap pre-check before paying for a parse: no var/let/const, nothing to do.
  if (!/\b(?:var|let|const)\b/.test(source)) return identityResult(source);

  const sf = ts.createSourceFile(
    scriptKind === ts.ScriptKind.JS ? "__dce_scan__.js" : "__dce_scan__.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    scriptKind,
  );

  // Bail on any syntax error: statement extents from an error-recovered parse
  // are unreliable, and blanking against them could corrupt the program. (This
  // also guarantees the compiler's "retry as JS" fallback never runs on an
  // elided source — a parse that errors here errors identically in the main
  // pipeline, and we returned the source untouched.)
  const parseDiags = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (parseDiags && parseDiags.length > 0) return identityResult(source);

  // ── Candidates ────────────────────────────────────────────────────
  const candidates: Candidate[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    if (
      mods?.some(
        (m) =>
          m.kind === ts.SyntaxKind.ExportKeyword ||
          m.kind === ts.SyntaxKind.DeclareKeyword ||
          m.kind === ts.SyntaxKind.DefaultKeyword,
      )
    ) {
      continue;
    }
    const names: string[] = [];
    let ok = true;
    for (const decl of stmt.declarationList.declarations) {
      if (
        !ts.isIdentifier(decl.name) ||
        // Binding names that carry strict/module EARLY ERRORS must never be
        // elided: `"use strict"; var eval = 1;` has to keep producing the
        // expected SyntaxError (negative tests). These grammar checks live in
        // the checker's syntactic pass, not parseDiagnostics, so the
        // parse-error bail above does NOT cover them.
        EARLY_ERROR_BINDING_NAMES.has(decl.name.text) ||
        (decl.initializer !== undefined && !isPureInitializer(decl.initializer))
      ) {
        ok = false;
        break;
      }
      names.push(decl.name.text);
    }
    if (!ok || names.length === 0) continue;
    // (#4464) The `EARLY_ERROR_BINDING_NAMES` guard above covers early errors
    // carried by the binding NAME; this covers the ones carried by the
    // INITIALIZER. A dead `var f = function (param, param) { }` under
    // `"use strict"` is still a SyntaxError, and blanking the statement
    // deleted the only evidence of it before the pipeline ever parsed the
    // program — three `negative: phase: parse` tests compiled clean
    // (`13.1-4gs`, `13.1-8gs`, `enable-strict-via-outer-script`). The walk is
    // bounded to candidate statements, i.e. exactly the code about to be
    // deleted, and a false positive costs one un-elided dead binding.
    if (subtreeHasEarlyError(sf, stmt)) continue;
    candidates.push({ stmt, names, start: stmt.getStart(sf), end: stmt.end, dropped: true });
  }
  if (candidates.length === 0) return identityResult(source);

  // name → candidates declaring it (var redeclaration means possibly several).
  const byName = new Map<string, Candidate[]>();
  for (const cand of candidates) {
    for (const name of cand.names) {
      let list = byName.get(name);
      if (!list) byName.set(name, (list = []));
      list.push(cand);
    }
  }

  // ── Mention scan (single walk; fixpoint re-evaluates ownership only) ──
  // A mention is (name, position). Ownership by a candidate statement is
  // positional: candidates are top-level statements, so ranges are disjoint.
  const mentions: { name: string; pos: number }[] = [];
  const unknownDynamicCodePositions: number[] = [];
  const handledDynamicIdentifiers = new Set<number>();
  const record = (name: string, pos: number): void => {
    if (byName.has(name)) mentions.push({ name, pos });
  };
  const containsIdentifier = (sourceText: string, name: string): boolean => {
    let from = 0;
    while (from <= sourceText.length) {
      const at = sourceText.indexOf(name, from);
      if (at < 0) return false;
      const before = at === 0 ? "" : sourceText[at - 1]!;
      const afterAt = at + name.length;
      const after = afterAt >= sourceText.length ? "" : sourceText[afterAt]!;
      const ident = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);
      if (!ident(before) && !ident(after)) return true;
      from = at + name.length;
    }
    return false;
  };
  const recordLiteralDynamicSource = (sourceText: string, pos: number): void => {
    for (const name of byName.keys()) {
      if (containsIdentifier(sourceText, name)) record(name, pos);
    }
    // A literal outer program can itself launch computed dynamic code. Parsing
    // recursively would add a second evaluator to this small pre-pass; keeping
    // every candidate is the sound bounded fallback for that uncommon shape.
    if (containsIdentifier(sourceText, "eval") || containsIdentifier(sourceText, "Function")) {
      unknownDynamicCodePositions.push(pos);
    }
  };
  const unwrapCallee = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = unwrapCallee(node.expression);
      let kind: "eval" | "Function" | undefined;
      let dynamicIdentifier: ts.Identifier | undefined;
      if (ts.isIdentifier(callee) && (callee.text === "eval" || callee.text === "Function")) {
        kind = callee.text;
        dynamicIdentifier = callee;
      } else if (
        ts.isBinaryExpression(callee) &&
        callee.operatorToken.kind === ts.SyntaxKind.CommaToken &&
        ts.isIdentifier(callee.right) &&
        callee.right.text === "eval"
      ) {
        kind = "eval";
        dynamicIdentifier = callee.right;
      }
      if (kind && dynamicIdentifier) {
        handledDynamicIdentifiers.add(dynamicIdentifier.getStart(sf));
        const args = node.arguments ?? [];
        if (kind === "eval") {
          const sourceArg = args[0];
          if (sourceArg && ts.isStringLiteralLike(sourceArg)) {
            recordLiteralDynamicSource(sourceArg.text, node.getStart(sf));
          } else if (sourceArg) {
            unknownDynamicCodePositions.push(node.getStart(sf));
          }
        } else if (args.some((arg) => !ts.isStringLiteralLike(arg))) {
          unknownDynamicCodePositions.push(node.getStart(sf));
        } else {
          for (const arg of args) recordLiteralDynamicSource((arg as ts.StringLiteralLike).text, node.getStart(sf));
        }
      }
    }
    if (ts.isIdentifier(node)) {
      const pos = node.getStart(sf);
      if (
        (node.text === "eval" || node.text === "Function") &&
        !handledDynamicIdentifiers.has(pos) &&
        !isFunctionPrototypeMethodReceiver(node)
      ) {
        // An escaped/aliased evaluator may later receive computed source. This
        // also covers `var Ctor = Function; new Ctor(dynamicBody)` once the
        // alias candidate is revived by its use.
        unknownDynamicCodePositions.push(pos);
      }
      record(node.text, pos);
    } else if (ts.isStringLiteralLike(node)) {
      // StringLiteral | NoSubstitutionTemplateLiteral — cooked text.
      record(node.text, node.getStart(sf));
    } else if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      record((node as ts.TemplateLiteralToken).text, node.getStart(sf));
    }
    forEachChild(node, visit);
  };
  visit(sf);

  const owner = (pos: number): Candidate | undefined => candidates.find((c) => pos >= c.start && pos < c.end);

  // ── Fixpoint: a mention outside every dropped statement revives the name ──
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of mentions) {
      const o = owner(m.pos);
      if (o?.dropped) continue; // inactive — inside an elided statement
      for (const cand of byName.get(m.name) ?? []) {
        // A mention inside a KEPT candidate revives others of the same name;
        // a candidate never revives itself via its own declarator/initializer
        // (those positions are inside its own range, handled above).
        if (cand.dropped && cand !== o) {
          cand.dropped = false;
          changed = true;
        }
      }
    }
  }

  // §19.2.1.1 PerformEval parses its String argument as a Script, and
  // §20.2.1.1.1 CreateDynamicFunction parses parameter/body strings against
  // the current realm's global environment. Computed source can therefore name
  // any candidate without leaving a static mention, so a surviving unknown
  // source keeps everything. Literal source was recorded name-by-name above;
  // treating it as unknown would revive the unused `$262.evalScript` shim,
  // whose own computed eval would then poison every literal-eval compilation.
  // A dynamic call inside a still-dropped candidate cannot execute and does not
  // pin unrelated bindings.
  if (unknownDynamicCodePositions.some((pos) => owner(pos)?.dropped !== true)) {
    for (const cand of candidates) cand.dropped = false;
  }

  const dropped = candidates.filter((c) => c.dropped);
  if (dropped.length === 0) return identityResult(source);

  // ── Blank: `;` + same-length whitespace, newlines preserved ──────────
  let out = source;
  for (const cand of dropped) {
    const region = out.slice(cand.start, cand.end);
    let blank = ";";
    for (let i = 1; i < region.length; i++) {
      const ch = region[i];
      blank += ch === "\n" || ch === "\r" ? ch : " ";
    }
    out = out.slice(0, cand.start) + blank + out.slice(cand.end);
  }

  return {
    source: out,
    positionMap: PositionMap.identity(),
    elided: dropped.flatMap((c) => c.names),
  };
}

/**
 * Binding names whose mere DECLARATION is a strict-mode / module-goal early
 * error (`var eval`, `var arguments`, `let let`, future reserved words, …).
 * Eliding such a statement could turn an expected SyntaxError (negative
 * test262 tests, real user diagnostics) into a silent success.
 */
const EARLY_ERROR_BINDING_NAMES = new Set([
  "eval",
  "arguments",
  "yield",
  "await",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
]);

/** Whitelisted global identifier reads that can never throw or observe. */
const PURE_IDENTIFIER_READS = new Set(["undefined", "globalThis", "NaN", "Infinity"]);

/**
 * Side-effect-free initializer grammar (conservative — anything not listed is
 * impure). Evaluating one of these can neither call user/host code nor throw
 * (no TDZ reads: arbitrary identifier reads are NOT pure; shorthand object
 * properties are excluded for the same reason).
 */
function isPureInitializer(expr: ts.Expression): boolean {
  switch (expr.kind) {
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
    case ts.SyntaxKind.Identifier:
      return PURE_IDENTIFIER_READS.has((expr as ts.Identifier).text);
    case ts.SyntaxKind.ParenthesizedExpression:
      return isPureInitializer((expr as ts.ParenthesizedExpression).expression);
    case ts.SyntaxKind.AsExpression:
    case ts.SyntaxKind.TypeAssertionExpression:
    case ts.SyntaxKind.SatisfiesExpression:
    case ts.SyntaxKind.NonNullExpression:
      return isPureInitializer((expr as ts.AssertionExpression | ts.NonNullExpression).expression);
    case ts.SyntaxKind.VoidExpression:
      return isPureInitializer((expr as ts.VoidExpression).expression);
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const un = expr as ts.PrefixUnaryExpression;
      return (
        (un.operator === ts.SyntaxKind.ExclamationToken ||
          un.operator === ts.SyntaxKind.MinusToken ||
          un.operator === ts.SyntaxKind.PlusToken ||
          un.operator === ts.SyntaxKind.TildeToken) &&
        isPureInitializer(un.operand)
      );
    }
    case ts.SyntaxKind.ArrayLiteralExpression:
      return (expr as ts.ArrayLiteralExpression).elements.every(
        (el) => el.kind === ts.SyntaxKind.OmittedExpression || (!ts.isSpreadElement(el) && isPureInitializer(el)),
      );
    case ts.SyntaxKind.ObjectLiteralExpression:
      return (expr as ts.ObjectLiteralExpression).properties.every((prop) => {
        if (ts.isPropertyAssignment(prop)) {
          return !ts.isComputedPropertyName(prop.name) && isPureInitializer(prop.initializer);
        }
        if (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
          // Defining a method/accessor is pure; only *invoking* it runs code.
          return !ts.isComputedPropertyName(prop.name);
        }
        return false; // shorthand (identifier read) / spread — not pure
      });
    default:
      return false;
  }
}
