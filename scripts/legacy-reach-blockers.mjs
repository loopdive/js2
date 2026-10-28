// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7143 B1 — which construct blocks each demoted unit, and how many blockers does it have?
 *
 * The selector stops at the FIRST construct it rejects, and an outcome row only
 * carries that one (as `detail`, `"<arm>:<SyntaxKind> «text»"` when
 * `JS2WASM_IR_SHAPE_DIAG=1`). To see whether accepting it would claim the unit,
 * `peelBlocker` replaces the statement that holds the blocker with `0;` (padded
 * so every line:column is unchanged, and accepted by the selector), and the
 * caller recompiles. Repeating that until the unit claims gives its blocker
 * list. A peel is refused where blanking would change scoping or the return
 * value — a declaration, or the unit's last top-level statement — and the list
 * then ends `unpeelable`. Peeling a whole statement also removes any second
 * blocker inside it, so "one blocker" is an upper bound at statement grain.
 */
import { ts } from "../src/ts-api.js";

/** SyntaxKind value → canonical name (skips the `First*`/`Last*` range markers). */
export const KIND_NAMES = new Map();
for (const [name, value] of Object.entries(ts.SyntaxKind)) {
  if (typeof value === "number" && !/^(First|Last)/.test(name) && !KIND_NAMES.has(value)) KIND_NAMES.set(value, name);
}
const canonicalKind = (name) => KIND_NAMES.get(ts.SyntaxKind[name]) ?? name;

/** Demote reasons the census splits (the others already name their blocker). */
export const PEEL_REASONS = new Set(["body-shape-rejected", "class-member-unsupported"]);
const NEUTRAL = "0;";
const DECLARATION = new Set([
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
]);

const ARM_DETAIL = /^([\w-]+):([A-Z]\w*)(?: «(.*)»)?$/s;

/**
 * Stable bucket label of a demoted row: `<arm>:<SyntaxKind>` for selector arms,
 * otherwise the detail with names, quoted text and numbers erased.
 */
export function blockerLabel(row) {
  const detail = row.detail ?? "";
  const arm = ARM_DETAIL.exec(detail);
  if (arm) return `${arm[1]}:${canonicalKind(arm[2])}`;
  if (/rejected by IR selection \(/.test(detail) || !detail) return `${row.reason}:no-detail`;
  const text = detail
    .replace(/^ir\/[\w-]+:\s*/, "")
    .replace(/«[^»]*»|'[^']*'|"[^"]*"|`[^`]*`/g, "…")
    .replace(/\(([^()]*)\)\s*$/, "")
    .replace(/\s+in\s+[\w$<>.:-]+\s*$/, "")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim();
  return `${row.stage ?? "?"}:${text.slice(0, 90)}`;
}

/** First node under `roots` of the detail's SyntaxKind whose text starts with its snippet. */
function locate(roots, sf, detail) {
  const arm = ARM_DETAIL.exec(detail ?? "");
  if (!arm || arm[3] === undefined) return undefined;
  const kind = ts.SyntaxKind[arm[2]];
  const snippet = arm[3];
  let found;
  const visit = (node) => {
    if (found) return;
    if (node.kind === kind && node.getText(sf).replace(/\s+/g, " ").startsWith(snippet)) found = node;
    else ts.forEachChild(node, visit);
  };
  roots.forEach(visit);
  return found;
}

/** Does `stmt` hold a `return` of the enclosing function (not of a nested one)? */
function returnsFrom(stmt) {
  let found = false;
  const visit = (node) => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(stmt);
  return found;
}

const inStatementList = (node) =>
  ts.isBlock(node.parent) || ts.isSourceFile(node.parent) || ts.isCaseOrDefaultClause(node.parent);

/**
 * Blank the statement holding the row's blocker. Returns `{ source }` on
 * success, or `{ refused }` naming why the blocker cannot be peeled.
 */
export function peelBlocker(source, sf, roots, row) {
  const node = locate(roots, sf, row.detail);
  if (!node) return { refused: ARM_DETAIL.test(row.detail ?? "") ? "not-located" : `stage-${row.stage ?? "none"}` };
  let stmt = node;
  while (stmt.parent && !(ts.isStatement(stmt) && inStatementList(stmt))) stmt = stmt.parent;
  if (!stmt.parent || ts.isSourceFile(stmt)) return { refused: "not-in-statement" };
  if (DECLARATION.has(stmt.kind)) return { refused: `declaration:${KIND_NAMES.get(stmt.kind)}` };
  const body = roots.length === 1 && ts.isFunctionLike(roots[0]) ? roots[0].body : undefined;
  if (body && ts.isBlock(body) && body.statements.at(-1) === stmt && returnsFrom(stmt)) {
    return { refused: `tail:${KIND_NAMES.get(stmt.kind)}` };
  }
  const start = stmt.getStart(sf);
  const original = source.slice(start, stmt.end);
  if (original.length < NEUTRAL.length) return { refused: "too-short" };
  const blank = NEUTRAL + original.slice(NEUTRAL.length).replace(/[^\n]/g, " ");
  return { source: source.slice(0, start) + blank + source.slice(stmt.end) };
}

/**
 * Rank blocker labels over demoted rows carrying `blockers` (a list of labels)
 * and `peel` (`claimed` once the list is complete).
 *   first     — units whose first blocker is X
 *   only      — units claimed once X alone is accepted (every blocker is X)
 *   anywhere  — units with X somewhere in their list
 */
export function rankBlockers(rows) {
  const units = rows.filter((r) => r.demoted && PEEL_REASONS.has(r.reason) && r.blockers?.length);
  const buckets = new Map();
  const bucket = (label) => {
    if (!buckets.has(label)) buckets.set(label, { label, first: 0, only: 0, anywhere: 0 });
    return buckets.get(label);
  };
  const multiplicity = { one: 0, two: 0, threePlus: 0, open: 0 };
  const openEnds = {};
  for (const r of units) {
    const distinct = new Set(r.blockers);
    bucket(r.blockers[0]).first++;
    for (const label of distinct) bucket(label).anywhere++;
    if (r.peel !== "claimed") {
      multiplicity.open++;
      openEnds[r.peel] = (openEnds[r.peel] ?? 0) + 1;
      continue;
    }
    if (distinct.size === 1) bucket(r.blockers[0]).only++;
    if (r.blockers.length === 1) multiplicity.one++;
    else if (r.blockers.length === 2) multiplicity.two++;
    else multiplicity.threePlus++;
  }
  const ranked = [...buckets.values()].sort(
    (a, b) => b.only - a.only || b.first - a.first || (a.label < b.label ? -1 : 1),
  );
  return { units: units.length, multiplicity, openEnds, ranked };
}
