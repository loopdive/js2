// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 Stage 1 — `String(v)` on a dynamic operand lowers through
// `dyn.to_string` (the lane's `__extern_toString`, one ToString engine with
// legacy's `String(any)` arm) instead of demoting the function.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  target: "standalone",
  trackIrOutcomes: true,
} as const;

async function compileStandalone(source: string, fileName: string) {
  const result = await compile(source, { ...OPTIONS, fileName });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

async function call(binary: Uint8Array, name: string): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports[name] as () => number)();
}

describe("#7106 S1 — String(<dynamic>) through dyn.to_string", () => {
  it("renders every primitive partition exactly as legacy's String(any) does", async () => {
    const result = await compileStandalone(
      `
        function s(v: any): string { return String(v); }
        export function ok(): number {
          let n = 0;
          if (s(1) === "1") n += 1;
          if (s(1.5) === "1.5") n += 2;
          if (s(true) === "true") n += 4;
          if (s(false) === "false") n += 8;
          if (s("str") === "str") n += 16;
          if (s(-0) === "0") n += 128;
          if (s(NaN) === "NaN") n += 256;
          return n;
        }
      `,
      "issue-7106-s1-partitions.ts",
    );
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("s");
    expect(result.irCompiledFuncs ?? []).toContain("ok");
    expect(await call(result.binary, "ok")).toBe(415);
  });

  it("keeps a concrete primitive operand on the inline arms", async () => {
    const result = await compileStandalone(
      `
        function num(x: number): string { return String(x); }
        function flag(b: boolean): string { return String(b); }
        export function ok(): number {
          let n = 0;
          if (num(42) === "42") n += 1;
          if (flag(true) === "true") n += 2;
          return n;
        }
      `,
      "issue-7106-s1-inline.ts",
    );
    expect(result.irCompiledFuncs ?? []).toContain("num");
    expect(result.irCompiledFuncs ?? []).toContain("flag");
    expect(await call(result.binary, "ok")).toBe(3);
  });

  it("composes with dyn.typeof in a switch (the assert.js formatter shape)", async () => {
    const result = await compileStandalone(
      `
        function fmt(value: any): string {
          switch (typeof value) {
            case "string":
              return "s:" + String(value);
            case "number":
              return "n:" + String(value);
            case "boolean":
              return "b:" + String(value);
          }
          return "?";
        }
        export function ok(): number {
          let n = 0;
          if (fmt("a") === "s:a") n += 1;
          if (fmt(7) === "n:7") n += 2;
          if (fmt(false) === "b:false") n += 4;
          return n;
        }
      `,
      "issue-7106-s1-switch.ts",
    );
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("fmt");
    expect(await call(result.binary, "ok")).toBe(7);
  });

  it("S1b: JSON.stringify(<dynamic>) and the typeof-ambient fold (the assert.js formatter)", async () => {
    const result = await compileStandalone(
      `
        function isNegativeZero(v: any): boolean { return v === 0 && 1 / v === -Infinity; }
        function fmt(value: any): string {
          switch (value === null ? "null" : typeof value) {
            case "string":
              return typeof JSON !== "undefined" ? JSON.stringify(value) : '"' + value + '"';
            case "number":
              if (isNegativeZero(value)) return "-0";
            case "boolean":
            case "undefined":
            case "null":
              return String(value);
          }
          return "?";
        }
        export function ok(): number {
          let n = 0;
          if (fmt("a") === '"a"') n += 1;
          if (fmt(7) === "7") n += 2;
          if (fmt(false) === "false") n += 4;
          if (fmt(-0) === "-0") n += 8;
          if (typeof JSON !== "undefined") n += 16;
          if (typeof Object === "function") n += 32;
          return n;
        }
      `,
      "issue-7106-s1b-formatter.ts",
    );
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("fmt");
    expect(result.irCompiledFuncs ?? []).toContain("isNegativeZero");
    expect(await call(result.binary, "ok")).toBe(63);
  });

  it("S1b: the verbatim assert.js formatIdentityFreeValue (falls out → undefined) ships an IR body", async () => {
    const result = await compileStandalone(
      `
        function isNegativeZero(v: any) { return v === 0 && 1 / v === -Infinity; }
        function formatIdentityFreeValue(value: any) {
          switch (value === null ? 'null' : typeof value) {
            case 'string':
              return typeof JSON !== "undefined" ? JSON.stringify(value) : '"' + value + '"';
            case 'bigint':
              return String(value) + "n";
            case 'number':
              if (isNegativeZero(value)) return '-0';
              // falls through
            case 'boolean':
            case 'undefined':
            case 'null':
              return String(value);
          }
        }
        function probe(v: any): number {
          var basic = formatIdentityFreeValue(v);
          if (basic) return 1;
          return 0;
        }
        export function ok(): number {
          let n = 0;
          if (probe("a") === 1) n += 1;
          if (probe(7) === 1) n += 2;
          if (probe(false) === 1) n += 4;
          return n;
        }
      `,
      "issue-7106-s1b-verbatim.ts",
    );
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain(
      "formatIdentityFreeValue",
    );
    expect(await call(result.binary, "ok")).toBe(7);
  });

  it("S1b: a shadowing JSON parameter is not the ambient namespace and does not fold", async () => {
    // Folding `typeof JSON` here would read "object" and take the wrong arm.
    const result = await compileStandalone(
      `
        function j(JSON: any): string { return typeof JSON === "number" ? "num" : "other"; }
        export function ok(): number { return j(5) === "num" && j("s") === "other" ? 1 : 0; }
      `,
      "issue-7106-s1b-shadow.ts",
    );
    expect(result.irCompiledFuncs ?? []).toContain("j");
    expect(await call(result.binary, "ok")).toBe(1);
  });

  it("a user-declared String binding is not the ambient constructor", async () => {
    const result = await compile(
      `
        function String(v: any): string { return "shadow"; }
        function s(v: any): string { return String(v); }
        export function ok(): number { return s(1) === "shadow" ? 1 : 0; }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1-shadow.ts" },
    );
    expect(result.success).toBe(true);
    expect(await call(result.binary, "ok")).toBe(1);
  });
});
