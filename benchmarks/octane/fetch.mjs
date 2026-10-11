// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#874) Fetch the pinned Octane sources into the gitignored cache
// `.octane-cache/<commit>/` and verify every file against the SHA256 in
// `manifest.json`. Octane is mixed BSD-3 / MIT / zlib / GPL-2 (deltablue), so
// nothing from it is committed — this script is the only way the harness gets
// its inputs.
//
//   node benchmarks/octane/fetch.mjs            # idempotent: verifies the cache, downloads what is missing
//   node benchmarks/octane/fetch.mjs --force    # re-download everything
//
// Uses raw.githubusercontent.com pinned to a commit (the agent proxy passes raw
// URLs; api.github.com / codeload are blocked). A hash mismatch deletes the bad
// file and exits non-zero — a wrong input must never be benchmarked.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const MANIFEST = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf-8"));
export const CACHE_DIR = join(REPO_ROOT, ".octane-cache", MANIFEST.commit);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Absolute cache path of one pinned Octane file. */
export function cachePath(file) {
  return join(CACHE_DIR, file);
}

/**
 * Ensure every pinned file is cached and verified.
 * @param {{ force?: boolean, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ fetched: string[], cached: string[], bad: string[] }>}
 */
export async function ensureOctaneSources(opts = {}) {
  const log = opts.log ?? ((m) => process.stderr.write(`[octane-fetch] ${m}\n`));
  mkdirSync(CACHE_DIR, { recursive: true });
  const fetched = [];
  const cached = [];
  const bad = [];
  for (const [file, meta] of Object.entries(MANIFEST.files)) {
    const p = cachePath(file);
    if (!opts.force && existsSync(p) && sha256(readFileSync(p)) === meta.sha256) {
      cached.push(file);
      continue;
    }
    const url = MANIFEST.rawUrl.replace("{commit}", MANIFEST.commit).replace("{file}", file);
    let buf;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "js2wasm-octane-fetcher/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      log(`FAILED ${file}: ${e?.message ?? e} (${url})`);
      bad.push(file);
      continue;
    }
    const got = sha256(buf);
    if (got !== meta.sha256) {
      log(`HASH MISMATCH ${file}: expected ${meta.sha256}, got ${got} — not written`);
      if (existsSync(p)) rmSync(p);
      bad.push(file);
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buf);
    fetched.push(file);
  }
  log(
    `${MANIFEST.repo}@${MANIFEST.commit.slice(0, 10)} → ${CACHE_DIR}: ` +
      `${fetched.length} fetched, ${cached.length} already verified, ${bad.length} bad`,
  );
  return { fetched, cached, bad };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { bad } = await ensureOctaneSources({ force: process.argv.includes("--force") });
  if (bad.length) {
    process.stderr.write(`[octane-fetch] FAILED — ${bad.join(", ")}\n`);
    process.exit(1);
  }
  process.stderr.write(`[octane-fetch] OK — all ${Object.keys(MANIFEST.files).length} files verified\n`);
}
