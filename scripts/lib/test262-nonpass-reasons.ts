// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7568 — why the rows of an IR edition run do not pass, ranked.
 *
 * Agents read the merge-queue job log, not the artifacts, so the edition
 * report prints this section: per non-pass status the most frequent REASONS,
 * and for compile errors the built-ins whose absence blocks the most rows.
 *
 * A reason is the row's error text through the runner's own normaliser
 * (`normalizeErrorText`, the one behind every row's `error_signature`), then
 * reduced to its cause:
 *   - only the first `; `-separated diagnostic: on the Prepared path every
 *     refusal is followed by the same failure-transport tail;
 *   - no source position, no `[in f() ← g]` call chain, and the compilation
 *     unit (`<module-init>`, the unlowerable unit's name) as `<unit>`;
 *   - a test's `returned N — assert #K at L: <source>` as the assertion called;
 *   - quoted names stay where they are the cause (`identifier "Array" is not
 *     in scope`, `'&'`); values (`got "abc"`, `«1»`, `Actual: …`, quoted
 *     non-names) and single-quoted test-local names (`'arrObj'`) become `…`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeErrorText } from "../../tests/test262-error-signature.ts";

export const NO_MESSAGE = "(no message)";
const TOP_REASONS = 40;
const EXAMPLES = 3;
const TOP_BUILTINS = 20;
const MAX_REASON = 140;
const MAX_LINE = 240;
/** The whole rendered section, headings included. */
const MAX_SECTION_LINES = 120;

const UNIT = "<unit>";
/** Single-quoted words that are the cause, not a test-local name. */
const KEYWORDS = new Set(["this", "super", "arguments"]);
const NAME = /^[A-Za-z_$][\w$.]*$/;

/** The text up to the first `; ` outside parentheses. */
function firstDiagnostic(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0 && text[i + 1] === " ") return text.slice(0, i);
  }
  return text;
}

function assertionCalled(source: string): string {
  const call = /^([\w$.]+)\s*\(\s*([\w$]*)/.exec(source);
  if (!call) return "assertion failed";
  return call[1] === "assert.throws" && call[2]
    ? `assertion failed: assert.throws(${call[2]}, …)`
    : `assertion failed: ${call[1]}(…)`;
}

export function nonPassReason(error: unknown): string {
  if (typeof error !== "string" || !error.trim()) return NO_MESSAGE;
  const unit = /unlowerable unit (\S+?):/.exec(error)?.[1];
  const named = unit
    ? error.replace(new RegExp(`(?<![\\w$])${unit.replace(/[^\w]/g, "\\$&")}(?![\\w$])`, "g"), UNIT)
    : error;
  let text = firstDiagnostic(normalizeErrorText(named))
    .replace(/^L#(?::##)? /, "")
    .replace(/ \[in [^\]]*\]$/, "")
    .replace(/<module-init>(?:__[\w$]+)?|__module_init[\w$]*/g, UNIT)
    .replace(/ (?:in <unit>|\(<unit>\))$/, "");
  const assertion = /^returned # — assert #+ at L#: (.*)$/.exec(text);
  if (assertion) return assertionCalled(assertion[1]);
  text = text
    .replace(/\b(got|expected) "[^"\n]*"/gi, '$1 "…"')
    .replace(/'([^'\n]*)'/g, (all, inner: string) => (NAME.test(inner) && !KEYWORDS.has(inner) ? "'…'" : all))
    .replace(/"([^"\n]*)"/g, (all, inner: string) => (NAME.test(inner) ? all : '"…"'))
    .replace(/«[^»]*»/g, "«…»")
    .replace(/\bActual: .*$/, "Actual: …");
  return clip(text, MAX_REASON);
}

/** Compile-error reasons that name a missing built-in or identifier, and the pattern that names it. */
const MISSING_BUILTIN = [
  /identifier "([^"]+)" is not in scope/,
  /direct call to "([^"]+)"/,
  /unknown class "([^"]+)"/,
  /([\w$.]+) not in IR whitelist/,
  /needs callable provider "?([\w$.]+)/,
  /dynamic operation ((?:new )?[\w$.]+).* has no Prepared intrinsic/,
];

function missingBuiltin(reason: string): string | undefined {
  for (const pattern of MISSING_BUILTIN) {
    const name = pattern.exec(reason)?.[1];
    if (name) return name;
  }
  return undefined;
}

export interface ReasonGroup {
  reason: string;
  count: number;
  /** Of all the edition's rows. */
  share: number;
  /** Rows of this reason whose test includes harness/propertyHelper.js. */
  propertyHelper: number;
  examples: string[];
}

export interface StatusReasons {
  status: string;
  rows: number;
  distinct: number;
  /** Rows of this status whose test includes harness/propertyHelper.js. */
  propertyHelper: number;
  /** The TOP_REASONS most frequent. */
  reasons: ReasonGroup[];
}

export interface NonPassReasons {
  totalRows: number;
  statuses: StatusReasons[];
  missingBuiltins: { name: string; count: number }[];
}

/** Does the test's frontmatter include propertyHelper.js (cached; unreadable = no). */
export function propertyHelperReader(test262Root: string): (file: string) => boolean {
  const seen = new Map<string, boolean>();
  return (file) => {
    let uses = seen.get(file);
    if (uses === undefined) {
      try {
        const source = readFileSync(join(test262Root, file), "utf-8");
        uses = /\/\*---[\s\S]*?propertyHelper\.js[\s\S]*?---\*\//.test(source);
      } catch {
        uses = false;
      }
      seen.set(file, uses);
    }
    return uses;
  };
}

/** Count descending, then name ascending: the section's one order. */
const ranked = <T extends { count: number; name: string }>(items: T[]): T[] =>
  items.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Rank the non-pass rows of `paths` (result rows of any shape; malformed ones are skipped). */
export function buildNonPassReasons(
  rows: readonly unknown[],
  paths: ReadonlySet<string>,
  usesPropertyHelper: (file: string) => boolean,
): NonPassReasons {
  const groups = new Map<string, Map<string, string[]>>();
  const builtins = new Map<string, number>();
  let totalRows = 0;
  for (const row of rows) {
    const { file, status, error } = (row ?? {}) as { file?: unknown; status?: unknown; error?: unknown };
    if (typeof file !== "string" || typeof status !== "string" || !paths.has(file)) continue;
    totalRows++;
    if (status === "pass") continue;
    const reason = nonPassReason(error);
    const byReason = groups.get(status) ?? new Map<string, string[]>();
    groups.set(status, byReason);
    const files = byReason.get(reason) ?? [];
    byReason.set(reason, files);
    files.push(file);
    const name = status === "compile_error" ? missingBuiltin(reason) : undefined;
    if (name) builtins.set(name, (builtins.get(name) ?? 0) + 1);
  }
  const statuses = ranked(
    [...groups].map(([status, byReason]) => {
      const reasons = ranked([...byReason].map(([name, files]) => ({ name, count: files.length, files })));
      const all = reasons.flatMap((g) => g.files);
      return {
        name: status,
        count: all.length,
        distinct: reasons.length,
        propertyHelper: all.filter(usesPropertyHelper).length,
        reasons: reasons.slice(0, TOP_REASONS).map(({ name, count, files }) => ({
          reason: name,
          count,
          share: count / totalRows,
          propertyHelper: files.filter(usesPropertyHelper).length,
          examples: [...files].sort().slice(0, EXAMPLES),
        })),
      };
    }),
  ).map(({ name, count, ...rest }): StatusReasons => ({ status: name, rows: count, ...rest }));
  const missingBuiltins = ranked([...builtins].map(([name, count]) => ({ name, count })));
  return { totalRows, statuses, missingBuiltins };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const cell = (text: string) => text.replace(/\|/g, "\\|");

/**
 * Rows each table may print so the section stays within MAX_SECTION_LINES:
 * each table up to its cap, the lines left shared evenly, a small table's
 * unused share going to the larger ones.
 */
function allocateRows(wanted: readonly number[], budget: number): number[] {
  const out = wanted.map(() => 0);
  let left = budget;
  const order = wanted.map((n, i) => i).sort((a, b) => wanted[a] - wanted[b] || a - b);
  order.forEach((i, k) => {
    out[i] = Math.max(0, Math.min(wanted[i], Math.floor(left / (order.length - k))));
    left -= out[i];
  });
  return out;
}

/** The section as markdown lines (also what the job log shows). */
export function renderNonPassReasons(r: NonPassReasons): string[] {
  const tables = [
    ...r.statuses.map((s) => ({
      heading: `### \`${s.status}\`: ${s.rows} rows (${s.propertyHelper} include propertyHelper.js), ${s.distinct} reasons`,
      header: ["| rows | of all | propertyHelper | reason | example |", "|---:|---:|---:|---|---|"],
      body: s.reasons.map(
        (g) => `| ${g.count} | ${percent(g.share)} | ${g.propertyHelper} | ${cell(g.reason)} | \`${g.examples[0]}\` |`,
      ),
    })),
    {
      heading: `### \`compile_error\`: missing built-in or identifier (${r.missingBuiltins.length} names)`,
      header: ["| rows | name |", "|---:|---|"],
      body: r.missingBuiltins.slice(0, TOP_BUILTINS).map((b) => `| ${b.count} | \`${cell(b.name)}\` |`),
    },
  ];
  const intro = [
    "## Why rows do not pass (#7568)",
    "",
    `Of ${r.totalRows} rows. A reason is the first diagnostic of the error, normalised; ` +
      "full lists and 3 examples per reason are in the JSON report (`nonPassReasons`).",
    "",
  ];
  // Per table: heading, blank, two header lines, a closing blank.
  const fixed = intro.length + tables.length * 5;
  const counts = allocateRows(
    tables.map((t) => t.body.length),
    MAX_SECTION_LINES - fixed,
  );
  const lines = [...intro];
  tables.forEach((t, i) => {
    lines.push(t.heading, "", ...t.header, ...t.body.slice(0, counts[i]), "");
  });
  return lines.map((line) => clip(line, MAX_LINE));
}
