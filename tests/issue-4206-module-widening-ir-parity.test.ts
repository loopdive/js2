// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4206 follow-up — legacy module-slot widening and IR binding selection must
 * agree before a function is claimed.
 *
 * The pending-rejection arm in #2906 exposed the split: direct codegen widened
 * an explicitly annotated `number` global after an unreachable `never` write,
 * while IR correctly planned the annotation's f64 ABI. A genuinely inferred
 * heterogeneous binding has the opposite contract: legacy owns its externref
 * slot until IR has the full dynamic module read/write boundary.
 */
import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";

function outcome(result: CompileResult, name: string): IrObservedOutcome | undefined {
  return result.irOutcomes?.find((candidate) => candidate.displayName === name);
}

function moduleGlobalLine(result: CompileResult, name: string): string | undefined {
  return result.wat?.split("\n").find((line) => line.includes(`(global $__mod_${name} `));
}

describe("#4206 — module-slot widening agrees with IR selection", () => {
  it("keeps an explicitly annotated number slot on f64 and its reader on IR", async () => {
    const result = await compile(
      `
        let ran: number = 0;
        function unreachableWrite(value: never): void { ran = value; }
        export function getRan(): number { return ran; }
      `,
      {
        fileName: "issue-4206-annotated-module-slot.ts",
        target: "wasi",
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(moduleGlobalLine(result, "ran")).toContain("(mut f64)");
    expect(outcome(result, "getRan")).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
    });
    expect(outcome(result, "<module-init>")).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
    });

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    expect((instance.exports as { getRan: () => number }).getRan()).toBe(0);
  });

  it("preclaim-demotes an inferred heterogeneous slot instead of violating the IR ABI", async () => {
    const result = await compile(
      `
        let ran = 0;
        export function setRan(value: any): void { ran = value; }
        export function getRan(): number { return +ran; }
      `,
      {
        fileName: "issue-4206-inferred-module-slot.ts",
        target: "wasi",
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(moduleGlobalLine(result, "ran")).toContain("(mut externref)");
    expect(outcome(result, "getRan")).toMatchObject({ kind: "unsupported" });
    expect(outcome(result, "<module-init>")).toMatchObject({ kind: "unsupported" });
    expect(result.irCompiledFuncs ?? []).not.toContain("getRan");
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    const exports = instance.exports as { setRan: (value: unknown) => void; getRan: () => number };
    exports.setRan(7);
    expect(exports.getRan()).toBe(7);
  });
});
