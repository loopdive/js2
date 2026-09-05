// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";

// Register the low-level codegen delegates used by compile.
import "../src/codegen/expressions.js";

const TARGETS = ["gc", "standalone"] as const;
type Target = (typeof TARGETS)[number];

afterEach(() => {
  (globalThis as { gc?: () => void }).gc?.();
});

function functionOutcome(result: CompileResult, name: string): IrObservedOutcome {
  const rows = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  expect(rows, `missing or duplicate terminal row for ${name}`).toHaveLength(1);
  return rows[0]!;
}

function unitOutcome(result: CompileResult, name: string): IrObservedOutcome {
  const rows = (result.irOutcomes ?? []).filter((candidate) => candidate.displayName === name);
  expect(rows, `missing or duplicate terminal row for ${name}`).toHaveLength(1);
  return rows[0]!;
}

async function tracked(source: string, fileName: string, target: Target): Promise<CompileResult> {
  const result = await compile(source, {
    fileName,
    target,
    experimentalIR: true,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.errors.filter((error) => error.severity !== "warning")).toEqual([]);
  return result;
}

function expectPreclaimReferenceRejection(result: CompileResult, name = "compare"): void {
  expect(functionOutcome(result, name)).toMatchObject({
    kind: "unsupported",
    code: "operand-coercion-unsupported",
    stage: "select",
    prepareAttempts: 1,
    directBodyEmissions: 1,
    irBodyEmissions: 0,
    legacyBodyEmitted: true,
    irBodyEmitted: false,
  });
  expect(result.irPostClaimErrors ?? []).toEqual([]);
}

const REFERENCE_OPERATORS = ["===", "!==", "==", "!="] as const;

describe("#3520 equality reference operands", () => {
  for (const target of TARGETS) {
    for (const operator of REFERENCE_OPERATORS) {
      it(`rejects callable ${operator} operands during selection on ${target}`, async () => {
        const result = await tracked(
          `export function compare(a: () => number, b: () => number): number {
            try { return a ${operator} b ? 1 : 0; } catch (_) { return 0; }
          }`,
          `issue-3520-callable-${operator.replace(/[^a-z]/gi, "")}-${target}.ts`,
          target,
        );
        expectPreclaimReferenceRejection(result);
      });
    }
  }

  for (const target of TARGETS) {
    it(`rejects array and local-class reference pairs before claim on ${target}`, async () => {
      const arrayResult = await tracked(
        "export function compare(a: number[], b: number[]): number { return a === b ? 1 : 0; }",
        `issue-3520-array-${target}.ts`,
        target,
      );
      expectPreclaimReferenceRejection(arrayResult);

      const classResult = await tracked(
        `class Box { value = 1; }
         export function compare(a: Box, b: Box): number { return a === b ? 1 : 0; }`,
        `issue-3520-class-${target}.ts`,
        target,
      );
      expectPreclaimReferenceRejection(classResult);
      // The class constructor is an independent positive IR unit; only the
      // equality owner is covered by this guard.
      expect(unitOutcome(classResult, "Box_new")).toMatchObject({
        kind: "emitted",
        irBodyEmitted: true,
      });
    });
  }

  for (const target of TARGETS) {
    it(`follows callable alias evidence while preserving shadow rejection on ${target}`, async () => {
      const alias = await tracked(
        `export function compare(a: () => number, b: () => number): number {
          const alias = a;
          return alias === b ? 1 : 0;
        }`,
        `issue-3520-callable-alias-${target}.ts`,
        target,
      );
      expectPreclaimReferenceRejection(alias);

      const shadow = await tracked(
        `export function compare(a: () => number, b: () => number): number {
          { const a = 1; return a === b ? 1 : 0; }
        }`,
        `issue-3520-callable-shadow-${target}.ts`,
        target,
      );
      expect(functionOutcome(shadow, "compare")).toMatchObject({
        kind: "unsupported",
        code: "body-shape-rejected",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(shadow.irPostClaimErrors ?? []).toEqual([]);
    });
  }

  for (const target of TARGETS) {
    it(`does not turn absent classifier evidence into a reference proof on ${target}`, async () => {
      const anyResult = await tracked(
        "export function compare(a: any, b: any): number { return a === b ? 1 : 0; }",
        `issue-3520-any-${target}.ts`,
        target,
      );
      expect(functionOutcome(anyResult, "compare")).toMatchObject({
        kind: "emitted",
        stage: "patch",
        directBodyEmissions: 1,
        irBodyEmissions: 1,
        legacyBodyEmitted: true,
        irBodyEmitted: true,
      });
      expect(anyResult.irPostClaimErrors ?? []).toEqual([]);

      const unknownResult = await tracked(
        "export function compare(a: unknown, b: unknown): number { return a === b ? 1 : 0; }",
        `issue-3520-unknown-${target}.ts`,
        target,
      );
      expect(functionOutcome(unknownResult, "compare")).toMatchObject({
        kind: "unsupported",
        code: "param-type-not-resolvable",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(unknownResult.irPostClaimErrors ?? []).toEqual([]);

      const unionResult = await tracked(
        "export function compare(a: number | boolean, b: number | boolean): number { return a === b ? 1 : 0; }",
        `issue-3520-primitive-union-${target}.ts`,
        target,
      );
      expect(functionOutcome(unionResult, "compare")).toMatchObject({
        kind: "unsupported",
        code: "param-type-not-resolvable",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(unionResult.irPostClaimErrors ?? []).toEqual([]);
    });
  }

  for (const target of TARGETS) {
    it(`keeps structural-object equality at its measured build fallback on ${target}`, async () => {
      const result = await tracked(
        "export function compare(a: { x: number }, b: { x: number }): number { return a === b ? 1 : 0; }",
        `issue-3520-structural-object-${target}.ts`,
        target,
      );
      expect(functionOutcome(result, "compare")).toMatchObject({
        kind: "unsupported",
        code: "operand-coercion-unsupported",
        stage: "build",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(result.irPostClaimErrors).toEqual([expect.objectContaining({ kind: "build", func: "compare" })]);
    });
  }

  for (const target of TARGETS) {
    it(`preserves primitive and nullish equality execution on ${target}`, async () => {
      const source = `
        export function numberEq(): boolean { return 3 === 3; }
        export function stringEq(): boolean { return "left" !== "right"; }
        export function booleanEq(): boolean { return true === true; }
        export function undefinedCheck(x: number): boolean { return x === undefined; }
        export function nullCheck(x: number): boolean { return x !== null; }
      `;
      const trackedResult = await tracked(source, `issue-3520-controls-${target}.ts`, target);
      for (const name of ["numberEq", "stringEq", "booleanEq", "undefinedCheck", "nullCheck"]) {
        expect(functionOutcome(trackedResult, name)).toMatchObject({
          kind: "emitted",
          stage: "patch",
          irBodyEmitted: true,
          legacyBodyEmitted: false,
        });
      }
      expect(trackedResult.irPostClaimErrors ?? []).toEqual([]);

      const untracked = await compile(source, {
        fileName: `issue-3520-controls-${target}.ts`,
        target,
        experimentalIR: true,
      });
      expect(untracked.success, untracked.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(createHash("sha256").update(trackedResult.binary).digest("hex")).toBe(
        createHash("sha256").update(untracked.binary).digest("hex"),
      );

      const { instance } = await WebAssembly.instantiate(trackedResult.binary, trackedResult.importObject);
      const exports = instance.exports as Record<string, (...args: number[]) => number>;
      expect(exports.numberEq!()).toBe(1);
      expect(exports.stringEq!()).toBe(1);
      expect(exports.booleanEq!()).toBe(1);
      expect(exports.undefinedCheck!(7)).toBe(0);
      expect(exports.nullCheck!(7)).toBe(1);
    });
  }
});
