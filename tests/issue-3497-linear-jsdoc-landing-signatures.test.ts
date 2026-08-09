// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3497 — JavaScript JSDoc signatures must reach the shared IR selector and
// AST-to-IR builder without rewriting the source into TypeScript.

import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { planIrCompilation } from "../src/ir/select.js";

const LANDING_ROOT = "website/public/benchmarks/competitive/programs";
const LANDING_PROGRAMS = ["fib", "fib-recursive", "array-sum", "string-hash"] as const;

function selectJavaScript(source: string) {
  const sourceFile = ts.createSourceFile("issue-3497.js", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  return planIrCompilation(sourceFile, { experimentalIR: true, trackFallbacks: true });
}

function fallbackReason(source: string, name: string): string | undefined {
  return selectJavaScript(source).fallbacks?.find((fallback) => fallback.name === name)?.reason;
}

describe("#3497 — TypeScript-effective JSDoc signatures", () => {
  it("claims standard JavaScript number, boolean, and string signatures", () => {
    const selection = selectJavaScript(`
      /** @param {number} value @returns {number} */
      export function numberIdentity(value) { return value; }

      /** @param {boolean} value @returns {boolean} */
      export function booleanIdentity(value) { return value; }

      /** @param {string} value @returns {string} */
      export function stringIdentity(value) { return value; }
    `);

    expect([...selection.funcs].sort()).toEqual(["booleanIdentity", "numberIdentity", "stringIdentity"]);
    expect(selection.fallbacks).toEqual([]);
  });

  it("lowers those effective primitive signatures through the linear IR builder", async () => {
    const result = await compile(
      `
        /** @param {number} value @returns {number} */
        export function numberIdentity(value) { return value; }

        /** @param {boolean} value @returns {boolean} */
        export function booleanIdentity(value) { return value; }

        /** @param {string} value @returns {string} */
        export function stringIdentity(value) { return value; }
      `,
      { fileName: "issue-3497.js", target: "linear", allocator: "analysis-stack" },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(getLastLinearIrReport()?.compiled).toEqual(["numberIdentity", "booleanIdentity", "stringIdentity"]);
    expect(getLastLinearIrReport()?.rejected).toEqual([]);
  });

  it("keeps unannotated and any-valued operations on the dynamic rejection path", () => {
    const unannotated = `export function dynamicAdd(value) { return value + 1; }`;
    const explicitAny = `
      /** @param {any} value @returns {any} */
      export function dynamicAdd(value) { return value + 1; }
    `;

    expect(selectJavaScript(unannotated).funcs.has("dynamicAdd")).toBe(false);
    expect(fallbackReason(unannotated, "dynamicAdd")).toBe("return-type-not-resolvable");
    expect(selectJavaScript(explicitAny).funcs.has("dynamicAdd")).toBe(false);
    expect(fallbackReason(explicitAny, "dynamicAdd")).toBe("param-type-not-resolvable");
  });

  it("does not reinterpret JSDoc unions as primitive signatures", () => {
    const source = `
      /** @param {number|string} value @returns {number|string} */
      export function unionIdentity(value) { return value; }
    `;

    expect(selectJavaScript(source).funcs.has("unionIdentity")).toBe(false);
    expect(fallbackReason(source, "unionIdentity")).toBe("return-type-not-resolvable");
  });
});

describe("#3497 — exact landing benchmark sources", () => {
  it("IR-compiles the exact fib.js run export and preserves behavior", async () => {
    const path = `${LANDING_ROOT}/fib.js`;
    const result = await compile(readFileSync(path, "utf8"), {
      target: "linear",
      allocator: "analysis-stack",
      fileName: path,
    });
    const report = getLastLinearIrReport();

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(report?.compiled).toContain("run");
    expect(report?.rejected.find((rejection) => rejection.func === "run")).toBeUndefined();

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    expect((instance.exports.run as (n: number) => number)(10)).toBe(55);
  });

  it("removes return-type-not-resolvable from every annotated landing export", async () => {
    for (const program of LANDING_PROGRAMS) {
      const path = `${LANDING_ROOT}/${program}.js`;
      await compile(readFileSync(path, "utf8"), {
        target: "linear",
        allocator: "analysis-stack",
        fileName: path,
      });
      const runRejection = getLastLinearIrReport()?.rejected.find((rejection) => rejection.func === "run");

      expect(runRejection?.reason, `${program}: ${runRejection?.detail ?? "no detail"}`).not.toBe(
        "select:return-type-not-resolvable",
      );
    }
  });
});
