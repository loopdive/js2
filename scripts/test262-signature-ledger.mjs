#!/usr/bin/env node
// test262-signature-ledger.mjs — make the cross-PR bucket-signature hint
// LOAD-BEARING (#5280).
//
// WHY THIS EXISTS
// ---------------
// `diff-test262.ts` has printed a stable regression-bucket signature since
// #2098, plus the hint "Same signature on another PR ⇒ identical cluster ⇒
// likely baseline drift". Nothing ever ACTED on it: comparing this run's
// signature against another run's was a human step, performed by opening two
// job logs side by side. On 2026-09-02 the SAME one-row cluster
// (`class-definition-null-proto-super.js`, signature 96690aa5e0efb4ff) parked
// three unrelated PRs — #5479 (run 33626922676), #5480 (33642323854) and
// #5486 (33683869984) — and each park cost a ~20-minute matrix cycle plus a
// hand diagnosis plus a re-admission. Three hand-diagnoses of one row.
//
// The two signals that already exist BOTH pointed the wrong way there:
//   • the #3426 canary quarantine reported `0 observed transitions excluded`,
//     because its manifest was built from two same-SHA canary runs whose 932
//     union-eligible paths do not include this file — the row is flaky, but it
//     was not flaky in those two particular runs;
//   • the #2562 `LIKELY-REAL` banner fired, because it keys off baseline
//     CONTENT-CURRENCY (0 test262-relevant commits behind main). Content
//     currency says nothing about DETERMINISM, so the banner actively argued
//     against the correct call.
// Neither is wrong about what it measures; neither measures repetition across
// unrelated diffs. That is the gap this ledger fills.
//
// WHAT IT DOES — AND DELIBERATELY DOES NOT DO
// -------------------------------------------
// A run's record is {signature, files, pr, run_id, head_sha, changed paths}.
// Records are persisted as ordinary run artifacts named
// `test262-bucket-sig-<signature>`, so looking up prior occurrences is a
// single exact-name artifact query (the same mechanism #1956 uses for
// `test262-group-<sha>`). Artifact retention is 1 day, which is ample: the
// three parks above landed inside nine hours.
//
// The verdict this produces changes the WORDING and the EVIDENCE of the
// failure, never the pass/fail decision:
//
//   first-occurrence        This signature has not been seen on another run.
//                           A signature seen ONCE IS STILL REAL — the gate
//                           keeps its existing verdict untouched. This is the
//                           case that must not be weakened, and it is the
//                           common case for a genuine single-PR regression.
//   repeat-same-pr          Seen before, but on the same PR (a re-run or a
//                           second queue attempt of the same diff). Not
//                           cross-PR evidence; named, not downgraded.
//   overlapping-diff        Seen on another PR whose test262-relevant changed
//                           paths INTERSECT this one's. A shared file is a
//                           plausible shared cause, so this stays a real
//                           regression; the prior occurrence is named so the
//                           two can be triaged together.
//   cross-pr-flake-candidate
//                           Seen on another PR whose test262-relevant changed
//                           paths are DISJOINT from this one's. Two disjoint
//                           diffs cannot both have produced the identical
//                           cluster through the same code path, so the cluster
//                           is a property of the corpus/runner, not of either
//                           diff. THIS is the downgrade: the `LIKELY-REAL`
//                           banner is replaced by a flake-candidate banner
//                           naming the prior run, PR and head sha.
//
// Disjointness is measured over TEST262-RELEVANT paths only (the same filter
// `scripts/test262-paths-match.sh` applies), because those are the only files
// that can move a compiled result. Two PRs that both touch `plan/issues/*.md`
// are still disjoint in the sense that matters here.
//
// USAGE
//   node scripts/test262-signature-ledger.mjs \
//     --signature-file merged-reports/test262-bucket-signature.json \
//     --changed-paths-file /tmp/changed-src-paths.txt \
//     --run-id 33683869984 --pr 5486 --head-sha abc123 --event merge_group \
//     --priors-dir /tmp/sig-priors \
//     --out merged-reports/test262-signature-record.json \
//     --github-output "$GITHUB_OUTPUT"
//
// Exit status is 0 for every verdict — this tool reports, it does not gate.
// It exits 2 only on usage/IO errors, which the caller treats as non-fatal.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Record schema version. Bumped only on an incompatible field change. */
export const LEDGER_SCHEMA_VERSION = 1;

/**
 * Build this run's ledger record.
 *
 * `changedPaths` must already be filtered to test262-relevant paths; the
 * caller owns that filter so the ledger and the #2562 staleness step cannot
 * drift apart on what "relevant" means.
 */
export function buildRecord({ signature, files, event, runId, prNumber, headSha, changedPaths, recordedAt }) {
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    signature,
    file_count: files.length,
    files,
    event,
    run_id: runId ? String(runId) : "",
    pr: prNumber ? String(prNumber) : "",
    head_sha: headSha ?? "",
    changed_paths: [...changedPaths].sort(),
    recorded_at: recordedAt ?? new Date().toISOString(),
  };
}

/** True when two path sets share no member. Empty on either side ⇒ NOT disjoint. */
export function pathsDisjoint(a, b) {
  // An empty changed-path set is unknown provenance, not proven independence:
  // treating "we could not compute the diff" as disjoint would manufacture a
  // downgrade out of a failed git command. Refuse to conclude disjointness.
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return !b.some((p) => set.has(p));
}

/**
 * Classify this run against every prior record carrying the same signature.
 *
 * Priors from THIS run are ignored (a run cannot corroborate itself). The
 * strongest verdict wins, in the order flake-candidate > overlapping-diff >
 * repeat-same-pr > first-occurrence, and the matching prior is returned so the
 * banner can name it.
 */
export function classify(current, priors) {
  const others = priors.filter(
    (p) => p && p.signature === current.signature && String(p.run_id) !== String(current.run_id),
  );
  if (others.length === 0) return { verdict: "first-occurrence", matched: null, priorCount: 0 };

  const differentPr = others.filter((p) => String(p.pr) !== String(current.pr) || !current.pr);
  const disjoint = differentPr.find((p) => pathsDisjoint(current.changed_paths ?? [], p.changed_paths ?? []));
  if (disjoint) return { verdict: "cross-pr-flake-candidate", matched: disjoint, priorCount: others.length };
  if (differentPr.length > 0)
    return { verdict: "overlapping-diff", matched: differentPr[0], priorCount: others.length };
  return { verdict: "repeat-same-pr", matched: others[0], priorCount: others.length };
}

/** Human-readable banner for the gate log. */
export function renderBanner(current, result) {
  const m = result.matched;
  const where = m ? `PR #${m.pr || "?"}, run ${m.run_id || "?"}, head ${(m.head_sha || "?").slice(0, 12)}` : "";
  const line = "===============================================================";
  if (result.verdict === "cross-pr-flake-candidate") {
    return [
      line,
      "  🔁  CROSS-PR FLAKE CANDIDATE (#5280 signature ledger)",
      `  Bucket signature ${current.signature} (${current.file_count} file(s)) already`,
      `  failed on ${where},`,
      "  whose test262-relevant diff is DISJOINT from this one's.",
      "  Two disjoint diffs cannot both have produced the identical",
      "  cluster, so it is a property of the corpus/runner, not of",
      "  either change. This SUPERSEDES the #2562 LIKELY-REAL banner,",
      "  which keys off baseline content-currency and says nothing",
      "  about determinism. Re-admit and, if it recurs, add the row to",
      "  scripts/test262-host-noise-quarantine.json citing this pair.",
      `  Prior occurrence recorded ${m?.recorded_at ?? "?"}.`,
      line,
    ].join("\n");
  }
  if (result.verdict === "overlapping-diff") {
    return [
      line,
      "  ⚠️  SAME SIGNATURE, OVERLAPPING DIFF (#5280 signature ledger)",
      `  Bucket signature ${current.signature} also failed on ${where},`,
      "  but that diff SHARES test262-relevant paths with this one — a",
      "  shared cause is plausible, so this is NOT downgraded. Triage",
      "  the two together.",
      line,
    ].join("\n");
  }
  if (result.verdict === "repeat-same-pr") {
    return [
      line,
      "  ↻  SAME SIGNATURE, SAME PR (#5280 signature ledger)",
      `  This PR already produced signature ${current.signature} on ${where}.`,
      "  A repeat of the same diff is not cross-PR evidence; the",
      "  existing verdict stands.",
      line,
    ].join("\n");
  }
  return [
    `#5280 signature ledger: ${current.signature} not seen on any other recent run —`,
    "  a signature seen once is still real, so the existing verdict stands unchanged.",
  ].join("\n");
}

/** Read every *.json under `dir` (one level deep per artifact) as a record. */
export function readPriors(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  const walk = (d, depth) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          out.push(JSON.parse(readFileSync(full, "utf-8")));
        } catch {
          // A corrupt or half-downloaded prior is evidence we do not have.
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}

function arg(argv, name, fallback = "") {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

function main(argv) {
  const signatureFile = arg(argv, "--signature-file");
  if (!signatureFile || !existsSync(signatureFile)) {
    console.log(
      "#5280 signature ledger: no bucket-signature record for this run (no regressions) — nothing to compare.",
    );
    return 0;
  }
  let sig;
  try {
    sig = JSON.parse(readFileSync(signatureFile, "utf-8"));
  } catch (error) {
    console.log(`#5280 signature ledger: unreadable signature file ${signatureFile}: ${error.message}`);
    return 2;
  }
  const changedPathsFile = arg(argv, "--changed-paths-file");
  let changedPaths = [];
  if (changedPathsFile && existsSync(changedPathsFile)) {
    changedPaths = readFileSync(changedPathsFile, "utf-8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }
  const current = buildRecord({
    signature: sig.signature,
    files: sig.files ?? [],
    event: arg(argv, "--event"),
    runId: arg(argv, "--run-id"),
    prNumber: arg(argv, "--pr"),
    headSha: arg(argv, "--head-sha"),
    changedPaths,
  });

  const result = classify(current, readPriors(arg(argv, "--priors-dir")));
  console.log(renderBanner(current, result));
  console.log(
    `#5280 ledger verdict=${result.verdict} signature=${current.signature} priors=${result.priorCount} ` +
      `changed_relevant_paths=${current.changed_paths.length}`,
  );

  const out = arg(argv, "--out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(current, null, 2)}\n`);
  }
  const ghOut = arg(argv, "--github-output");
  if (ghOut) {
    appendFileSync(
      ghOut,
      [
        `signature=${current.signature}`,
        `verdict=${result.verdict}`,
        `matched_run_id=${result.matched?.run_id ?? ""}`,
        `matched_pr=${result.matched?.pr ?? ""}`,
        `matched_head_sha=${result.matched?.head_sha ?? ""}`,
        "",
      ].join("\n"),
    );
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
