// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6492 round 28 / #6504 — the try/catch async analysis must run its shape
 * predicates WITH a checker.
 *
 * `asyncFnNeedsHostDrive` gives a body two chances: `planLinearAwaits`, then the
 * try/catch analysis (`tryCatchAsyncSpillInfo` / `planTryCatchCfg` →
 * `analyzeTryCatchAsync` → `lowerRegionBody` → `lowerChunk`). The second one
 * built its `LowerState` with **no** checker, so
 * `replaySafeNestedCallAwait`'s first line (`checker === undefined`) rejected
 * every candidate on that path regardless of its shape. Instrumented over 2,212
 * async rows (#6492 round 26) that was the single largest decline bucket —
 * 31 of 71 declines with `anyRealSuspension` true — and it is a threading gap,
 * not a shape rejection.
 *
 * The regression this guards is a silent one: with the checker missing the
 * planner still returns a plan, so nothing throws and no row count moves. Only
 * the DECLINE REASON changes. So the assertions here are on the predicate's
 * inputs, not on a compiled artifact: `lowerChunk` and every recursive step
 * above it must accept and forward a checker, and the two exported entry points
 * must expose the parameter their callers fill from `ctx.checker`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeTryCatchAsync, planTryCatchCfg, tryCatchAsyncSpillInfo } from "../src/codegen/async-cps.js";

const SRC_DIR = join(import.meta.dirname ?? ".", "..", "src", "codegen");
const asyncCps = readFileSync(join(SRC_DIR, "async-cps.ts"), "utf8");
const asyncFrame = readFileSync(join(SRC_DIR, "async-frame.ts"), "utf8");

describe("#6492 r28 — the try/catch async analysis is checker-threaded", () => {
  it("exposes a checker parameter on all three exported entry points", () => {
    // Arity is the observable contract: each gained ONE trailing optional
    // parameter after `hoist`.
    expect(analyzeTryCatchAsync.length).toBeGreaterThanOrEqual(2);
    expect(planTryCatchCfg.length).toBeGreaterThanOrEqual(2);
    expect(tryCatchAsyncSpillInfo.length).toBeGreaterThanOrEqual(2);
    for (const fn of ["analyzeTryCatchAsync", "planTryCatchCfg", "tryCatchAsyncSpillInfo"]) {
      const sig = asyncCps.slice(asyncCps.indexOf(`export function ${fn}(`));
      const params = sig.slice(0, sig.indexOf(")"));
      expect(params, `${fn} must accept a checker`).toContain("checker?: ts.TypeChecker");
    }
  });

  it("builds lowerChunk's LowerState with the threaded checker, never undefined", () => {
    const start = asyncCps.indexOf("function lowerChunk(");
    expect(start).toBeGreaterThan(-1);
    const body = asyncCps.slice(start, asyncCps.indexOf("\n}", start));
    expect(body).toContain("checker?: ts.TypeChecker");
    // The `LowerState` literal must carry the parameter through. Without this
    // line `replaySafeNestedCallAwait` is dead on this whole path.
    expect(body).toMatch(/\n\s*checker,\n/);
  });

  it("forwards the checker through every recursive step", () => {
    // Each recursive call must pass it on; a single unforwarded site silently
    // restores the gap for the sub-tree under it.
    const region = asyncCps.slice(
      asyncCps.indexOf("function lowerRegionBody("),
      asyncCps.indexOf("export function analyzeTryCatchAsync("),
    );
    const chunkCalls = region.match(/lowerChunk\(.*/g) ?? [];
    expect(chunkCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of chunkCalls) expect(call).toContain("checker");
    const regionCalls = (region.match(/lowerRegionBody\(.*/g) ?? []).filter((c) => c !== "lowerRegionBody(");
    expect(regionCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of regionCalls) expect(call).toContain("checker");
  });

  it("is filled from ctx.checker at every drive-layer call site", () => {
    expect(asyncFrame).toContain("tryCatchAsyncSpillInfo(decl, plan, isHostAsyncLane(ctx), ctx.checker)");
    expect(asyncFrame).toContain("loopAsyncSpillInfo(decl, plan, ctx.checker)");
    expect(asyncCps).toContain("planTryCatchCfg(fn, plan, isHostAsyncLane(ctx), ctx.checker)");
    expect(asyncCps).toContain("planWhileLoopCfg(fn, plan, ctx.checker)");
  });

  /**
   * Accepting the parameter is not the same as USING it. The first cut of this
   * fix added `checker?: ts.TypeChecker` to `tryCatchAsyncSpillInfo`'s signature
   * and left its body calling `analyzeTryCatchAsync(fn, plan, hoist)` — three
   * arguments, checker dropped. Nothing failed: the plan still came back, no
   * row count moved, and the arity assertions above still passed. The only
   * visible symptom was the decline bucket, which no gate reads. So assert the
   * forwarding itself.
   */
  it("forwards the checker out of every exported entry point's BODY", () => {
    for (const fn of ["planTryCatchCfg", "tryCatchAsyncSpillInfo"]) {
      const start = asyncCps.indexOf(`export function ${fn}(`);
      // Slice generously: `tryCatchAsyncSpillInfo`'s RETURN TYPE is a
      // multi-line object literal, so the first `\n}` after the declaration is
      // the type's brace, not the body's.
      const body = asyncCps.slice(start, start + 2000);
      expect(body, `${fn} must forward the checker`).toContain("analyzeTryCatchAsync(fn, plan, hoist, checker)");
    }
    for (const fn of ["planWhileLoopCfg", "loopAsyncSpillInfo"]) {
      const start = asyncCps.indexOf(`function ${fn}(`);
      const body = asyncCps.slice(start, start + 2000);
      expect(body, `${fn} must forward the checker`).toContain("analyzeWhileAsync(fn, plan, checker)");
    }
  });

  /**
   * The spill-set computation and the plan builder must make the SAME shape
   * decision — a shape one admits and the other does not is a frame whose live
   * values have no field. They are paired by construction, so they must be
   * paired in their checker argument too.
   */
  it("pairs each plan builder with its spill-info twin", () => {
    expect(asyncCps).toContain("loopAsyncSpillInfo(\n  fn: ts.FunctionLikeDeclaration,");
    const pairs: [string, string][] = [
      ["planTryCatchCfg", "tryCatchAsyncSpillInfo"],
      ["planWhileLoopCfg", "loopAsyncSpillInfo"],
    ];
    for (const [planner, spiller] of pairs) {
      for (const fn of [planner, spiller]) {
        const sig = asyncCps.slice(asyncCps.indexOf(`function ${fn}(`));
        expect(sig.slice(0, sig.indexOf(")")), `${fn} must accept a checker`).toContain("checker?: ts.TypeChecker");
      }
    }
  });
});
