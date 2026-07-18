#!/usr/bin/env -S npx tsx
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1217 — Test262 canary diff. Symmetric (no baseline/candidate concept):
// counts tests that flipped pass↔non-pass between two runs of the same SHA.
//
// Usage:
//   npx tsx scripts/test262-canary-diff.ts <run-a.jsonl> <run-b.jsonl>
//   npx tsx scripts/test262-canary-diff.ts <run-a.jsonl> <run-b.jsonl>
//     --write-host-quarantine <manifest.json> <provenance options>
//     [--extend-host-quarantine <existing-manifest.json>]
//
// The script writes a human-readable summary to stdout, and on the LAST
// line writes `FLIP_COUNT=<N>` so a CI step can grep it cheaply.

import { readFileSync, writeFileSync } from "node:fs";

import {
  HOST_NOISE_ELIGIBILITY_POLICY,
  HOST_NOISE_INTERSECTION_POLICY,
  validateHostNoiseQuarantineManifest,
  type HostNoiseCanaryProvenance,
  type HostNoiseObservation,
  type HostNoiseQuarantineManifest,
} from "./diff-test262.js";

interface Entry {
  file: string;
  status: string;
}

interface HostQuarantineEntry {
  path: string;
  run_a_status: string;
  run_b_status: string;
  kind: "pass_flip" | "non_pass_status_noise";
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function loadResults(path: string): Map<string, string> {
  const raw = readFileSync(path, "utf-8");
  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as Partial<Entry>;
      if (typeof d.file === "string" && typeof d.status === "string") {
        // Last write wins — JSONL may contain duplicates from re-runs.
        out.set(d.file, d.status);
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const optionsWithValues = new Set([
    "--write-host-quarantine",
    "--extend-host-quarantine",
    "--run-id",
    "--compiler-sha",
    "--artifact-id",
    "--compiler-pool-size",
  ]);
  const positional = args.filter(
    (arg, index) => !arg.startsWith("--") && !optionsWithValues.has(args[index - 1] ?? ""),
  );
  const [aPath, bPath] = positional;
  if (!aPath || !bPath) {
    console.error(
      "usage: test262-canary-diff.ts <run-a.jsonl> <run-b.jsonl> " +
        "[--write-host-quarantine <manifest.json> --run-id <id> --compiler-sha <40-hex> " +
        "--artifact-id <id> --compiler-pool-size 4 [--extend-host-quarantine <existing-manifest.json>]]",
    );
    process.exit(2);
  }

  const a = loadResults(aPath);
  const b = loadResults(bPath);

  // Walk the union of file paths.
  const files = new Set<string>([...a.keys(), ...b.keys()]);

  // Categorise each test:
  //   - "match"    — same status in both runs
  //   - "flip"     — pass in one, non-pass in the other (the headline metric)
  //   - "noise"    — different non-pass statuses (e.g. fail↔compile_error);
  //                  meaningful only insofar as it shows non-determinism in
  //                  the failure path, separate from the pass↔fail metric
  //   - "missing"  — only in one of the two runs (probably a shard that
  //                  failed to upload an artifact; counted but reported)
  let match = 0;
  let flip = 0;
  let noise = 0;
  let missing = 0;
  const flippedFiles: { file: string; a: string; b: string }[] = [];
  const missingFiles: { file: string; only: "a" | "b"; status: string }[] = [];
  const noiseFiles: { file: string; a: string; b: string }[] = [];

  for (const file of files) {
    const sa = a.get(file);
    const sb = b.get(file);
    if (sa === undefined || sb === undefined) {
      missing++;
      missingFiles.push({
        file,
        only: sa === undefined ? "b" : "a",
        status: (sa ?? sb) as string,
      });
      continue;
    }
    if (sa === sb) {
      match++;
      continue;
    }
    const aPass = sa === "pass";
    const bPass = sb === "pass";
    if (aPass !== bPass) {
      flip++;
      flippedFiles.push({ file, a: sa, b: sb });
    } else {
      noise++;
      noiseFiles.push({ file, a: sa, b: sb });
    }
  }

  console.log("# Test262 canary diff");
  console.log("");
  console.log(`Run A: ${a.size} entries`);
  console.log(`Run B: ${b.size} entries`);
  console.log(`Union: ${files.size} unique test paths`);
  console.log("");
  console.log(`  Match (same status):                 ${match}`);
  console.log(`  Flip (pass <-> non-pass):            ${flip}    <-- THIS IS THE HEADLINE`);
  console.log(`  Noise (different non-pass statuses): ${noise}`);
  console.log(`  Missing (only in one run):           ${missing}`);
  console.log("");

  if (flip > 0) {
    console.log("## Flipped tests (top 20)");
    console.log("");
    for (const f of flippedFiles.slice(0, 20)) {
      console.log(`  ${f.file}: ${f.a} <-> ${f.b}`);
    }
    if (flippedFiles.length > 20) console.log(`  ... ${flippedFiles.length - 20} more`);
    console.log("");
  }

  if (noise > 0) {
    console.log("## Noise (different non-pass statuses, top 10)");
    console.log("");
    for (const f of noiseFiles.slice(0, 10)) {
      console.log(`  ${f.file}: ${f.a} <-> ${f.b}`);
    }
    if (noiseFiles.length > 10) console.log(`  ... ${noiseFiles.length - 10} more`);
    console.log("");
  }

  if (missing > 0) {
    console.log("## Missing in one run (top 10)");
    console.log("");
    for (const f of missingFiles.slice(0, 10)) {
      console.log(`  ${f.file}: only in run-${f.only === "a" ? "b" : "a"} (${f.status})`);
    }
    if (missingFiles.length > 10) console.log(`  ... ${missingFiles.length - 10} more`);
    console.log("");
  }

  const quarantinePath = optionValue(args, "--write-host-quarantine");
  if (quarantinePath) {
    const runId = optionValue(args, "--run-id");
    const compilerSha = optionValue(args, "--compiler-sha");
    const artifactId = optionValue(args, "--artifact-id");
    const compilerPoolSize = optionValue(args, "--compiler-pool-size");
    if (
      !runId ||
      !/^\d+$/.test(runId) ||
      !compilerSha ||
      !/^[0-9a-f]{40}$/.test(compilerSha) ||
      !artifactId ||
      !/^\d+$/.test(artifactId) ||
      compilerPoolSize !== "4"
    ) {
      console.error(
        "--write-host-quarantine requires numeric --run-id/--artifact-id, --compiler-pool-size 4, and a full lowercase 40-hex --compiler-sha",
      );
      process.exit(2);
    }
    if (missing > 0) {
      console.error("refusing to write a host quarantine from incomplete canary runs (missing paths > 0)");
      process.exit(2);
    }

    const currentEntries: HostQuarantineEntry[] = [
      ...flippedFiles.map((entry) => ({
        path: entry.file,
        run_a_status: entry.a,
        run_b_status: entry.b,
        kind: "pass_flip" as const,
      })),
      ...noiseFiles.map((entry) => ({
        path: entry.file,
        run_a_status: entry.a,
        run_b_status: entry.b,
        kind: "non_pass_status_noise" as const,
      })),
    ].sort((left, right) => left.path.localeCompare(right.path));

    const newCanary: HostNoiseCanaryProvenance = {
      canary_run_id: Number(runId),
      compiler_sha: compilerSha,
      artifact_id: Number(artifactId),
      artifact_name: "test262-canary-report",
      compiler_pool_size: Number(compilerPoolSize),
      run_a_entries: a.size,
      run_b_entries: b.size,
      pass_flips: flip,
      non_pass_status_noise: noise,
      unstable_paths: currentEntries.length,
    };

    const canaries: HostNoiseCanaryProvenance[] = [];
    const observationsByPath = new Map<string, HostNoiseObservation[]>();
    const extendPath = optionValue(args, "--extend-host-quarantine");
    if (extendPath) {
      const existingManifest = JSON.parse(readFileSync(extendPath, "utf-8")) as HostNoiseQuarantineManifest;
      const existing = validateHostNoiseQuarantineManifest(existingManifest);
      canaries.push(...existing.manifest.provenance.canaries.map((canary) => ({ ...canary })));
      for (const entry of existing.manifest.entries) {
        observationsByPath.set(
          entry.path,
          entry.observations.map((observation) => ({ ...observation })),
        );
      }
    }
    if (
      canaries.some(
        (canary) => canary.canary_run_id === newCanary.canary_run_id || canary.artifact_id === newCanary.artifact_id,
      )
    ) {
      console.error("refusing to add duplicate host-noise canary run/artifact provenance");
      process.exit(2);
    }
    canaries.push(newCanary);
    canaries.sort((left, right) => left.canary_run_id - right.canary_run_id);

    // Eligibility is the exact union: one complete same-SHA A/B status change
    // is already direct nondeterminism evidence, and independent canaries only
    // sample a sparse subset of scheduler/runtime noise. Observation arrays
    // preserve the intersection so repeatedly reproduced paths remain visible
    // without requiring recurrence to believe the first no-change experiment.
    for (const entry of currentEntries) {
      const observations = observationsByPath.get(entry.path) ?? [];
      observations.push({
        canary_run_id: newCanary.canary_run_id,
        run_a_status: entry.run_a_status,
        run_b_status: entry.run_b_status,
        kind: entry.kind,
      });
      observations.sort((left, right) => left.canary_run_id - right.canary_run_id);
      observationsByPath.set(entry.path, observations);
    }

    const entries = [...observationsByPath]
      .map(([path, observations]) => ({ path, observations }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const passFlipObservations = entries.reduce(
      (count, entry) => count + entry.observations.filter((observation) => observation.kind === "pass_flip").length,
      0,
    );
    const nonPassNoiseObservations = entries.reduce(
      (count, entry) =>
        count + entry.observations.filter((observation) => observation.kind === "non_pass_status_noise").length,
      0,
    );
    const intersectionPaths = entries.filter((entry) => entry.observations.length === canaries.length).length;

    const manifest: HostNoiseQuarantineManifest = {
      schema_version: 2,
      lane: "js-host",
      policy: {
        eligible_paths: HOST_NOISE_ELIGIBILITY_POLICY,
        intersection_paths: HOST_NOISE_INTERSECTION_POLICY,
      },
      provenance: {
        generated_by: "scripts/test262-canary-diff.ts",
        canaries,
      },
      counts: {
        canary_runs: canaries.length,
        pass_flip_observations: passFlipObservations,
        non_pass_status_noise_observations: nonPassNoiseObservations,
        union_paths: entries.length,
        intersection_paths: intersectionPaths,
      },
      entries,
    };
    validateHostNoiseQuarantineManifest(manifest);
    writeFileSync(quarantinePath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(
      `HOST_QUARANTINE_WRITTEN=${quarantinePath} (${entries.length} union exact paths; ${intersectionPaths} in all ${canaries.length} canaries)`,
    );
  }

  // Last line — the CI step greps for this.
  console.log(`FLIP_COUNT=${flip}`);
}

main();
