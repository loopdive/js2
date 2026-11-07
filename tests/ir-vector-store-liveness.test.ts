// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal, irVec, forEachInstrDeep, type IrInstr } from "../src/ir/nodes.js";
import { deadCode } from "../src/ir/passes/dead-code.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { isSideEffecting } from "../src/ir/analysis/effects.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import { compile } from "../src/index.js";
const identities = createTestIrFunctionIdentityFactory("vector-store-liveness");
const f64 = irVal({ kind: "f64" }),
  i32 = irVal({ kind: "i32" });
for (const kind of ["vec.set", "vec.set_length"] as const)
  for (const nested of [false, true]) {
    it(`preserves unique operands of ${kind} (${nested ? "nested" : "direct"})`, () => {
      const b = new IrFunctionBuilder(identities.next("store"), []);
      const cond = b.addParam("cond", i32);
      b.openBlock();
      const unused = b.emitConst({ kind: "f64", value: 999 }, f64);
      const emit = () => {
        const initial = b.emitConst({ kind: "f64", value: 11 }, f64);
        const vec = b.emitVecNewFixed([initial], f64, irVec(f64, false));
        const index = b.emitConst({ kind: "i32", value: 0 }, i32);
        if (kind === "vec.set") {
          const value = b.emitConst({ kind: "f64", value: 7 }, f64);
          b.emitVecSet(vec, index, value);
        } else b.emitVecSetLength(vec, index);
      };
      if (nested) b.emitIfStmt({ cond, then: b.collectBodyInstrs(emit), else: [] });
      else emit();
      b.terminate({ kind: "return", values: [] });
      const before = b.finish();
      expect(verifyIrFunction(before)).toEqual([]);
      const after = deadCode(before);
      expect(verifyIrFunction(after)).toEqual([]);
      const rows: IrInstr[] = [];
      for (const block of after.blocks) for (const row of block.instrs) forEachInstrDeep(row, (r) => rows.push(r));
      expect(rows.filter((row) => row.kind === kind)).toHaveLength(1);
      expect(isSideEffecting(rows.find((row) => row.kind === kind)!)).toBe(true);
      expect(rows.some((row) => row.result === unused)).toBe(false);
      expect(rows.filter((row) => row.kind === "const")).toHaveLength(kind === "vec.set" ? 3 : 2);
    });
  }
it("still removes an unused pure vector allocation and its constants", () => {
  const b = new IrFunctionBuilder(identities.next("pure"), []);
  b.openBlock();
  const value = b.emitConst({ kind: "f64", value: 7 }, f64);
  b.emitVecNewFixed([value], f64, irVec(f64, false));
  b.terminate({ kind: "return", values: [] });
  const result = deadCode(b.finish());
  expect(verifyIrFunction(result)).toEqual([]);
  expect(result.blocks[0]!.instrs).toHaveLength(0);
});
it("optimized standalone IR preserves an indexed numeric assignment", async () => {
  const result = await compile("export function run():number{let a=[0];a[0]=7;return a[0];}", {
    target: "standalone",
    optimize: true,
    trackIrOutcomes: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.irPostClaimErrors).toEqual([]);
  expect(result.irOutcomes?.find((row) => row.displayName === "run")?.irBodyEmitted).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as () => number)()).toBe(7);
});
