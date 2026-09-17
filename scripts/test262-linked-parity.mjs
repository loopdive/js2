#!/usr/bin/env node
/**
 * (#6486, slice 5 of #3451) Cross-lane test262 parity report.
 *
 * Joins the HONEST rows and the LINKED-harness rows of the SAME run and reports
 * how far apart the two oracles are. It is a MEASUREMENT, not a gate:
 *
 *   - it NEVER exits non-zero on a difference (only on being unable to read its
 *     own inputs, and even then it writes an empty report and exits 0 when
 *     `--allow-missing` is set — the CI job passes that so a run whose host
 *     shards did not happen skips cleanly instead of failing the audit lane);
 *   - it NEVER promotes or rewrites a baseline;
 *   - it deliberately does NOT go through `scripts/diff-test262.ts`. That tool
 *     refuses an unrebased linked-vs-honest comparison on purpose (each lane
 *     diffed against the other's baseline would read oracle skew as
 *     regressions), and that refusal stays. This file is the separate,
 *     clearly-labelled place where the cross-lane comparison is allowed,
 *     because its output can never reach a gate or a published baseline.
 *
 * ROLES ARE A LABEL, LANES ARE THE DATA (#3451 slice 6). The positional
 * arguments are keyed by ORACLE LANE and never change: first the honest-lane
 * rows, then the linked-lane rows. Which of the two is AUTHORITATIVE and which
 * is the AUDIT changed at the slice-6 authority flip, so the role is passed in
 * rather than assumed:
 *
 *   --authoritative-label <honest|linked>   default: honest  (pre-flip)
 *   --audit-label         <honest|linked>   default: linked  (pre-flip)
 *
 * They only affect the Markdown headings. The JSON schema is deliberately
 * UNCHANGED — its fields stay `honest_*` / `linked_*`, i.e. named after the
 * lane, so a report from before and after the flip remains directly readable
 * by the same consumer.
 *
 * Usage:
 *   node scripts/test262-linked-parity.mjs <honest.jsonl> <linked.jsonl> \
 *        [--out linked-results/test262-linked-parity.json] \
 *        [--summary <markdown path, default $GITHUB_STEP_SUMMARY>] \
 *        [--authoritative-label honest|linked] [--audit-label honest|linked] \
 *        [--allow-missing]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Rows are one-per-(file, strict-variant); a file alone is NOT a unique key. */
function rowKey(row) {
  // JSON, not a control-character separator: prettier rewrites a `\u0000`
  // escape into a literal NUL byte, which makes this file binary to git.
  return JSON.stringify([row.file ?? row.path ?? "", row.strict ?? "both"]);
}

/**
 * `oracle_lane` is absent on pre-#3462 rows and means "honest" there, so the
 * normalization has to be explicit rather than a truthiness check.
 */
function laneOf(row) {
  return row.oracle_lane ?? "honest";
}

const LINKED_LANES = new Set(["linked-harness", "linked-harness-fallback"]);

export function parseJsonl(text) {
  const rows = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === "object") rows.push(row);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { rows, malformed };
}

function readJsonl(path) {
  return parseJsonl(readFileSync(path, "utf8"));
}

/** First 80 chars of the error, which is what buckets the difference. */
function bucketOf(row) {
  const error = typeof row?.error === "string" ? row.error : "";
  if (!error) return `(${row?.status ?? "unknown"}, no error text)`;
  return error.replace(/\s+/g, " ").slice(0, 80);
}

function sortedHistogram(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
}

function emptyStatusCounts() {
  return { pass: 0, fail: 0, compile_error: 0, compile_timeout: 0, skip: 0, other: 0, total: 0 };
}

function tally(counts, status) {
  const key =
    Object.prototype.hasOwnProperty.call(counts, status) && status !== "total" && status !== "other" ? status : "other";
  counts[key]++;
  counts.total++;
}

function sumMs(rows, field) {
  let total = 0;
  for (const row of rows) if (typeof row[field] === "number" && Number.isFinite(row[field])) total += row[field];
  return Math.round(total);
}

/**
 * @param honestRows rows from this run's `test262-js-host-shard-*` artifacts
 * @param linkedRows rows from this run's `test262-linked-shard-*` artifacts
 */
export function buildParityReport(honestRows, linkedRows, meta = {}) {
  const honest = new Map();
  const linked = new Map();
  let honestLaneMismatch = 0;
  let linkedLaneMismatch = 0;

  for (const row of honestRows) {
    if (laneOf(row) !== "honest") {
      honestLaneMismatch++;
      continue;
    }
    honest.set(rowKey(row), row);
  }
  for (const row of linkedRows) {
    if (!LINKED_LANES.has(laneOf(row))) {
      linkedLaneMismatch++;
      continue;
    }
    linked.set(rowKey(row), row);
  }

  const honestCounts = emptyStatusCounts();
  const linkedCounts = emptyStatusCounts();
  for (const row of honest.values()) tally(honestCounts, row.status);
  for (const row of linked.values()) tally(linkedCounts, row.status);

  const passToFail = [];
  const failToPass = [];
  const otherDifferences = [];
  const buckets = new Map();
  let common = 0;
  let agreed = 0;

  for (const [key, linkedRow] of linked) {
    const honestRow = honest.get(key);
    if (!honestRow) continue;
    common++;
    if (honestRow.status === linkedRow.status) {
      agreed++;
      continue;
    }
    const entry = {
      file: linkedRow.file ?? linkedRow.path,
      strict: linkedRow.strict ?? "both",
      honest_status: honestRow.status,
      linked_status: linkedRow.status,
      linked_lane: laneOf(linkedRow),
      linked_error: typeof linkedRow.error === "string" ? linkedRow.error.slice(0, 400) : undefined,
      honest_error: typeof honestRow.error === "string" ? honestRow.error.slice(0, 400) : undefined,
    };
    if (honestRow.status === "pass" && linkedRow.status !== "pass") passToFail.push(entry);
    else if (honestRow.status !== "pass" && linkedRow.status === "pass") failToPass.push(entry);
    else otherDifferences.push(entry);
    const bucket = bucketOf(linkedRow.status === "pass" ? honestRow : linkedRow);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }

  // A fallback row is a linked-lane MISS: the body could not be compiled
  // against the harness provider, so the honest assembly produced the verdict.
  // It may well agree with the honest lane — counting it as parity would
  // over-state how much of the corpus the linked oracle actually measured.
  const fallbackReasons = new Map();
  let fallbackRows = 0;
  for (const row of linked.values()) {
    if (laneOf(row) !== "linked-harness-fallback") continue;
    fallbackRows++;
    const reason = row.linked_fallback_reason ?? "(reason not recorded)";
    fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1);
  }

  const linkedOnly = [...linked.keys()].filter((key) => !honest.has(key)).length;
  const honestOnly = [...honest.keys()].filter((key) => !linked.has(key)).length;

  return {
    generated_at: new Date().toISOString(),
    non_authoritative: true,
    note: "Measurement only (#6486). Never gates, never promotes a baseline. diff-test262's cross-lane refusal is untouched.",
    ...meta,
    rows: {
      honest_total: honest.size,
      linked_total: linked.size,
      honest_lane_mismatch: honestLaneMismatch,
      linked_lane_mismatch: linkedLaneMismatch,
      common,
      honest_only: honestOnly,
      linked_only: linkedOnly,
    },
    agreement: {
      agreed,
      differed: common - agreed,
      percent: common === 0 ? null : Math.round((agreed / common) * 10000) / 100,
    },
    status_totals: { honest: honestCounts, linked: linkedCounts },
    fallback: {
      rows: fallbackRows,
      percent_of_linked: linked.size === 0 ? null : Math.round((fallbackRows / linked.size) * 10000) / 100,
      reasons: sortedHistogram(fallbackReasons),
    },
    pass_to_fail: passToFail,
    fail_to_pass: failToPass,
    other_differences: otherDifferences,
    difference_buckets: sortedHistogram(buckets),
    // Row-summed compile/exec time, NOT job wall time — the two are not
    // interchangeable and the Markdown says so explicitly.
    row_time_ms: {
      source: "sum of per-row compile_ms/exec_ms (not job wall time)",
      honest_compile_ms: sumMs([...honest.values()], "compile_ms"),
      honest_exec_ms: sumMs([...honest.values()], "exec_ms"),
      linked_compile_ms: sumMs([...linked.values()], "compile_ms"),
      linked_exec_ms: sumMs([...linked.values()], "exec_ms"),
    },
  };
}

function table(rows) {
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

/**
 * Roles are resolved once and drive every heading. `roles.authoritative` and
 * `roles.audit` are lane names ("honest" | "linked"), so a column header says
 * both which LANE produced the numbers and which ROLE that lane plays.
 */
function resolveRoles(report) {
  const authoritative = report.roles?.authoritative ?? "honest";
  const audit = report.roles?.audit ?? "linked";
  return {
    authoritative,
    audit,
    honest: authoritative === "honest" ? "authoritative" : "audit",
    linked: authoritative === "linked" ? "authoritative" : "audit",
  };
}

export function renderMarkdown(report) {
  const roles = resolveRoles(report);
  const lines = [];
  lines.push(
    `## test262 linked-harness parity (#6486) — authoritative lane: ${roles.authoritative}, audit lane: ${roles.audit}`,
  );
  lines.push("");
  lines.push("Measurement only: this never gates a merge and never promotes a baseline. The report is");
  lines.push(
    `NON-AUTHORITATIVE; the authoritative VERDICTS are the ones this run's \`${roles.authoritative}\` lane produced.`,
  );
  lines.push("`scripts/diff-test262.ts` still refuses an unrebased cross-lane comparison.");
  lines.push("");
  const pct = report.agreement.percent;
  lines.push(
    `**Common rows:** ${report.rows.common} · **agree:** ${report.agreement.agreed}` +
      `${pct === null ? "" : ` (${pct} %)`} · **differ:** ${report.agreement.differed}`,
  );
  lines.push(
    `**Linked rows:** ${report.rows.linked_total} · **honest rows:** ${report.rows.honest_total} · ` +
      `linked-only ${report.rows.linked_only} · honest-only ${report.rows.honest_only}`,
  );
  lines.push("");
  lines.push(`| status | honest (${roles.honest}) | linked (${roles.linked}) |`);
  lines.push("| --- | ---: | ---: |");
  for (const key of ["pass", "fail", "compile_error", "compile_timeout", "skip", "other", "total"]) {
    lines.push(`| ${key} | ${report.status_totals.honest[key]} | ${report.status_totals.linked[key]} |`);
  }
  lines.push("");
  lines.push(
    `### Linked-lane fallbacks: ${report.fallback.rows}` +
      `${report.fallback.percent_of_linked === null ? "" : ` (${report.fallback.percent_of_linked} % of linked rows)`}`,
  );
  lines.push("");
  lines.push("A fallback row was scored by the HONEST assembly, so it is a linked-lane miss, not parity.");
  lines.push("");
  lines.push(
    "Direction of the tables below is fixed by LANE (`honest → linked`), never by role. With the " +
      `${roles.authoritative} lane authoritative, a \`pass → fail\` row is ` +
      (roles.authoritative === "linked"
        ? "one the audit lane passes and the PUBLISHED lane fails."
        : "one the published lane passes and the AUDIT lane fails."),
  );
  lines.push("");
  if (report.fallback.reasons.length > 0) {
    lines.push("| count | reason |");
    lines.push("| ---: | --- |");
    lines.push(table(report.fallback.reasons.slice(0, 20).map((entry) => [String(entry.count), entry.key])));
    lines.push("");
  }
  for (const [title, list] of [
    [`pass → fail (honest [${roles.honest}] pass, linked [${roles.linked}] not)`, report.pass_to_fail],
    [`fail → pass (honest [${roles.honest}] not pass, linked [${roles.linked}] pass)`, report.fail_to_pass],
    ["other status differences", report.other_differences],
  ]) {
    lines.push(`### ${title}: ${list.length}`);
    lines.push("");
    if (list.length > 0) {
      lines.push("| file | strict | honest | linked | linked lane |");
      lines.push("| --- | --- | --- | --- | --- |");
      lines.push(
        table(
          list
            .slice(0, 50)
            .map((entry) => [entry.file, entry.strict, entry.honest_status, entry.linked_status, entry.linked_lane]),
        ),
      );
      if (list.length > 50) lines.push(`| … ${list.length - 50} more (see the JSON artifact) | | | | |`);
      lines.push("");
    }
  }
  if (report.difference_buckets.length > 0) {
    lines.push("### Difference buckets (first 80 chars of the error)");
    lines.push("");
    lines.push("| count | message |");
    lines.push("| ---: | --- |");
    lines.push(table(report.difference_buckets.slice(0, 25).map((entry) => [String(entry.count), entry.key])));
    lines.push("");
  }
  lines.push(`### Row-summed time (${report.row_time_ms.source})`);
  lines.push("");
  lines.push("| lane | compile_ms | exec_ms |");
  lines.push("| --- | ---: | ---: |");
  lines.push(
    `| honest (${roles.honest}) | ${report.row_time_ms.honest_compile_ms} | ${report.row_time_ms.honest_exec_ms} |`,
  );
  lines.push(
    `| linked (${roles.linked}) | ${report.row_time_ms.linked_compile_ms} | ${report.row_time_ms.linked_exec_ms} |`,
  );
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const positional = [];
  const args = {
    out: "linked-results/test262-linked-parity.json",
    summary: process.env.GITHUB_STEP_SUMMARY,
    allowMissing: false,
    // Pre-flip defaults, so an invocation without the flags reads exactly the
    // way it did in slice 5.
    authoritativeLabel: "honest",
    auditLabel: "linked",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i];
    else if (arg === "--summary") args.summary = argv[++i];
    else if (arg === "--authoritative-label") args.authoritativeLabel = argv[++i];
    else if (arg === "--audit-label") args.auditLabel = argv[++i];
    else if (arg === "--allow-missing") args.allowMissing = true;
    else positional.push(arg);
  }
  args.honest = positional[0];
  args.linked = positional[1];
  return args;
}

function writeOut(path, text) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function main(argv) {
  const args = parseArgs(argv);
  const LANES = ["honest", "linked"];
  if (!LANES.includes(args.authoritativeLabel) || !LANES.includes(args.auditLabel)) {
    console.error(
      `--authoritative-label/--audit-label must each be one of ${LANES.join("|")} ` +
        `(got "${args.authoritativeLabel}" / "${args.auditLabel}")`,
    );
    return 2;
  }
  if (args.authoritativeLabel === args.auditLabel) {
    console.error("--authoritative-label and --audit-label must name DIFFERENT lanes");
    return 2;
  }
  if (!args.honest || !args.linked) {
    console.error(
      "usage: test262-linked-parity.mjs <honest.jsonl> <linked.jsonl> [--out f] [--summary f] " +
        "[--authoritative-label honest|linked] [--audit-label honest|linked] [--allow-missing]",
    );
    // Usage errors are the ONE thing worth a non-zero exit; CI never hits it.
    return 2;
  }
  const missing = [args.honest, args.linked].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    const message = `linked parity: missing input(s): ${missing.join(", ")}`;
    console.error(message);
    if (!args.allowMissing) return 2;
    // The host shards did not run in this dispatch — skip cleanly rather than
    // failing a shadow lane whose whole point is to never block anything.
    writeOut(args.out, JSON.stringify({ skipped: true, reason: message, non_authoritative: true }, null, 2) + "\n");
    if (args.summary) appendFileSync(args.summary, `## test262 linked parity (#6486)\n\nSkipped: ${message}\n`);
    return 0;
  }

  const honest = readJsonl(args.honest);
  const linked = readJsonl(args.linked);
  const report = buildParityReport(honest.rows, linked.rows, {
    inputs: { honest: args.honest, linked: args.linked },
    malformed_lines: { honest: honest.malformed, linked: linked.malformed },
    roles: { authoritative: args.authoritativeLabel, audit: args.auditLabel },
  });
  writeOut(args.out, JSON.stringify(report, null, 2) + "\n");
  const markdown = renderMarkdown(report);
  if (args.summary) appendFileSync(args.summary, markdown + "\n");
  console.log(markdown);
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
