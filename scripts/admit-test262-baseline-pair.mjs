#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Measurement-only admission, not a comparator or baseline publisher.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const statuses = ["pass", "fail", "compile_error", "compile_timeout", "skip"];
const filenames = {
  host: "test262-current.jsonl",
  standalone: "test262-standalone-current.jsonl",
};
const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireThat(condition, message) {
  if (!condition) throw new Error(`Baseline admission: ${message}`);
}

// All producer fields must come from the immutable producer receipt, never
// from candidate expectations. Counts include proposals and ALL failure rows.
export function admitPair(directory, manifest, expected) {
  requireThat(manifest.schema === 1, "unsupported/missing schema");
  if (expected.artifact_id !== undefined) {
    requireThat(
      expected.baselines_commit === undefined &&
        Number.isSafeInteger(expected.artifact_id) &&
        expected.artifact_id === manifest.producer?.artifact_id,
      "unpinned/mismatched original artifact",
    );
    requireThat(
      sha.test(expected.receipt_commit ?? "") && expected.receipt_commit === expected.candidate_sha,
      "unbound reviewed receipt",
    );
  } else requireThat(sha.test(expected.baselines_commit ?? ""), "unpinned baselines commit");
  requireThat(sha.test(manifest.compiler_sha ?? ""), "missing compiler SHA");
  requireThat(sha.test(expected.candidate_sha ?? ""), "missing candidate SHA");
  requireThat(sha.test(expected.corpus_sha ?? ""), "missing candidate corpus");
  requireThat(manifest.corpus_sha === expected.corpus_sha, "corpus mismatch");
  requireThat(Number.isInteger(expected.oracle_version), "missing candidate oracle");
  requireThat(manifest.oracle_version === expected.oracle_version, "oracle mismatch");
  const producer = manifest.producer;
  requireThat(producer?.repository === "loopdive/js2", "unknown producer repository");
  requireThat(Number.isSafeInteger(producer.run_id) && producer.run_id > 0, "missing producer run");
  requireThat(Number.isSafeInteger(producer.artifact_id) && producer.artifact_id > 0, "missing producer artifact");
  requireThat(hash.test(producer.artifact_sha256 ?? ""), "missing artifact digest");
  requireThat(
    typeof producer.workflow === "string" && producer.workflow.startsWith(".github/workflows/"),
    "missing producer workflow",
  );
  for (const key of [
    "include_proposals",
    "semantic_providers",
    "eval_engine",
    "compiler_pool_size",
    "ir_first",
    "layout_emit",
    "native_first",
  ]) {
    requireThat(
      expected.settings?.[key] !== undefined && manifest.settings?.[key] !== undefined,
      `unknown setting ${key}`,
    );
    requireThat(manifest.settings[key] === expected.settings[key], `setting mismatch: ${key}`);
  }
  requireThat(manifest.settings.semantic_providers === "auto", "unsupported provider policy");
  requireThat(typeof manifest.settings.include_proposals === "boolean", "unknown proposal scope");
  requireThat(["quickjs", "interpreter"].includes(manifest.settings.eval_engine), "unknown eval engine");
  requireThat(
    Number.isSafeInteger(manifest.settings.compiler_pool_size) && manifest.settings.compiler_pool_size > 0,
    "unknown compiler pool size",
  );
  requireThat(
    manifest.settings.native_first === false &&
      manifest.settings.ir_first === false &&
      manifest.settings.layout_emit === false,
    "unsupported experimental lane",
  );
  const receipt = {
    schema: 1,
    baselines_commit: expected.baselines_commit,
    artifact_id: expected.artifact_id,
    receipt_commit: expected.receipt_commit,
    compiler_sha: manifest.compiler_sha,
    candidate_sha: expected.candidate_sha,
    corpus_sha: manifest.corpus_sha,
    producer,
    settings: manifest.settings,
    lanes: {},
  };
  let firstPaths;
  for (const [lane, filename] of Object.entries(filenames)) {
    const evidence = manifest.lanes?.[lane];
    requireThat(evidence?.lane === lane && evidence.file === filename, `missing/swapped ${lane} producer identity`);
    requireThat(hash.test(evidence.sha256 ?? ""), `missing ${lane} hash`);
    const bytes = readFileSync(join(directory, filename));
    requireThat(bytes.length > 0 && digest(bytes) === evidence.sha256, `${lane} empty/hash mismatch`);
    const lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
    const paths = new Set();
    for (const line of lines) {
      const row = JSON.parse(line);
      requireThat(
        typeof row.file === "string" && row.file.startsWith("test/") && !paths.has(row.file),
        `${lane} invalid/duplicate path`,
      );
      requireThat(statuses.includes(row.status), `${lane} unknown status`);
      requireThat(
        row.oracle_version === manifest.oracle_version &&
          row.oracle_lane === "honest" &&
          row.semantic_providers === manifest.settings.semantic_providers,
        `${lane} unstamped/mixed oracle or provider`,
      );
      paths.add(row.file);
      counts[row.status]++;
    }
    requireThat(
      Number.isSafeInteger(evidence.total) && evidence.total > 0 && evidence.total === paths.size,
      `${lane} population mismatch`,
    );
    for (const status of statuses)
      requireThat(evidence.counts?.[status] === counts[status], `${lane} count mismatch: ${status}`);
    // Producer registration evidence is mandatory, not inferred from the rows.
    requireThat(
      evidence.registered === evidence.total && evidence.verdicts === evidence.total && evidence.excluded === 0,
      `${lane} incomplete producer population`,
    );
    if (firstPaths)
      requireThat(
        paths.size === firstPaths.size && [...paths].every((path) => firstPaths.has(path)),
        "lane path sets differ",
      );
    firstPaths = paths;
    receipt.lanes[lane] = { ...evidence, counts };
  }
  return receipt;
}

// Producer API evidence is independently fetched by the acquisition job.
export function authenticateProducer(manifest, run, artifact) {
  const p = manifest.producer;
  requireThat(
    run.id === p.run_id &&
      run.head_sha === manifest.compiler_sha &&
      run.path === p.workflow &&
      run.status === "completed",
    "producer run mismatch/incomplete",
  );
  requireThat(run.repository?.full_name === p.repository, "producer run repository mismatch");
  requireThat(
    artifact.id === p.artifact_id &&
      artifact.workflow_run?.id === p.run_id &&
      artifact.workflow_run?.head_sha === manifest.compiler_sha &&
      artifact.digest === `sha256:${p.artifact_sha256}` &&
      artifact.expired === false,
    "producer artifact mismatch/expired",
  );
}

export function validateCandidate(baselinePath, candidatePath, manifest) {
  const rows = (path) =>
    readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  const baseline = new Set(rows(baselinePath).map((row) => row.file));
  const candidate = rows(candidatePath);
  const paths = new Set(candidate.map((row) => row.file));
  requireThat(
    paths.size === candidate.length && paths.size === baseline.size && [...paths].every((path) => baseline.has(path)),
    "candidate population differs from admitted baseline",
  );
  for (const row of candidate)
    requireThat(
      statuses.includes(row.status) &&
        row.oracle_version === manifest.oracle_version &&
        row.oracle_lane === "honest" &&
        row.semantic_providers === manifest.settings.semantic_providers,
      "candidate verdict/oracle/provider mismatch",
    );
}

function main() {
  const [directory, expectationsPath, receiptPath, hostCandidate, standaloneCandidate] = process.argv.slice(2);
  if (!directory || !expectationsPath || !receiptPath)
    throw new Error("usage: admit-test262-baseline-pair.mjs DIRECTORY EXPECTATIONS RECEIPT");
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  try {
    const manifest = read(join(directory, "test262-baseline-pair.json"));
    authenticateProducer(
      manifest,
      read(join(directory, "producer-run.json")),
      read(join(directory, "producer-artifact.json")),
    );
    const receipt = admitPair(directory, manifest, read(expectationsPath));
    if (hostCandidate) validateCandidate(join(directory, filenames.host), hostCandidate, manifest);
    if (standaloneCandidate) validateCandidate(join(directory, filenames.standalone), standaloneCandidate, manifest);
    writeFileSync(receiptPath, `${JSON.stringify({ admitted: true, ...receipt }, null, 2)}\n`);
  } catch (error) {
    writeFileSync(receiptPath, `${JSON.stringify({ admitted: false, error: error.message }, null, 2)}\n`);
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
