// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { evaluateAsJs } from "./equivalence/helpers.js";

const ORIGINAL = 'export function b(n:number):string{return "v"+(n>0?"p":0);}';
const TAMPER = "JS2WASM_TEST_TAMPER_IR_MIXED_PRIMITIVE_CONDITIONAL";

function body(result: CompileResult, name: string) {
  const row = result.irOutcomes?.find((o) => o.unitKind === "function" && o.displayName === name);
  expect(row, `missing ${name} outcome`).toBeDefined();
  return row!;
}

async function prepare(source: string, target: "standalone" | "wasi") {
  const result = await compile(source, { target, experimentalIR: true, trackIrOutcomes: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings ?? []).toEqual([]);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return { result, exports: instance.exports as Record<string, (...args: number[]) => number> };
}

afterEach(() => vi.unstubAllEnvs());

for (const target of ["standalone", "wasi"] as const) {
  describe(`#7066 mixed conditional addition (${target})`, () => {
    it("emits the original export without a source caller or a legacy body", async () => {
      const { result } = await prepare(ORIGINAL, target);
      expect(body(result, "b")).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });
    });

    for (const [name, expression, expectedTrue, expectedFalse] of [
      ["string then number", '"v"+(n>0?"p":0)', "vp", "v0"],
      ["conditional on the left", '(n>0?"p":0)+"v"', "pv", "0v"],
      ["boolean then string", '"v"+(n>0?true:"p")', "vtrue", "vp"],
      ["number then boolean", '""+(n>0?7:false)', "7", "false"],
      ["nested additions", '"["+("v"+(n>0?"p":0))+"]"', "[vp]", "[v0]"],
    ] as const) {
      it(`${name}: preserves both arms through the canonical addition provider`, async () => {
        const source = `export function b(n:number):string{return ${expression};}
          export function run(n:number):number{return b(n)===(n>0?${JSON.stringify(expectedTrue)}:${JSON.stringify(expectedFalse)})?1:0;}`;
        const { result, exports } = await prepare(source, target);
        expect(body(result, "b")).toMatchObject({ kind: "emitted", irBodyEmitted: true });
        expect(body(result, "run")).toMatchObject({ kind: "emitted", irBodyEmitted: true });
        const oracle = evaluateAsJs(source);
        for (const n of [1, -1, 0, -0, NaN, Infinity, -Infinity]) expect(exports.run!(n)).toBe(oracle.run!(n));
      });
    }

    it("preserves numeric addition and the existing TypeScript operand diagnostic", async () => {
      const source = "export function b(n:number):number{return (n>0?7:true)+2;}";
      const result = await compile(source, { target, experimentalIR: true, trackIrOutcomes: true });
      expect(result.success).toBe(true);
      // JavaScript coerces true to 1; TypeScript still diagnoses this source.
      expect(result.errors.map(({ code, severity }) => ({ code, severity }))).toEqual([
        { code: 2365, severity: "warning" },
      ]);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(body(result, "b")).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });
      const module = new WebAssembly.Module(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = new WebAssembly.Instance(module, {});
      const b = instance.exports.b as (n: number) => number;
      const oracle = evaluateAsJs(source);
      for (const n of [1, -1, 0, NaN, Infinity, -Infinity]) expect(b(n)).toBe(oracle.b!(n));
    });

    it("evaluates surrounding operands once and from left to right", async () => {
      const source = `let count:number=0;
        function left():string{count=count*10+1;return "v";}
        function right():string{count=count*10+2;return "z";}
        export function run(n:number):number{
          count=0;const value=left()+(n>0?"p":0)+right();
          return (value===(n>0?"vpz":"v0z")?1000:0)+count;
        }`;
      const { result, exports } = await prepare(source, target);
      expect(result.irOutcomes?.map((row) => row.displayName).sort()).toEqual([
        "<module-init>",
        "left",
        "right",
        "run",
      ]);
      for (const row of result.irOutcomes ?? [])
        expect(row).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });
      const oracle = evaluateAsJs(source);
      for (const n of [1, -1]) {
        expect(oracle.run!(n)).toBe(1012);
        expect(exports.run!(n)).toBe(oracle.run!(n));
      }
    });

    for (const tamper of ["proof", "tag", "result"]) {
      it(`retains a typed invariant when the mixed producer loses its ${tamper}`, async () => {
        vi.stubEnv(TAMPER, tamper);
        // A numeric true arm makes the tag fault change the actual prepared tag.
        const source = 'export function b(n:number):string{return "v"+(n>0?7:"p");}';
        const result = await compile(source, { target, experimentalIR: true, trackIrOutcomes: true });
        expect(result.success).toBe(false);
        expect(result.binary.length).toBe(0);
        expect(result.errors.map((e) => e.message).join("\n")).toMatch(/#5092|mixed conditional/i);
        expect(body(result, "b")).toMatchObject({ kind: "invariant", stage: "build", irBodyEmitted: false });
      });
    }
  });
}
