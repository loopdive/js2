// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#743) Which WRITE pins a field fact at DYNAMIC?
 *
 * `runFieldPass` computes a field's fact as the join over every reaching
 * `FieldWrite`, and the emitted result cannot say WHICH contribution dragged
 * the join down — exactly the question the `Parser.pos` program keeps asking
 * per corpus, previously answered by hand-tracing the dist (#743 locals spec
 * §2). `JS2WASM_FNCTOR_FIELD_FACT_TRACE=<filter>` records, for every matching
 * `owner.field`, each write's site, attribution, kind and evaluated
 * contribution from the LAST fixpoint iteration, plus the final fact.
 *
 * Filter grammar: comma-separated `<field>` or `<Owner>.<field>` entries, or
 * `*` for everything. Off by default and free when off — every hook returns
 * before touching anything (house style: `fnctor-field-provenance.ts`).
 *
 * Records are keyed by (owner, field, site position) and OVERWRITTEN each
 * iteration, so the surviving snapshot is the post-convergence one — earlier
 * iterations' optimistic values would misattribute pins.
 */
import { ts } from "../ts-api.js";
import type { IrUnitId } from "./identity.js";
import type { AnalysisState, FieldWrite } from "./fnctor-graph-model.js";
import type { LatticeType } from "./propagate.js";

export interface FieldFactTraceRecord {
  ownerName: string;
  field: string;
  line: number;
  attribution: string;
  kind: FieldWrite["kind"];
  snippet: string;
  contribution: string;
}

const contributions = new Map<string, FieldFactTraceRecord>();
const finals = new Map<string, { ownerName: string; field: string; fact: string }>();
/**
 * Plus-assign RHS values, keyed like `contributions`. A `+=` contribution folds
 * the field's RUNNING fact in via `plusJoin`, so a dynamic contribution does
 * not say whether the WRITE is a root pin or merely downstream of one — the
 * separately-recorded RHS does.
 */
const plusRhs = new Map<string, string>();
let hooked = false;

export function fieldFactTraceEnabled(): boolean {
  return Boolean(process.env.JS2WASM_FNCTOR_FIELD_FACT_TRACE);
}

function matchesFilter(ownerName: string, field: string): boolean {
  const raw = process.env.JS2WASM_FNCTOR_FIELD_FACT_TRACE ?? "";
  for (const entry of raw.split(",")) {
    const f = entry.trim();
    if (f === "") continue;
    if (f === "*" || f === field || f === `${ownerName}.${field}`) return true;
  }
  return false;
}

/** Compact one-line lattice printer — atoms by kind, object atoms by field list. */
export function formatLattice(t: LatticeType): string {
  if (t.kind === "object") return `object{${t.fields.map((f) => f.name).join(",")}}`;
  if (t.kind === "union") return `union(${t.members.map(formatLattice).join("|")})`;
  return t.kind;
}

function ownerNameOf(state: AnalysisState, owner: IrUnitId): string {
  return state.nodes.get(owner)?.name ?? String(owner);
}

export function recordFieldFactContribution(
  state: AnalysisState,
  owner: IrUnitId,
  field: string,
  w: FieldWrite,
  contribution: LatticeType,
): void {
  if (!fieldFactTraceEnabled()) return;
  const ownerName = ownerNameOf(state, owner);
  if (!matchesFilter(ownerName, field)) return;
  const { line } = state.sourceFile.getLineAndCharacterOfPosition(w.site.getStart(state.sourceFile));
  const siteText = w.site.getText(state.sourceFile).replace(/\s+/g, " ");
  contributions.set(`${owner}|${field}|${w.site.pos}`, {
    ownerName,
    field,
    line: line + 1,
    attribution: w.attribution,
    kind: w.kind,
    snippet: siteText.length > 80 ? `${siteText.slice(0, 77)}…` : siteText,
    contribution: formatLattice(contribution),
  });
  if (!hooked) {
    hooked = true;
    process.on("exit", () => process.stderr.write(formatFieldFactTrace()));
  }
}

export function recordFieldFactPlusRhs(
  state: AnalysisState,
  owner: IrUnitId,
  field: string,
  w: FieldWrite,
  rhs: LatticeType,
): void {
  if (!fieldFactTraceEnabled()) return;
  if (!matchesFilter(ownerNameOf(state, owner), field)) return;
  plusRhs.set(`${owner}|${field}|${w.site.pos}`, formatLattice(rhs));
}

export function recordFieldFactFinal(state: AnalysisState, owner: IrUnitId, field: string, fact: LatticeType): void {
  if (!fieldFactTraceEnabled()) return;
  const ownerName = ownerNameOf(state, owner);
  if (!matchesFilter(ownerName, field)) return;
  finals.set(`${owner}|${field}`, { ownerName, field, fact: formatLattice(fact) });
}

/** Test seam — the process-exit hook is not observable from a test. */
export function resetFieldFactTrace(): void {
  contributions.clear();
  finals.clear();
  plusRhs.clear();
}

/** Test seam — read the raw records. */
export function fieldFactTraceRecords(): readonly FieldFactTraceRecord[] {
  return [...contributions.values()];
}

export function formatFieldFactTrace(): string {
  if (contributions.size === 0) return "";
  const byField = new Map<string, { r: FieldFactTraceRecord; rhs?: string }[]>();
  for (const [key, r] of contributions.entries()) {
    const groupKey = `${r.ownerName}.${r.field}`;
    const row = { r, rhs: plusRhs.get(key) };
    const arr = byField.get(groupKey);
    if (arr) arr.push(row);
    else byField.set(groupKey, [row]);
  }
  const lines = ["", "[fnctor-field-fact-trace]"];
  for (const [key, rows] of [...byField.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const final = [...finals.values()].find((f) => `${f.ownerName}.${f.field}` === key);
    lines.push(`  ${key} — final: ${final?.fact ?? "(not recorded)"} over ${rows.length} write(s)`);
    rows.sort((a, b) => a.r.line - b.r.line);
    for (const { r, rhs } of rows) {
      // A `+=` whose RHS is clean is DERIVATIVE (dragged down only by the
      // running fact); a dynamic RHS — or a dynamic plain assign — is a ROOT
      // pin. Only roots need a lever; derivatives clear when the roots do.
      const rhsNote = rhs !== undefined ? ` (rhs → ${rhs})` : "";
      const pin =
        r.contribution !== "dynamic" ? "" : rhs !== undefined && rhs !== "dynamic" ? "  ← derivative" : "  ← PIN";
      lines.push(`    :${r.line} [${r.attribution}/${r.kind}] → ${r.contribution}${rhsNote}${pin}  ${r.snippet}`);
    }
  }
  return lines.join("\n") + "\n";
}
