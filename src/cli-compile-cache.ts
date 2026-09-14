// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6478 — Node's on-disk V8 compile cache for the CLI entry. The CLI loads an
// 18 MB runtime bundle plus TypeScript on every invocation; caching the
// compiled bytecode removes ~0.4 s of a 2.2 s `-O0` run. `enableCompileCache`
// only exists from Node 22.1 while `engines` allows Node 20, so the call is
// optional and wrapped: a missing API, or a read-only cache directory, must
// leave the CLI behaving exactly as before.

/** The slice of `node:module` this helper needs (kept tiny so tests can stub it). */
export interface CompileCacheModule {
  enableCompileCache?: (cacheDir?: string) => unknown;
}

/** Outcome of {@link enableCliCompileCache}; returned for tests/diagnostics, never printed. */
export type CompileCacheOutcome = "enabled" | "opted-out" | "unavailable" | "failed";

/**
 * Best-effort enable of Node's compile cache before the heavy compiler bundle
 * is imported. Honours `NODE_COMPILE_CACHE` (Node's own variable) implicitly;
 * `JS2WASM_NO_COMPILE_CACHE=1` opts out entirely.
 */
export function enableCliCompileCache(
  mod: CompileCacheModule,
  env: Record<string, string | undefined> = process.env,
): CompileCacheOutcome {
  if (env.JS2WASM_NO_COMPILE_CACHE === "1") return "opted-out";
  const enable = mod.enableCompileCache;
  if (typeof enable !== "function") return "unavailable";
  try {
    enable();
    return "enabled";
  } catch {
    // Read-only tmpdir, sandboxed FS, unsupported build — never fatal.
    return "failed";
  }
}
