// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export const COMPILE_PROFILE_MARKER = "__JS2_COMPILE_PROFILE__";

type ProfileValue = string | number | boolean | null | undefined;

interface ProfileProcess {
  env?: Record<string, string | undefined>;
  memoryUsage?: () => {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers?: number;
  };
  resourceUsage?: () => { maxRSS: number };
}

function profileProcess(): ProfileProcess | undefined {
  return (globalThis as { process?: ProfileProcess }).process;
}

export function compileProfileEnabled(): boolean {
  return profileProcess()?.env?.JS2WASM_PROFILE_COMPILE === "1";
}

export function compileProfileNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * Emit one machine-readable phase boundary when JS2WASM_PROFILE_COMPILE=1.
 * The max RSS value is Node's process high-water mark; the remaining memory
 * fields are instantaneous samples at the phase boundary.
 */
export function recordCompileProfile(
  phase: string,
  startedAt: number,
  details: Record<string, ProfileValue> = {},
): void {
  if (!compileProfileEnabled()) return;

  try {
    const proc = profileProcess();
    const memory = proc?.memoryUsage?.();
    const resource = proc?.resourceUsage?.();
    const report = {
      phase,
      elapsedMs: Math.round((compileProfileNow() - startedAt) * 100) / 100,
      ...(memory
        ? {
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            heapTotalBytes: memory.heapTotal,
            externalBytes: memory.external,
            arrayBuffersBytes: memory.arrayBuffers ?? 0,
          }
        : {}),
      ...(resource ? { maxRssBytes: resource.maxRSS * 1024 } : {}),
      ...details,
    };
    console.error(`${COMPILE_PROFILE_MARKER}${JSON.stringify(report)}`);
  } catch {
    // Diagnostics must never make compilation fail.
  }
}
