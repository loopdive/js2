#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3411 — CACHE-SUSPECT guard for the standalone test262 lane.
//
// WHY THIS EXISTS (the false-regression it prevents):
//   Stale-base merge_group runs have been observed to collapse the STANDALONE
//   lane to a byte-identical ~4,508 pass / ~43,469 compile_error, where EVERY
//   compile_error reads `standalone target emitted host imports:
//   env::console_log_externref, env::structuredClone (#2961)` — HOST-lane
//   import signatures recorded under the standalone lane. The collapse is
//   infrastructure poisoning (a stale-base compile-record / lane artifact —
//   see #3411), NOT a code regression: the same byte-identical cluster appears
//   on UNRELATED PRs, fresh-based runs on the same main tip pass, and local
//   standalone compiles emit zero host imports.
//
//   Without this guard the collapse trips the #2097 high-water floor and the
//   #1668 catastrophic-regression guard as a genuine −38,000 standalone
//   regression, which auto-park (#2547) then treats as a real merged-baseline
//   regression and HOLD-labels the (innocent) PR. That strands the PR until a
//   human diagnoses the poison by hand — exactly the parking of two innocent
//   PRs on 2026-07-18.
//
// WHAT IT DOES:
//   Scans the merged standalone results JSONL. If the fraction of non-skip
//   records whose verdict is the #2961 host-import error exceeds THRESHOLD
//   (default 0.90) over a corpus of at least MIN_RECORDS (default 1000), it is
//   the poison signature — no healthy standalone run has ~90% of its corpus as
//   host-import failures. Exit 3 with a loud CACHE-SUSPECT diagnosis so the
//   merge_group fails as INFRASTRUCTURE (re-run the group), distinctly from a
//   real regression. A healthy run (host-import fraction below THRESHOLD) exits
//   0 and the normal floor / regression gates proceed.
//
// Usage:
//   node scripts/check-standalone-cache-poison.mjs --jsonl <merged.jsonl>
//     [--threshold 0.90] [--min-records 1000]
//
// Exit codes:
//   0 — not the poison signature (clean, or too small a corpus to judge).
//   3 — CACHE-SUSPECT: the host-import cluster exceeds THRESHOLD. Infra, re-run.
//   2 — usage / IO error.

import { readFileSync, existsSync } from "node:fs";

// The stable substring of the #2961 verdict emitted by
// `standaloneHostImportError` (tests/test262-runner.ts). Matching the message
// (not a status literal) is robust to whether the verdict is scored
// `compile_error` or another host-import-tagged status.
const HOST_IMPORT_MARKER = "standalone target emitted host imports:";
const ISSUE_TAG = "#2961";

function parseArgs(argv) {
  const args = { jsonl: undefined, threshold: 0.9, minRecords: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--jsonl") args.jsonl = argv[++i];
    else if (a === "--threshold") args.threshold = Number(argv[++i]);
    else if (a === "--min-records") args.minRecords = Number(argv[++i]);
  }
  return args;
}

function main() {
  const { jsonl, threshold, minRecords } = parseArgs(process.argv.slice(2));
  if (!jsonl) {
    process.stderr.write(
      "usage: check-standalone-cache-poison.mjs --jsonl <merged.jsonl> [--threshold 0.9] [--min-records 1000]\n",
    );
    process.exit(2);
  }
  if (!existsSync(jsonl)) {
    // A missing JSONL is not this guard's failure to raise — the upstream merge
    // step (which requires the file to be non-empty) owns that. Pass through.
    process.stderr.write(
      `check-standalone-cache-poison: no JSONL at ${jsonl}; skipping (upstream merge owns file presence).\n`,
    );
    process.exit(0);
  }

  let total = 0; // non-skip records
  let hostImport = 0; // non-skip records with the #2961 host-import verdict
  const text = readFileSync(jsonl, "utf-8");
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      continue; // tolerate a stray non-JSON line
    }
    if (rec.status === "skip") continue;
    total++;
    const err = typeof rec.error === "string" ? rec.error : "";
    if (err.includes(HOST_IMPORT_MARKER) && err.includes(ISSUE_TAG)) hostImport++;
  }

  const fraction = total > 0 ? hostImport / total : 0;
  const pct = (fraction * 100).toFixed(1);
  process.stdout.write(
    `check-standalone-cache-poison: ${hostImport}/${total} non-skip records are #2961 host-import verdicts (${pct}%); ` +
      `threshold ${(threshold * 100).toFixed(0)}%, min-records ${minRecords}.\n`,
  );

  if (total < minRecords) {
    process.stdout.write(`  corpus below min-records (${total} < ${minRecords}) — too small to judge; PASS.\n`);
    process.exit(0);
  }

  if (fraction > threshold) {
    process.stderr.write(
      "\n" +
        "╔══════════════════════════════════════════════════════════════════╗\n" +
        "║  CACHE-SUSPECT: standalone lane host-import collapse (#3411)        ║\n" +
        "╚══════════════════════════════════════════════════════════════════╝\n" +
        `  ${hostImport}/${total} (${pct}%) of non-skip standalone records are the\n` +
        `  #2961 "standalone target emitted host imports" verdict — the stale-base\n` +
        "  merge_group poisoning signature, NOT a code regression.\n\n" +
        "  This is INFRASTRUCTURE: unrelated PRs show the byte-identical cluster,\n" +
        "  fresh-based runs on the same main tip pass, and local standalone\n" +
        "  compiles emit zero host imports. Do NOT treat the standalone floor /\n" +
        "  catastrophic-regression breach below as a real regression or a park.\n\n" +
        "  ACTION: re-run this merge_group on a fresh base (dequeue + re-enqueue\n" +
        "  the single PR). If it recurs on a fresh base, escalate to the tech\n" +
        "  lead — see plan/issues/3411-*.md for the root-cause investigation.\n",
    );
    process.exit(3);
  }

  process.stdout.write("  below threshold — not the poison signature; PASS.\n");
  process.exit(0);
}

main();
