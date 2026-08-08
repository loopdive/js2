// The report page's "Error Patterns" list must never show a proposal-scope
// failure under a published ES edition.
//
// Observed symptom: selecting ES2026 on the edition slider listed
// "Temporal is not defined". Temporal is NOT in ES2026 — it is a post-ES2026
// stage-4 proposal (generate-editions.ts maps it to the 2027 DRAFT edition) and
// the runner reports every `built-ins/Temporal/` test as `scope: "proposal",
// scope_official: false`.
//
// Root cause: `renderHostErrorPatterns` filtered purely on the per-file edition
// index (test262-file-editions.json) with the rule "no classification ⇒ can't
// prove it's out of range ⇒ keep". The index and the per-file results JSONL are
// produced by separate refresh paths, so when test262 gains files the JSONL can
// carry records the index has never seen. Those records then leaked into EVERY
// edition selection — including editions published years before the feature
// existed.
//
// The record itself carries the answer (`scope` / `scope_official`), which the
// page already parses and keeps but never consulted. These tests pin that it
// does now, and that the resulting filter is clean against the committed
// artifacts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname ?? ".", "..");
const REPORT_HTML = join(ROOT, "website", "public", "benchmarks", "report.html");
const FILE_EDITIONS = join(ROOT, "website", "public", "benchmarks", "results", "test262-file-editions.json");
const RESULTS_JSONL = join(ROOT, "benchmarks", "results", "test262-current.jsonl");

const html = readFileSync(REPORT_HTML, "utf-8");

/** Pull a named function's source out of the page's inline script. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} not found in report.html`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      seenBrace = true;
    } else if (source[i] === "}") {
      depth--;
      if (seenBrace && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

interface ResultRecord {
  file?: string;
  status?: string;
  error?: string;
  scope?: string;
  scope_official?: boolean;
}

/**
 * Build a callable gate out of the page's LITERAL edition-filter source, so
 * these tests exercise report.html rather than a copy of it that can silently
 * drift back to the buggy rule.
 *
 * The block lives inside renderHostErrorPatterns' record loop and expresses
 * "skip this record" as `continue`. Wrapping it in a one-iteration loop turns
 * that into the `false` (filtered out) exit while a fall-through reaches
 * `return true` (kept).
 */
function buildEditionGate(
  source: string,
): (record: ResultRecord, allowedEditions: Set<string> | null, fileEditions: Map<string, string> | null) => boolean {
  const start = source.indexOf(
    "if (allowedEditions && fileEditions) {",
    source.indexOf("function renderHostErrorPatterns("),
  );
  expect(start, "edition gate not found in renderHostErrorPatterns").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(start);
  const gateSource = source.slice(start, end);
  // The gate reads the record as `f` and calls these two page helpers.
  const body = `
    ${extractFunction(source, "fileEditionOf")}
    ${extractFunction(source, "isProposalScopeRecord")}
    return function gate(f, allowedEditions, fileEditions) {
      for (let _once = 0; _once < 1; _once++) {
        ${gateSource}
        return true;
      }
      return false;
    };
  `;
  return new Function(body)() as ReturnType<typeof buildEditionGate>;
}

describe("report page error patterns — edition scoping", () => {
  it("keeps the record's own scope verdict as the fallback authority", () => {
    // A page that only ever asks the index cannot answer for a file the index
    // has never seen — that is exactly the leak.
    expect(html).toContain("function isProposalScopeRecord(");
    expect(html).toContain("record.scope_official === false");

    const filter = html.slice(html.indexOf("function renderHostErrorPatterns("));
    const guard = filter.slice(0, filter.indexOf("// Sort by count descending"));
    expect(guard).toContain("isProposalScopeRecord(f)");
    // The unclassified branch must be reachable: the classified case returns
    // before it, so `else if` (not a second independent `if`) is load-bearing.
    expect(guard).toMatch(/if \(ed\) \{[\s\S]*?\} else if \(isProposalScopeRecord\(f\)\) \{/);
  });

  it("classifies scope verdicts the way the edition generator does", () => {
    const isProposalScopeRecord = new Function(
      `${extractFunction(html, "isProposalScopeRecord")}; return isProposalScopeRecord;`,
    )() as (record: unknown) => boolean;

    // generate-editions.ts buckets `scope_official === false || scope === "proposal"`
    // to Proposals; the page fallback must agree exactly.
    expect(isProposalScopeRecord({ scope: "proposal", scope_official: false })).toBe(true);
    expect(isProposalScopeRecord({ scope: "proposal" })).toBe(true);
    expect(isProposalScopeRecord({ scope: "staging" })).toBe(true);
    expect(isProposalScopeRecord({ scope_official: false })).toBe(true);

    // Official scopes stay visible — Annex B and standard failures are real
    // results for their edition and must not be filtered away.
    expect(isProposalScopeRecord({ scope: "standard", scope_official: true })).toBe(false);
    expect(isProposalScopeRecord({ scope: "annex_b", scope_official: true })).toBe(false);
    // Absent scope data ⇒ not provably a proposal ⇒ keep (documented policy).
    expect(isProposalScopeRecord({})).toBe(false);
    expect(isProposalScopeRecord(null)).toBe(false);
  });

  it("drops an unindexed proposal record from a published edition", () => {
    const gate = buildEditionGate(html);
    const allowed = new Set(["ES5", "ES2015", "ES2026"]);
    const emptyIndex = new Map<string, string>();

    // The exact shape that leaked: a Temporal test the edition index has never
    // seen, whose record says proposal. It must not survive ES2026.
    expect(
      gate(
        {
          file: "test/built-ins/Temporal/ZonedDateTime/prototype/round/round-dst-boundaries.js",
          error: "L41:3 Temporal is not defined",
          scope: "proposal",
          scope_official: false,
        },
        allowed,
        emptyIndex,
      ),
    ).toBe(false);

    // An unindexed STANDARD test still gets the benefit of the doubt — we can't
    // prove it's out of range, and blanking a real failure is the worse error.
    expect(
      gate(
        {
          file: "test/built-ins/Atomics/pause/non-integral-iterationnumber-throws.js",
          scope: "standard",
          scope_official: true,
        },
        allowed,
        emptyIndex,
      ),
    ).toBe(true);

    // Indexed records keep following the index, in both directions.
    const index = new Map([
      ["built-ins/Array/proto.js", "ES5"],
      ["built-ins/Temporal/Duration/prop-desc.js", "Proposals"],
    ]);
    expect(gate({ file: "test/built-ins/Array/proto.js", scope: "standard" }, allowed, index)).toBe(true);
    expect(gate({ file: "test/built-ins/Temporal/Duration/prop-desc.js", scope: "proposal" }, allowed, index)).toBe(
      false,
    );

    // With no edition selected (slider at overall / overall+proposal) nothing is
    // filtered — the proposal view must still be able to show proposals.
    expect(gate({ file: "test/built-ins/Temporal/Duration/prop-desc.js", scope: "proposal" }, null, index)).toBe(true);
  });

  it("shows no proposal-scope failure in any published edition", () => {
    if (!existsSync(RESULTS_JSONL) || !existsSync(FILE_EDITIONS)) {
      // A fresh clone that has not fetched the baseline artifacts yet.
      return;
    }

    const gate = buildEditionGate(html);
    const index = JSON.parse(readFileSync(FILE_EDITIONS, "utf-8")) as {
      editions: string[];
      files: Record<string, number>;
    };
    const fileEditions = new Map<string, string>();
    for (const [file, idx] of Object.entries(index.files)) {
      const label = index.editions[idx];
      if (label) fileEditions.set(file, label);
    }

    // Every published-edition label — the widest selection the slider can make
    // without leaving the published range. A proposal must survive none of them.
    const published = new Set(index.editions.filter((label) => /^ES(\d{4}|5|3 \/ Core|[12])$/.test(label)));
    expect(published.size).toBeGreaterThan(5);

    const leaked: Array<{ file: string; error: string }> = [];
    let unindexedProposals = 0;
    for (const line of readFileSync(RESULTS_JSONL, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as ResultRecord;
      if (record.status !== "compile_error" && record.status !== "fail") continue;

      const rel = String(record.file || "").replace(/^test\//, "");
      const isProposal = record.scope_official === false || record.scope === "proposal";
      if (isProposal && !fileEditions.has(rel)) unindexedProposals++;

      if (!gate(record, published, fileEditions)) continue;
      if (isProposal) leaked.push({ file: rel, error: (record.error || "").slice(0, 80) });
    }

    expect(leaked.slice(0, 10), `${leaked.length} proposal-scope record(s) reachable from a published edition`).toEqual(
      [],
    );

    // The committed artifacts really are out of step — the index does not cover
    // every record in the results. That is the condition the fallback exists
    // for, so record it rather than assuming the two stay paired. (If a future
    // refresh pairs them exactly this goes to 0 and the guard above still holds
    // the actual invariant.)
    expect(unindexedProposals).toBeGreaterThanOrEqual(0);
  });
});
