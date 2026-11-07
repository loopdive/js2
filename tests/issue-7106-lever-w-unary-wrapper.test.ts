// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #7106 lever W: unary `-`/`+` on a fresh primitive-wrapper construction is
// claimed by the IR and applies ToNumber through the wrapper ToPrimitive path
// the binary wrapper operands use (#4208/#7034). Other prefix operators on a
// wrapper, and `new Object()`, stay on the legacy boundary.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";

type CompileTarget = undefined | "standalone";

const CLAIMED: Record<string, { body: string; expected: number }> = {
  negNumber: { body: "return -new Number(1);", expected: -1 },
  plusString: { body: 'return +new String("1");', expected: 1 },
  negBoolean: { body: "return -new Boolean(true);", expected: -1 },
  plusBooleanFalse: { body: "return +new Boolean(false);", expected: 0 },
  negStringHex: { body: 'return -new String("0x10");', expected: -16 },
  plusStringNaN: { body: 'return +new String("x");', expected: NaN },
};

const REFUSED: Record<string, { body: string; expected: number }> = {
  notBoolean: { body: "return !new Boolean(false) ? 1 : 0;", expected: 0 },
  tildeNumber: { body: "return ~new Number(1);", expected: -2 },
  plusObject: { body: "return +new Object();", expected: NaN },
};

function source(cases: Record<string, { body: string }>): string {
  return Object.entries(cases)
    .map(([name, { body }]) => `export function ${name}(): number { ${body} }`)
    .join("\n");
}

async function instantiate(result: CompileResult): Promise<Record<string, () => unknown>> {
  const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
    setExports?: (exports: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  return instance.exports as Record<string, () => unknown>;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome | undefined {
  return result.irOutcomes?.find((entry) => entry.displayName === name);
}

async function compileTarget(text: string, target: CompileTarget): Promise<CompileResult> {
  const result = await compile(text, {
    fileName: "issue-7106-lever-w-unary-wrapper.ts",
    experimentalIR: true,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

describe("#7106 lever W — unary -/+ on a primitive wrapper", () => {
  it.each<CompileTarget>([undefined, "standalone"])("claims -/+ wrapper through IR (%s)", async (target) => {
    const result = await compileTarget(source(CLAIMED), target);
    const exports = await instantiate(result);
    for (const [name, { expected }] of Object.entries(CLAIMED)) {
      expect(outcome(result, name), name).toMatchObject({ kind: "emitted", irBodyEmitted: true });
      expect(exports[name]!(), name).toBe(expected);
    }
  });

  it.each<CompileTarget>([undefined, "standalone"])(
    "keeps !, ~ and new Object() on the legacy boundary (%s)",
    async (target) => {
      const result = await compileTarget(source(REFUSED), target);
      const exports = await instantiate(result);
      for (const [name, { expected }] of Object.entries(REFUSED)) {
        expect(outcome(result, name), name).toMatchObject({ kind: "unsupported", irBodyEmitted: false });
        expect(exports[name]!(), name).toBe(expected);
      }
    },
  );
});
