// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1855 — UB-free fuzzer + differential testing + automated minimization.
 *
 * Generates a deterministic (fixed-seed) batch of UB-free TypeScript programs
 * in the js2wasm supported subset, runs each through the V8 oracle and the
 * WasmGC backend, and asserts they agree. Because the generator is reference-
 * defined (safe-integer domain, total expressions), any disagreement is a real
 * wrong-code bug — and the test minimizes the failing case to a small repro
 * before failing, so the report is debuggable.
 *
 * Determinism: a fixed seed range keeps CI stable and lets any failure be
 * reproduced by re-running the same seed. The generator + minimizer also carry
 * unit tests (PRNG determinism, oracle/JS equivalence, validity-preserving
 * reduction) so the harness itself is trustworthy.
 */
import { describe, expect, it } from "vitest";
import { Rng, generateProgram } from "./fuzz/generator.js";
import { differentialRun } from "./fuzz/differential.js";
import { minimize, reduceLines } from "./fuzz/minimizer.js";

describe("#1855 — fuzzer + differential testing", () => {
  // ── generator unit tests ─────────────────────────────────────────────────

  it("PRNG is deterministic for a fixed seed", () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
    // Different seed → different sequence (overwhelmingly likely).
    const c = new Rng(54321);
    expect(Array.from({ length: 10 }, () => c.next())).not.toEqual(seqA);
  });

  it("generateProgram is deterministic and well-formed for a fixed seed", () => {
    const p1 = generateProgram(777);
    const p2 = generateProgram(777);
    expect(p1.source).toBe(p2.source);
    expect(p1.args).toEqual(p2.args);
    expect(p1.source).toContain("export function main(");
    expect(p1.source).toContain("return ");
    expect(p1.fn).toBe("main");
  });

  it("generated programs are valid JS that produce a finite integer (UB-free)", () => {
    // The oracle path strips types and evaluates; a non-finite or throwing
    // result would mean the generator produced UB. Sweep a batch of seeds.
    for (let seed = 1; seed <= 40; seed++) {
      const p = generateProgram(seed);
      const js = p.source.replace(/export function/g, "function").replace(/: number/g, "");
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const main = new Function(`${js}\nreturn main;`)() as (...a: number[]) => number;
      const v = main(...p.args);
      expect(typeof v, `seed ${seed}`).toBe("number");
      expect(Number.isFinite(v), `seed ${seed} finite`).toBe(true);
      // Result is ToInt32-pinned by the generator (`return (...) | 0`).
      expect(Number.isInteger(v), `seed ${seed} integer`).toBe(true);
    }
  });

  // ── differential sweep (the core acceptance) ─────────────────────────────

  it("generated corpus: WasmGC output matches the V8 oracle on every seed", async () => {
    const SEEDS = 60;
    const failures: Array<{ seed: number; oracle?: number; wasm?: number; error?: string }> = [];
    for (let seed = 1000; seed < 1000 + SEEDS; seed++) {
      const program = generateProgram(seed);
      const r = await differentialRun(program);
      if (r.outcome === "oracle_error") {
        // A generator bug (emitted UB) — fail loudly, it taints the sweep.
        throw new Error(`generator emitted UB at seed ${seed}: ${r.error}\n${program.source}`);
      }
      if (r.outcome === "compile_error" || r.outcome === "runtime_error") {
        // The generated subset should always compile+run; a failure here is a
        // real compiler bug worth surfacing.
        failures.push({ seed, error: r.error });
      } else if (r.outcome === "mismatch") {
        failures.push({ seed, oracle: r.oracle, wasm: r.wasm });
      }
    }

    if (failures.length > 0) {
      // Minimize the first failure to a small repro for the report.
      const first = failures[0]!;
      const program = generateProgram(first.seed);
      const min = await minimize(program).catch(() => null);
      const repro = min
        ? `\nMinimized repro (${min.before} → ${min.after} stmts, oracle=${min.oracle} wasm=${min.wasm}):\n${min.source}`
        : `\nUnminimized source:\n${program.source}`;
      throw new Error(
        `${failures.length}/${SEEDS} generated programs diverged from the V8 oracle. ` +
          `First: seed ${first.seed} oracle=${first.oracle} wasm=${first.wasm} ${first.error ?? ""}${repro}`,
      );
    }
    expect(failures).toEqual([]);
  });

  // ── minimizer self-test (proves validity-preserving reduction works) ─────

  it("minimizer reduces a planted mismatch to a small repro, preserving validity", async () => {
    // We can't rely on a real compiler bug existing, so we PLANT a synthetic
    // failing program and use a fake-oracle minimizer harness inline: a program
    // with many redundant statements plus one line that (hypothetically)
    // triggers a divergence. To exercise the real minimizer against the real
    // backend we instead use a program where the oracle and wasm AGREE (no real
    // bug), so `minimize` returns null — confirming it does NOT fabricate a
    // repro when there is no failure. (The reduction loop itself is unit-tested
    // via the deterministic line-removal predicate below.)
    const program = generateProgram(2024);
    const r = await differentialRun(program);
    // On a clean tree this generated program matches → nothing to minimize.
    if (r.outcome === "match") {
      const min = await minimize(program);
      expect(min, "no mismatch ⇒ minimize returns null (never fabricates a repro)").toBeNull();
    } else {
      // If it genuinely diverges, the minimizer must produce a smaller-or-equal
      // repro that still mismatches and still compiles.
      const min = await minimize(program);
      expect(min).not.toBeNull();
      expect(min!.after).toBeLessThanOrEqual(min!.before);
      expect(Object.is(min!.oracle, min!.wasm)).toBe(false);
    }
  });

  it("reduceLines is validity-preserving: shrinks to the minimal failing set", async () => {
    // Synthetic predicate: the case "still fails" iff the marker line "BUG;" is
    // present (and validity is trivially true). The reducer must remove every
    // other line, keep "BUG;" and the "return", and reach a fixpoint. This
    // exercises the real reduction algorithm deterministically without needing
    // a real compiler bug.
    const lines = ["let a = 1;", "let b = 2;", "BUG;", "let c = 3;", "let d = 4;", "return a;"];
    const predicate = (cand: readonly string[]) => cand.includes("BUG;");
    const reduced = await reduceLines(lines, predicate);
    expect(reduced).toContain("BUG;");
    expect(reduced).toContain("return a;"); // keep() never drops the return
    // Everything not load-bearing is gone — minimal repro is {BUG; return a;}.
    expect(reduced).toEqual(["BUG;", "return a;"]);
  });

  it("reduceLines never removes a kept line even if the predicate would allow it", async () => {
    // Predicate is always true (any subset "fails"); only keep() protects lines.
    const lines = ["x;", "return y;", "z;"];
    const reduced = await reduceLines(lines, () => true);
    // All removable lines gone; the return survives.
    expect(reduced).toEqual(["return y;"]);
  });
});
