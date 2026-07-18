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
  const record = (name: string, pos: number): void => {
    if (byName.has(name)) mentions.push({ name, pos });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      record(node.text, node.getStart(sf));
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
