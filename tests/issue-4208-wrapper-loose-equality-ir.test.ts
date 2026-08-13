// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";

type CompileTarget = undefined | "standalone";

const LEVER_SOURCE = `
export function eqBooleanForward(): number {
  return (new Boolean(true) == true ? 1 : 0)
    + (new Number(1) == true ? 2 : 0)
    + (new String("1") == true ? 4 : 0);
}
export function eqBooleanReverse(): number {
  return (true == new Boolean(true) ? 1 : 0)
    + (true == new Number(1) ? 2 : 0)
    + (true == new String("+1") ? 4 : 0);
}
export function eqNumberForward(): number {
  return (new Boolean(true) == 1 ? 1 : 0)
    + (new Number(-1) == -1 ? 2 : 0)
    + (new String("-1") == -1 ? 4 : 0);
}
export function eqNumberReverse(): number {
  return (1 == new Boolean(true) ? 1 : 0)
    + (-1 == new Number(-1) ? 2 : 0)
    + (-1 == new String("-1") ? 4 : 0);
}
export function neqBooleanForward(): number {
  return (new Boolean(true) != true ? 1 : 0)
    + (new Number(1) != true ? 2 : 0)
    + (new String("1") != true ? 4 : 0);
}
export function neqBooleanReverse(): number {
  return (true != new Boolean(true) ? 1 : 0)
    + (true != new Number(1) ? 2 : 0)
    + (true != new String("+1") ? 4 : 0);
}
export function neqNumberForward(): number {
  return (new Boolean(true) != 1 ? 1 : 0)
    + (new Number(-1) != -1 ? 2 : 0)
    + (new String("-1") != -1 ? 4 : 0);
}
export function neqNumberReverse(): number {
  return (1 != new Boolean(true) ? 1 : 0)
    + (-1 != new Number(-1) ? 2 : 0)
    + (-1 != new String("-1") ? 4 : 0);
}
`;

const LEVER_NAMES = [
  "eqBooleanForward",
  "eqBooleanReverse",
  "eqNumberForward",
  "eqNumberReverse",
  "neqBooleanForward",
  "neqBooleanReverse",
  "neqNumberForward",
  "neqNumberReverse",
] as const;

async function instantiate(result: CompileResult): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
    setExports?: (exports: WebAssembly.Exports) => void;
    __setExports?: (exports: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  imports.__setExports?.(instance.exports);
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome | undefined {
  return result.irOutcomes?.find((entry) => entry.displayName === name);
}

async function compileTarget(source: string, target: CompileTarget): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-4208-wrapper-loose-equality-ir.ts",
    experimentalIR: true,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

describe("#4208 S4 — primitive-wrapper loose equality", () => {
  it.each<CompileTarget>([undefined, "standalone"])(
    "emits Object→ToPrimitive→dynamic equality through IR (%s)",
    async (target) => {
      const result = await compileTarget(LEVER_SOURCE, target);
      for (const name of LEVER_NAMES) {
        expect(outcome(result, name), name).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: true,
          irBodyEmitted: true,
        });
      }
      if (target === "standalone") {
        expect(WebAssembly.Module.imports(await WebAssembly.compile(result.binary))).toEqual([]);
      } else {
        const functionImports = WebAssembly.Module.imports(await WebAssembly.compile(result.binary))
          .filter((entry) => entry.kind === "function")
          .map((entry) => entry.name);
        expect(functionImports).toEqual(
          expect.arrayContaining([
            "__new_Boolean",
            "__new_Number",
            "__new_String",
            "__to_primitive",
            "__host_loose_eq",
          ]),
        );
      }

      const exports = await instantiate(result);
      for (const name of LEVER_NAMES.slice(0, 4)) expect(exports[name]!(), name).toBe(7);
      for (const name of LEVER_NAMES.slice(4)) expect(exports[name]!(), name).toBe(0);
    },
  );

  it.each<CompileTarget>([undefined, "standalone"])(
    "keeps wrapper identity and wrapper-vs-string on the legacy boundary (%s)",
    async (target) => {
      const result = await compileTarget(
        `
          export function wrapperIdentity(): boolean {
            return new Boolean(true) == new Boolean(true);
          }
          export function wrapperString(): boolean {
            return new Boolean(true) == "1";
          }
          export function stringWrapperBooleanViaLocal(): boolean {
            const wrapper = new String("1");
            return wrapper == true;
          }
          export function stringWrapperNumberViaLocal(): boolean {
            const wrapper = new String("-1");
            return -1 == wrapper;
          }
        `,
        target,
      );
      for (const name of [
        "wrapperIdentity",
        "wrapperString",
        "stringWrapperBooleanViaLocal",
        "stringWrapperNumberViaLocal",
      ]) {
        expect(outcome(result, name), name).toMatchObject({
          kind: "unsupported",
          legacyBodyEmitted: true,
          irBodyEmitted: false,
        });
      }
      const exports = await instantiate(result);
      expect(exports.wrapperIdentity!()).toBe(0);
      expect(exports.wrapperString!()).toBe(1);
      expect(exports.stringWrapperBooleanViaLocal!()).toBe(1);
      expect(exports.stringWrapperNumberViaLocal!()).toBe(1);
    },
  );
});
