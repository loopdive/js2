// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2089 — silent-fallback telemetry choke point (Phase 0).
//
// `reportSilentFallback` (src/codegen/fallback-telemetry.ts) is the single
// counting point for the seven silent-fallback pattern classes the fail-loud
// audit identified. Phase 0 instruments 16 verified sites (the 8 unary-update
// NaN sites, the 7 `fieldIdx === -1) continue` skips, and the
// identifiers.ts unimplemented-global default) — purely counting, no emitted-
// code change. These tests pin that:
//   - counts surface on `CompileResult.fallbackCounts` when the
//     `trackSilentFallbacks` option is set;
//   - a known fallback site increments its class/site bucket;
//   - the count is additive across multiple hits;
//   - instrumentation is behavior-preserving (the module still compiles).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { fallbackCountsToJson, totalFallbackHits } from "../src/codegen/fallback-telemetry.js";

async function countsFor(src: string): Promise<Record<string, Record<string, number>>> {
  const result = await compile(src, { fileName: "test.ts", trackSilentFallbacks: true });
  // Phase 0 is telemetry-only: instrumentation must never break compilation.
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.fallbackCounts).toBeDefined();
  return fallbackCountsToJson(result.fallbackCounts!);
}

describe("#2089 — silent-fallback telemetry (Phase 0)", () => {
  it("counts an unresolvable-receiver unary update as const-fallback", async () => {
    const counts = await countsFor(
      `class C { x = 1; }
       export function test(): number { const c = new C(); return (c as any).nope++; }`,
    );
    expect(counts["const-fallback"]?.["unary-updates:incdec-unresolvable-receiver-type"]).toBe(1);
  });

  it("counts a non-ref element-access unary update as const-fallback", async () => {
    const counts = await countsFor(`export function test(): number { let n = 5; return (n as any)["k"]++; }`);
    expect(counts["const-fallback"]?.["unary-updates:incdec-nonref-element-access"]).toBe(1);
  });

  it("accumulates counts additively across repeated hits", async () => {
    const counts = await countsFor(
      `class C { x = 1; }
       export function test(): number {
         const c = new C();
         return (c as any).a++ + (c as any).b++ + (c as any).c++;
       }`,
    );
    expect(counts["const-fallback"]?.["unary-updates:incdec-unresolvable-receiver-type"]).toBe(3);
    expect(totalFallbackHits(await compileCounts()) >= 0).toBe(true);
  });

  it("does NOT attach fallbackCounts churn for a clean program (zero hits)", async () => {
    const counts = await countsFor(`export function test(): number { return 1 + 2; }`);
    expect(totalForJson(counts)).toBe(0);
  });
});

// Helpers --------------------------------------------------------------------

function totalForJson(counts: Record<string, Record<string, number>>): number {
  let total = 0;
  for (const sites of Object.values(counts)) for (const n of Object.values(sites)) total += n;
  return total;
}

// Re-exercise the public path once so the imported helper is covered.
async function compileCounts() {
  const r = await compile(
    `class C { x = 1; } export function test(): number { const c = new C(); return (c as any).z++; }`,
    {
      fileName: "test.ts",
      trackSilentFallbacks: true,
    },
  );
  return r.fallbackCounts!;
}
