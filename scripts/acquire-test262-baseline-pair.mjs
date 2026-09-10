#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitPair, authenticateProducer, digest } from "./admit-test262-baseline-pair.mjs";

const directory = process.argv[2];
if (!directory) throw new Error("usage: acquire-test262-baseline-pair.mjs DIRECTORY");
const receiptPath = join(directory, "admission.json");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const api = (path) => execFileSync("gh", ["api", `repos/loopdive/js2/${path}`], { maxBuffer: 256 * 1024 * 1024 });
try {
  const manifest = json(join(directory, "test262-baseline-pair.json"));
  const commit = process.env.BASELINE_COMMIT;
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("Missing immutable baseline commit");
  const actual = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (actual !== commit) throw new Error("Baseline checkout differs from requested commit");
  const producer = manifest.producer;
  if (!Number.isSafeInteger(producer?.run_id) || !Number.isSafeInteger(producer?.artifact_id))
    throw new Error("Missing producer identifiers");
  for (const [file, endpoint] of [
    ["producer-run.json", `actions/runs/${producer.run_id}`],
    ["producer-artifact.json", `actions/artifacts/${producer.artifact_id}`],
  ])
    writeFileSync(join(directory, file), api(endpoint));
  authenticateProducer(
    manifest,
    json(join(directory, "producer-run.json")),
    json(join(directory, "producer-artifact.json")),
  );
  // Verify the bytes against the immutable Actions artifact, not just a
  // self-consistent metadata/JSONL pair in the baselines checkout.
  const archive = api(`actions/artifacts/${producer.artifact_id}/zip`);
  if (digest(archive) !== producer.artifact_sha256) throw new Error("Producer archive digest mismatch");
  const archivePath = join(directory, "producer.zip");
  writeFileSync(archivePath, archive);
  for (const [lane, member] of [
    ["host", "test262-results-merged.jsonl"],
    ["standalone", "test262-standalone-results-merged.jsonl"],
  ]) {
    const bytes = execFileSync("unzip", ["-p", archivePath, member], { maxBuffer: 256 * 1024 * 1024 });
    if (digest(bytes) !== manifest.lanes?.[lane]?.sha256) throw new Error(`${lane} does not match producer artifact`);
  }
  const boolean = (name) => {
    if (!["true", "false"].includes(process.env[name])) throw new Error(`Unknown candidate setting ${name}`);
    return process.env[name] === "true";
  };
  const corpus = execFileSync("git", ["ls-tree", "HEAD", "test262"], { encoding: "utf8" }).match(
    /^160000 commit ([a-f0-9]{40})\t/,
  )[1];
  const oracle = readFileSync("tests/test262-oracle-version.ts", "utf8").match(
    /export\s+const\s+ORACLE_VERSION\s*=\s*(\d+)/,
  )[1];
  const expected = {
    baselines_commit: commit,
    candidate_sha: process.env.GITHUB_SHA,
    corpus_sha: corpus,
    oracle_version: Number(oracle),
    settings: {
      include_proposals: boolean("INCLUDE_PROPOSALS"),
      semantic_providers: "auto",
      eval_engine: process.env.EVAL_ENGINE,
      compiler_pool_size: Number(process.env.COMPILER_POOL_SIZE),
      ir_first: boolean("IR_FIRST"),
      layout_emit: boolean("LAYOUT_EMIT"),
      native_first: boolean("NATIVE_FIRST"),
    },
  };
  writeFileSync(join(directory, "expectations.json"), `${JSON.stringify(expected, null, 2)}\n`);
  const receipt = admitPair(directory, manifest, expected);
  // Only ancestor baselines are admitted. This is cumulative evidence, not
  // attribution of every delta to the candidate PR.
  execFileSync("git", ["merge-base", "--is-ancestor", manifest.compiler_sha, process.env.GITHUB_SHA]);
  writeFileSync(
    receiptPath,
    `${JSON.stringify({ admitted: true, relationship: "ancestor; cumulative comparison", ...receipt }, null, 2)}\n`,
  );
} catch (error) {
  writeFileSync(receiptPath, `${JSON.stringify({ admitted: false, error: error.message }, null, 2)}\n`);
  throw error;
}
