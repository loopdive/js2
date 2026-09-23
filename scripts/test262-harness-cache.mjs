// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3451 slice 3) The one place that answers "where do linked-harness provider
// artifacts live" and "was this lane pre-warmed".
//
// It exists as its own module for the reason the Temporal twin does: the shard
// worker and the pre-warm step must not be able to disagree. A pre-warm that
// writes to a different directory than the worker reads is indistinguishable
// from "no pre-warm happened" — every row pays a cold build inside a 30 s fork
// budget, and the run gets slower while reporting success.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `JS2WASM_TEST262_HARNESS_CACHE` is the shared handle: the pre-warm step
 * writes it, the shards read it, and CI can point it at a restored artifact.
 * The tmpdir default keeps a bare in-process run working.
 */
export function test262HarnessProviderCacheDir() {
  return process.env.JS2WASM_TEST262_HARNESS_CACHE ?? join(tmpdir(), "js2wasm-test262-harness-cache");
}

function stampName(target) {
  return `harness-prewarm${target ? `-${target}` : ""}.json`;
}

/**
 * Record which provider keys are present in `cacheDir`.
 *
 * @param {string} cacheDir
 * @param {{ providers: {key: string, namespace: string, bytes: number, buildMs: number, cacheHit: boolean, parts: string}[] }} info
 * @param {string | undefined} [target]
 */
export function writeHarnessPrewarmStamp(cacheDir, info, target) {
  mkdirSync(cacheDir, { recursive: true });
  const stamp = { ...info, target: target ?? null, generatedAt: new Date().toISOString() };
  writeFileSync(join(cacheDir, stampName(target)), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/**
 * Read the pre-warm stamp, or `null` when there is none / it is unreadable.
 *
 * A missing stamp is a NORMAL state, not an error: unlike Temporal's ~40-65 s
 * cold build, a harness provider is 0.7-2.9 s and fits inside a row's budget,
 * so the linked lane does not refuse without one. The stamp is a diagnostic —
 * it lets a slow shard be attributed to a missing pre-warm rather than guessed
 * at.
 */
export function readHarnessPrewarmStamp(cacheDir, target) {
  const path = join(cacheDir, stampName(target));
  if (!existsSync(path)) return null;
  try {
    const stamp = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(stamp?.providers) ? stamp : null;
  } catch {
    return null;
  }
}
