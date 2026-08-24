// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4604 S3) CLI for the npm-compat staleness guard. Reads the COMMITTED
// artifact and exits non-zero when it is stale, so the scheduled workflow's
// red run — not a manual audit — is what surfaces the next silent-staleness
// episode. Last output line is always a verdict (project convention: the
// verdict survives a bad pipe).
//
//   node scripts/check-npm-compat-freshness.mjs
//   node scripts/check-npm-compat-freshness.mjs --artifact <path> --max-age-hours 12

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { DEFAULT_MAX_AGE_HOURS, judgeNpmCompatFreshness } from "./lib/npm-compat-freshness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const artifactPath = resolve(ROOT, optionValue("--artifact") ?? "benchmarks/results/npm-compat.json");
const maxAgeHours = Number(optionValue("--max-age-hours") ?? DEFAULT_MAX_AGE_HOURS);
if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
  console.error("check-npm-compat-freshness: FAILED — --max-age-hours expects a positive number (exit 2)");
  process.exit(2);
}

let rawJson;
try {
  rawJson = readFileSync(artifactPath, "utf-8");
} catch {
  rawJson = undefined;
}

const verdict = judgeNpmCompatFreshness(rawJson, { nowMs: Date.now(), maxAgeHours });
console.error(`artifact: ${artifactPath}`);
if (verdict.fresh) {
  console.error(`check-npm-compat-freshness: OK — ${verdict.reason} (exit 0)`);
  process.exit(0);
}
console.error(
  "The dashboard is serving stale data. The refresh pipeline is not publishing —",
  "check the newest npm-compat-refresh runs and the ci/npm-compat-refresh promotion PR.",
  "History and playbook: plan/issues/4604-npm-compat-refresh-runtime-exceeds-timeout.md",
);
console.error(`check-npm-compat-freshness: STALE — ${verdict.reason} (exit 1)`);
process.exit(1);
