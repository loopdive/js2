// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Repo-relative paths for root tests, so they run in any checkout (a worktree,
// CI's runner) instead of a hardcoded `/workspace/...` path.

import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The test262 submodule checkout; `TEST262_ROOT` overrides it. */
export const TEST262_ROOT = process.env.TEST262_ROOT ?? join(REPO_ROOT, "test262");

/** A CLI installed by a devDependency (binaryen's `wasm-dis`, wabt's `wat2wasm`, ...). */
export function nodeModulesBin(name: string): string {
  return join(REPO_ROOT, "node_modules", ".bin", name);
}
