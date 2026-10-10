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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * (#6723 P1) The compiler bundle's identity — the same rule the shard worker
 * stamps on every result row (#1521): `TEST262_BUNDLE_HASH` when CI sets it,
 * else sha256 of the source-runner bundle or the packaged entry beside it.
 *
 * @param {{ env?: Record<string, string | undefined>, scriptsDir?: string }} [opts]
 */
export function test262CompilerBundleHash({ env = process.env, scriptsDir = SCRIPTS_DIR } = {}) {
  const fromEnv = env.TEST262_BUNDLE_HASH;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  for (const file of ["compiler-bundle.mjs", "index.js"]) {
    try {
      return createHash("sha256")
        .update(readFileSync(join(scriptsDir, file)))
        .digest("hex")
        .slice(0, 16);
    } catch {}
  }
  return "no-bundle";
}

/**
 * `JS2WASM_TEST262_HARNESS_CACHE` is the shared handle: the pre-warm step
 * writes it, the shards read it, and CI can point it at a restored artifact.
 * The tmpdir default keeps a bare in-process run working.
 *
 * (#6723 P1) The ROOT (override or default) is always suffixed with
 * `bundle-<compiler bundle hash>`. The provider key hashes the harness prefix
 * and compile options but not the compiler, so a cache built by an older
 * compiler used to be served after a compiler change — it invalidated a local
 * bisect. With the suffix, a different compiler reads a different directory:
 * a stale cache (local tmpdir, or a CI artifact restored across revisions) is
 * a miss, never a wrong provider. Prewarm and shards both call this, so they
 * agree as long as they load the same bundle.
 *
 * @param {{ root?: string, env?: Record<string, string | undefined>, scriptsDir?: string }} [opts]
 */
export function test262HarnessProviderCacheDir({ root, env = process.env, scriptsDir } = {}) {
  const base = root ?? env.JS2WASM_TEST262_HARNESS_CACHE ?? join(tmpdir(), "js2wasm-test262-harness-cache");
  return join(base, `bundle-${test262CompilerBundleHash({ env, scriptsDir })}`);
}

/**
 * (#3451/#6930) The compile options of a linked-harness provider. The worker and
 * the pre-warm step both call this, so they ask for the same cache key.
 *
 * It must match the body's option set (`compileHarnessLinkedBody`), or the pair
 * disagrees about the ABI it shares. (#6723 D4) Both sides carry the harness's
 * `hostBridge: "always"`. (#6930) Both sides carry the semantic-provider
 * policy: a native-first body is in the native regime and imports the #6723 D4
 * Error-family carrier cells, which only a regime provider exports, so a
 * host-assisted prefix linked to a regime body fails every row at instantiate.
 * `semanticProviders` is set only when it is not `auto`, so the host lane's
 * options (and therefore its provider key and bytes) are unchanged.
 *
 * @param {string | undefined} target
 * @param {string} [semanticProviders]
 */
export function harnessProviderCompileOptions(target, semanticProviders = "auto") {
  return {
    hostBridge: "always",
    allowJs: true,
    emitWat: false,
    skipSemanticDiagnostics: true,
    ...(target ? { target } : {}),
    ...(semanticProviders && semanticProviders !== "auto" ? { semanticProviders } : {}),
  };
}

/**
 * (#6930) The provider identity part that the compile options cannot carry.
 * `JS2WASM_NATIVE_REGIME_JS=0` turns the native regime OFF for a native-first
 * compile (`src/target-profile.ts`), but it is an environment read, so it is not
 * in `harnessProviderCacheKey`'s option fingerprint. A regime-off native-first
 * provider gets its own memo key and cache subdirectory so it is never served
 * to a regime body (or the reverse). Empty for every other lane, so the host
 * and standalone cache paths are unchanged.
 *
 * @param {string} [semanticProviders]
 * @param {Record<string, string | undefined>} [env]
 */
export function harnessProviderRegimeTag(semanticProviders = "auto", env = process.env) {
  return semanticProviders === "native-first" && env.JS2WASM_NATIVE_REGIME_JS === "0" ? "native-first-regime-off" : "";
}

/**
 * (#6930) The provider cache directory for one lane: the shared root, plus the
 * regime tag when there is one. The worker and the pre-warm step both call
 * this, so a pre-warmed regime-off provider lands where the worker reads it.
 *
 * @param {{ root?: string, semanticProviders?: string, env?: Record<string, string | undefined> }} [opts]
 */
export function test262HarnessProviderLaneCacheDir({ root, semanticProviders = "auto", env = process.env } = {}) {
  const base = test262HarnessProviderCacheDir({ root, env });
  const tag = harnessProviderRegimeTag(semanticProviders, env);
  return tag ? join(base, tag) : base;
}

/**
 * (#6930) The worker's in-process memo key for one provider: target, policy,
 * regime tag, and the prefix text.
 *
 * @param {string} harnessPrefix
 * @param {string | undefined} target
 * @param {string} [semanticProviders]
 * @param {Record<string, string | undefined>} [env]
 */
export function harnessProviderMemoKey(harnessPrefix, target, semanticProviders = "auto", env = process.env) {
  const policy = semanticProviders ?? "auto";
  return [target ?? "host", policy, harnessProviderRegimeTag(policy, env), harnessPrefix.length, harnessPrefix].join(
    "\u0000",
  );
}

/**
 * (#6723 P1/P2) Which oracle a test262 run uses. Host lane: `fast` / `linked`
 * as before. A non-host lane (standalone, wasi, linear) is honest UNLESS it is
 * the standalone target, the mode is `linked`, AND `TEST262_STANDALONE_LINKED=1`
 * explicitly opts in — the shadow-measurement switch. With the opt-in unset
 * the answer is identical to the pre-#6723 gate
 * (`TEST262_ORACLE_MODE === "linked" && IS_HOST_LANE`).
 *
 * @param {{ oracleMode?: string, target?: string, standaloneLinked?: string }} lane
 * @returns {"honest" | "fast-nativeharness" | "linked-harness"}
 */
export function test262OracleLane({ oracleMode, target, standaloneLinked }) {
  const isHostLane = target === undefined;
  if (oracleMode === "fast" && isHostLane) return "fast-nativeharness";
  if (oracleMode === "linked") {
    if (isHostLane) return "linked-harness";
    if (target === "standalone" && standaloneLinked === "1") return "linked-harness";
  }
  return "honest";
}

function stampName(target, semanticProviders = "auto") {
  const policy = semanticProviders && semanticProviders !== "auto" ? `-${semanticProviders}` : "";
  return `harness-prewarm${target ? `-${target}` : ""}${policy}.json`;
}

/**
 * Record which provider keys are present in `cacheDir`.
 *
 * @param {string} cacheDir
 * @param {{ providers: {key: string, namespace: string, bytes: number, buildMs: number, cacheHit: boolean, parts: string}[] }} info
 * @param {string | undefined} [target]
 * @param {string} [semanticProviders] (#6930) a native-first pre-warm gets its own stamp
 */
export function writeHarnessPrewarmStamp(cacheDir, info, target, semanticProviders = "auto") {
  mkdirSync(cacheDir, { recursive: true });
  const stamp = { ...info, target: target ?? null, semanticProviders, generatedAt: new Date().toISOString() };
  writeFileSync(join(cacheDir, stampName(target, semanticProviders)), `${JSON.stringify(stamp, null, 2)}\n`);
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
export function readHarnessPrewarmStamp(cacheDir, target, semanticProviders = "auto") {
  const path = join(cacheDir, stampName(target, semanticProviders));
  if (!existsSync(path)) return null;
  try {
    const stamp = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(stamp?.providers) ? stamp : null;
  } catch {
    return null;
  }
}
