// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1373b Slice 1a — IR async Phase C scaffolding (plumbing only).
//
// Scope of this PR:
//   1. New `CodegenContext.supportsAsyncIr: boolean` field, initialised
//      `false` by `createContext`. Reserved for Slice 1b to flip on when
//      the FULFILLED / REJECTED fast-path lowering lands.
//   2. New `IrSelectionOptions.supportsAsyncIr?: boolean` plumbing.
//   3. New `isAsyncIrReady(options, fn)` selector helper — the single
//      source of truth for whether a given async function can flow
//      through the IR's CPS lowering. Slice 1a hardcodes `false`;
//      Slice 1b will swap in the real body-shape check.
//
// Out of scope (follow-ups):
//   - Slice 1b: FULFILLED/REJECTED fast-path lowering in `src/ir/lower.ts`,
//     `IrInstrAwait`/`IrInstrAsyncReturn`/`IrInstrAsyncThrow` emission in
//     `src/ir/from-ast.ts`. See architect spec
//     `plan/issues/sprints/52/1373b-ir-async-cps-lowering.md`.
//   - Slice 2: PENDING-path CPS continuation synthesis (blocked on
//     #1326c Phase 1C-B).
//   - Slice 3: gate-flip.
//
// Even with the flag set, the selector still returns the `"async-function"`
// fallback for now — the `isAsyncIrReady` body returns `false` unconditionally
// at this slice's checkpoint. Tests below pin both behaviours so any
// regression that accidentally claims an async function before the lowering
// is ready surfaces immediately.

import { describe, expect, it } from "vitest";
import { ts } from "../../src/ts-api.js";
import { isAsyncIrReady, planIrCompilation } from "../../src/ir/select.js";

function parseSource(src: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", src, ts.ScriptTarget.ES2022, true);
}

function findFunction(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | undefined {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
  }
  return undefined;
}

describe("#1373b Slice 1a — async-IR scaffolding (plumbing only)", () => {
  describe("isAsyncIrReady() gate", () => {
    it("returns false when supportsAsyncIr is undefined", () => {
      const sf = parseSource(`async function f() { return 1; }`);
      const fn = findFunction(sf, "f")!;
      expect(isAsyncIrReady(undefined, fn)).toBe(false);
    });

    it("returns false when supportsAsyncIr is explicitly false", () => {
      const sf = parseSource(`async function f() { return 1; }`);
      const fn = findFunction(sf, "f")!;
      expect(isAsyncIrReady({ supportsAsyncIr: false }, fn)).toBe(false);
    });

    it("returns false even when supportsAsyncIr is true (Slice 1a — gate still closed)", () => {
      // This is the deliberate scaffolding behaviour: the flag exists and
      // is threaded through, but the gate body returns `false` so no async
      // function actually flows through the IR until Slice 1b ships the
      // FULFILLED/REJECTED fast-path lowering.
      const sf = parseSource(`async function f() { return 1; }`);
      const fn = findFunction(sf, "f")!;
      expect(isAsyncIrReady({ supportsAsyncIr: true }, fn)).toBe(false);
    });

    it("returns false for an arbitrary async function shape", () => {
      const sf = parseSource(`async function g(x: number) { return await Promise.resolve(x); }`);
      const fn = findFunction(sf, "g")!;
      expect(isAsyncIrReady({ supportsAsyncIr: true }, fn)).toBe(false);
    });
  });

  describe("selector unchanged from #1373 Phase A", () => {
    it("async function lands in async-function fallback (gate closed)", () => {
      const sf = parseSource(`async function f() { return 1; }`);
      const sel = planIrCompilation(sf, {
        experimentalIR: true,
        trackFallbacks: true,
        supportsAsyncIr: true, // even with the new flag set, the bucket is unchanged
      });
      const fb = sel.fallbacks?.find((f) => f.name === "f");
      expect(fb?.reason).toBe("async-function");
    });

    it("async function lands in async-function fallback (flag absent — back-compat)", () => {
      const sf = parseSource(`async function f() { return 1; }`);
      const sel = planIrCompilation(sf, {
        experimentalIR: true,
        trackFallbacks: true,
      });
      const fb = sel.fallbacks?.find((f) => f.name === "f");
      expect(fb?.reason).toBe("async-function");
    });

    it("async generator still lands in async-generator (separate bucket)", () => {
      const sf = parseSource(`async function* g() { yield 1; }`);
      const sel = planIrCompilation(sf, {
        experimentalIR: true,
        trackFallbacks: true,
        supportsAsyncIr: true,
      });
      const fb = sel.fallbacks?.find((f) => f.name === "g");
      // The async-generator bucket is intentionally not affected by the
      // async-function gate — async generators stay deferred.
      expect(fb?.reason).toBe("async-generator");
    });

    it("plain (non-async) function still IR-claimable", () => {
      const sf = parseSource(`export function f(): number { return 1; }`);
      const sel = planIrCompilation(sf, {
        experimentalIR: true,
        trackFallbacks: true,
        supportsAsyncIr: true,
      });
      const fb = sel.fallbacks?.find((f) => f.name === "f");
      expect(fb).toBeUndefined();
    });
  });
});
