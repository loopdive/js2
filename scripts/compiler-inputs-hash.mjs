// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Identity of the compiler that compiles the runtime-eval / QuickJS provider
// modules. The provider caches (`.test262-cache/quickjs-eval-adapter-<key>.wasm`,
// `runtime-eval-provider-<key>.wasm`, …) fold this into their key.
//
// Why it exists: the key used to be "provider source + the hash of
// scripts/compiler-bundle.mjs", and with no bundle present (the normal local
// case) the bundle hash was the constant "no-bundle". A compiler change then
// kept the old key, and the stale adapter kept being served as a cache HIT —
// eval-dependent test262 rows failed locally for no reason the compiler could
// explain (a 2026-09-21 adapter of 519,123 bytes vs a fresh 582,453).
//
// The hash covers every input that can change the emitted bytes without
// changing the provider source:
//   - the compiler source tree `src/` (tracked tree id when clean, else a
//     content hash of every file under it),
//   - `pnpm-lock.yaml` (TypeScript / Binaryen versions),
//   - the built compiler bundle, when one exists (it can be stale w.r.t. src/).
// It is cheap (no compile): `git rev-parse` + `git status` take ~20 ms; the
// content-hash fallback reads ~40 MB once. The result is memoised per process
// and per root, because test262 workers compute it on every provider selection.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const sha16 = (data) => createHash("sha256").update(data).digest("hex").slice(0, 16);

/** Run git in `cwd` with a clean env (hooks export GIT_DIR/GIT_INDEX_FILE). */
function git(cwd, args) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Every regular file below `dir`, as sorted `/`-separated paths relative to `root`. */
function listFiles(root, dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Deterministic content hash of every file under `root/dir` (path + bytes). */
export function hashTreeContents(root, dir) {
  const h = createHash("sha256");
  let files;
  try {
    files = listFiles(root, join(root, dir));
  } catch {
    return "absent";
  }
  for (const rel of files) {
    h.update(rel)
      .update("\0")
      .update(
        createHash("sha256")
          .update(readFileSync(join(root, rel)))
          .digest(),
      );
  }
  return `content:${h.digest("hex").slice(0, 16)}`;
}

/**
 * Hash of the `src/` tree. In a git checkout whose `src/` has no modified,
 * untracked or ignored files, the committed tree id is exact and ~free. Any
 * other state (dirty tree, no git, no repo) falls back to hashing the content.
 */
export function hashSourceTree(root, dir = "src", { useGit = true } = {}) {
  if (useGit) {
    try {
      const status = git(root, ["status", "--porcelain", "--untracked-files=all", "--ignored", "--", dir]);
      if (status === "") return `git:${git(root, ["rev-parse", `HEAD:${dir}`])}`;
    } catch {
      // not a git checkout, or src/ not committed — use the content hash
    }
  }
  return hashTreeContents(root, dir);
}

const fileHash = (path) => {
  try {
    return sha16(readFileSync(path));
  } catch {
    return "absent";
  }
};

const memo = new Map();

/**
 * The compiler-inputs hash (16 hex chars). `bundlePaths` are the candidate
 * built-compiler files; the first one that exists is hashed.
 *
 * @param {{root: string, bundlePaths?: string[], useGit?: boolean, memoize?: boolean}} options
 */
export function computeCompilerInputsHash({ root, bundlePaths = [], useGit = true, memoize = true }) {
  const memoKey = JSON.stringify([root, bundlePaths, useGit]);
  if (memoize && memo.has(memoKey)) return memo.get(memoKey);
  let bundle = "no-bundle";
  for (const path of bundlePaths) {
    const h = fileHash(path);
    if (h !== "absent") {
      bundle = h;
      break;
    }
  }
  const parts = [
    `src=${hashSourceTree(root, "src", { useGit })}`,
    `lock=${fileHash(join(root, "pnpm-lock.yaml"))}`,
    `bundle=${bundle}`,
  ];
  const result = sha16(parts.join("\n"));
  if (memoize) memo.set(memoKey, result);
  return result;
}
