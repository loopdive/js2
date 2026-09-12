// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irIntrinsicFuncRef } from "../src/ir/callable-bindings.js";
import { irProgramRuntimeDemands } from "../src/ir/program-runtime-demands.js";
import { IR_STRING_COMPARE_FN } from "../src/ir/runtime-symbols.js";
import type { IrUnitId } from "../src/ir/identity.js";

function body() {
  const builder = new IrFunctionBuilder({ unitId: "ir-unit:v1:demands" as IrUnitId, name: "compare" }, [
    { kind: "val", val: { kind: "i32" } },
  ]);
  builder.openBlock();
  const left = builder.emitStringConst("left\ud800");
  const right = builder.emitStringConst("right");
  const result = builder.emitCall(irIntrinsicFuncRef(IR_STRING_COMPARE_FN), [left, right], {
    kind: "val",
    val: { kind: "i32" },
  });
  builder.terminate({ kind: "return", values: [result!] });
  return builder.finish();
}

describe("source-free whole-program runtime demand scans", () => {
  it("retains literal encoding and symbolic compare demands from typed instructions", () => {
    const demands = irProgramRuntimeDemands(body());
    expect(Object.keys(demands)).toHaveLength(10);
    expect(demands.stringCompareDemand).toBe(true);
    expect(demands.stringConstDemand).toEqual({ literal: true, utf16: true });
    expect(demands.stringCharCodeAtDemand).toBe(false);
    expect(demands.stringConcatManyDemand).toEqual({ arities: [] });
  });

  it("loads demand and validation leaves in a fresh process whose frontend barrier fires", () => {
    const loader = `export async function resolve(specifier, context, next) { const value = await next(specifier, context); if (/(?:\\/src\\/ts-api\\.|\\/src\\/checker\\/|\\/src\\/ir\\/(?:from-ast|async-prepare|async-linear-prepare)\\.|\\/node_modules\\/typescript\\/)/.test(value.url)) throw new Error('frontend-barrier:' + value.url); return value; }`;
    const demandUrl = new URL("../src/ir/program-runtime-demands.ts", import.meta.url).href;
    const validatorUrl = new URL("../src/ir/program-validation.ts", import.meta.url).href;
    const frontendUrl = new URL("../src/ts-api.ts", import.meta.url).href;
    const script = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url); const demands = await import(${JSON.stringify(demandUrl)}); const validator = await import(${JSON.stringify(validatorUrl)}); const observed = demands.irProgramRuntimeDemands(${JSON.stringify(body())}); let barrier = false; try { await import(${JSON.stringify(frontendUrl)}); } catch (error) { barrier = String(error).includes('frontend-barrier:'); } console.log(JSON.stringify({ literal: observed.stringConstDemand.literal, utf16: observed.stringConstDemand.utf16, compare: observed.stringCompareDemand, validator: typeof validator.assertPreparedIrProgram, barrier }));`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      literal: true,
      utf16: true,
      compare: true,
      validator: "function",
      barrier: true,
    });
  });
});
