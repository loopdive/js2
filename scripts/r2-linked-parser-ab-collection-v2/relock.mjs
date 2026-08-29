#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/r2-linked-parser-ab-collection-v2/relock.mjs — #3521 R2-v2 manifest
// relock and bundle-equality gate.
//
// The issue's "Relock, run, and interpretation gates" section requires an
// independent read-only audit of "the exact v2 source/bundle equality,
// manifests, pins, static mutations" BEFORE the one runtime collection. This
// script is the mechanical half of that audit:
//
//   - every adapter source is SHA-256'd;
//   - `bundle/` must mirror each source BYTE FOR BYTE (the executed bytes are
//     pinned to the reviewed bytes);
//   - a root hash is derived over the sorted per-file digests, so a single
//     value fixes the whole adapter; and
//   - the pins and the expected 16+8 census are re-derived from the contract
//     and recorded, so a silent matrix edit changes the manifest.
//
// `--check` (default) verifies; `--update` reseeds the manifest. Reseeding is
// a RELOCK: it is only legitimate as part of an approved review, never as a
// way to make a failing check green.
//
// This script performs no collection. It never spawns a child and never
// invokes the compiler.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const selfDir = dirname(fileURLToPath(import.meta.url));
// Byte-for-byte mirroring means this file also lives in `bundle/`; when run
// from there, the adapter root is the parent directory.
const ROOT = basename(selfDir) === "bundle" ? dirname(selfDir) : selfDir;
const BUNDLE = join(ROOT, "bundle");
const MANIFEST = join(ROOT, "manifest.json");

export const MIRRORED_SOURCES = Object.freeze([
  "contract.mjs",
  "fixtures.mjs",
  "baseline-naive.mjs",
  "selftest.mjs",
  "relock.mjs",
]);

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function buildManifest() {
  const contract = await import(`${join(ROOT, "contract.mjs")}`);
  const sources = {};
  const bundleEqual = {};
  for (const name of MIRRORED_SOURCES) {
    const rootBytes = readFileSync(join(ROOT, name));
    sources[name] = createHash("sha256").update(rootBytes).digest("hex");
    let mirrored;
    try {
      mirrored = readFileSync(join(BUNDLE, name));
    } catch {
      bundleEqual[name] = "MISSING";
      continue;
    }
    bundleEqual[name] = rootBytes.equals(mirrored) ? "EQUAL" : "DIFFERS";
  }

  const rootHash = createHash("sha256")
    .update(
      MIRRORED_SOURCES.slice()
        .sort()
        .map((n) => `${n} ${sources[n]}`)
        .join("\n"),
    )
    .digest("hex");

  return {
    schema: "js2-r2-v2-adapter-manifest-v1",
    adapter: "r2-linked-parser-ab-collection-v2",
    note: "Static validation contract only. Running the 24-child collection requires an approved relock.",
    expectedChildCount: contract.EXPECTED_CHILD_COUNT,
    expectedKeyCensus: contract.expectedKeyCensus(),
    pins: { base: contract.PINS.base, candidate: contract.PINS.candidate, live: "frozen-at-relock" },
    expectedWatAbi: contract.EXPECTED_WAT_ABI,
    sources,
    bundleEqual,
    rootHash,
  };
}

function diffManifest(expected, observed) {
  const problems = [];
  const a = JSON.stringify(expected, Object.keys(expected).sort(), 2);
  const b = JSON.stringify(observed, Object.keys(observed).sort(), 2);
  if (a !== b) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(observed)])) {
      if (JSON.stringify(expected[key]) !== JSON.stringify(observed[key])) {
        problems.push(`manifest field \`${key}\` drifted`);
      }
    }
  }
  return problems;
}

async function main() {
  const update = process.argv.includes("--update");
  const observed = await buildManifest();
  const problems = [];

  for (const [name, state] of Object.entries(observed.bundleEqual)) {
    if (state !== "EQUAL") problems.push(`bundle/${name} is ${state}; the mirror must be byte-for-byte`);
  }

  if (update) {
    if (problems.length > 0) {
      process.stderr.write(`${problems.join("\n")}\n\nrelock refused: fix the bundle mirror first\n`);
      process.exit(1);
    }
    writeFileSync(MANIFEST, `${JSON.stringify(observed, null, 2)}\n`);
    process.stdout.write(`relocked ${MANIFEST}\nrootHash ${observed.rootHash}\n`);
    return;
  }

  let expected;
  try {
    expected = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {
    process.stderr.write("manifest.json is missing or unreadable; run with --update under an approved relock\n");
    process.exit(1);
  }
  problems.push(...diffManifest(expected, observed));

  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n\nR2-v2 adapter relock check FAILED\n`);
    process.exit(1);
  }
  process.stdout.write(`R2-v2 adapter relock check PASSED\nrootHash ${observed.rootHash}\n`);
}

await main();
