// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { forEachSemanticIrInstruction, type IrFunction } from "../src/ir/core/nodes.js";
import { irBindingKey } from "../src/ir/core/declared-types.js";
import { irUnitFuncRef } from "../src/ir/core/callable-bindings.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";

const external = { kind: "val", val: { kind: "externref" } } as const;
const integer = { kind: "val", val: { kind: "i32" } } as const;
function prepareFunctions(packet: ReturnType<typeof sourcePacket>["packet"], functions: readonly IrFunction[]) {
  const declaredSignatures = new Map(packet.ir.declaredSignatures);
  for (const fn of functions)
    declaredSignatures.set(irBindingKey(irUnitFuncRef(fn).binding)!, {
      params: fn.params.map((param) => param.type),
      result: fn.resultTypes[0] ?? null,
    });
  return requireProgram(
    prepareTypedIrProgram({ ...packet, ir: { ...packet.ir, declaredSignatures, functions } }, typedOptions),
  );
}

function fixture(probe: "simple" | "false" | "condition") {
  const { packet } = sourcePacket({ "./entry.ts": "export function run():number{return 0;}" });
  const original = packet.ir.functions[0]!;
  const b = new IrFunctionBuilder(original, [external], true);
  const condition = b.addParam("condition", integer),
    a = b.addParam("a", external),
    c = b.addParam("b", external),
    d = b.addParam("c", external);
  b.openBlock();
  let result;
  if (probe === "simple") result = b.emitSelect(condition, a, c, external);
  else if (probe === "false") result = b.emitSelect(condition, a, b.emitSelect(condition, c, d, external), external);
  else {
    const nil = b.emitConst({ kind: "null", ty: external }, external);
    const test = b.emitRefIsNull(b.emitSelect(condition, nil, c, external));
    result = b.emitSelect(test, a, d, external);
  }
  b.terminate({ kind: "return", values: [result] });
  return prepareFunctions(packet, [b.finish()]);
}
for (const probe of ["simple", "false", "condition"] as const)
  for (const decoded of [false, true])
    it(`executes reference select without losing identity: ${probe}, decoded=${decoded}`, async () => {
      const original = fixture(probe);
      const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
      const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
      if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
      expect(outcome.run.emitted.module.imports).toEqual([]);
      for (const functions of [program.ir.functions, outcome.run.accepted.runtime.prepared.functions]) {
        let selects = 0;
        for (const fn of functions)
          forEachSemanticIrInstruction(fn, (instruction) => {
            if (instruction.kind === "select") selects++;
          });
        expect(selects).toBe(probe === "simple" ? 1 : 2);
      }
      expect(outcome.run.emitted.emittedUnitIds).toEqual(
        outcome.run.accepted.runtime.prepared.functions.map((fn) => fn.unitId),
      );
      const a = {},
        b = {},
        c = {};
      const run = outcome.run.exports.run as Function;
      for (const condition of [1, -1, 17]) expect(run(condition, a, b, c)).toBe(a);
      expect(run(1, null, b, c)).toBeNull();
      expect(run(0, a, b, c)).toBe(probe === "simple" ? b : c);
    });

function effectsFixture(throws: boolean) {
  const { packet } = sourcePacket({
    "./entry.ts": `let order:number=0;
    function reset():void {order=0;}
    function truth(x:number):number {order=order*10+1;return x;}
    function falsity(x:number):number {order=order*10+2;return x;}
    function condition(c:number):number {order=order*10+3;return c;}
    export function read():number{return order;}
    export function run(c:number,a:number,b:number):number{return a;}`,
  });
  // Typed dispatch harness: retain original numeric global effects, replace only parameter/return carriers.
  const functions = packet.ir.functions.map((fn) => {
    if (fn.name !== "truth" && fn.name !== "falsity") return fn;
    return {
      ...fn,
      params: fn.params.map((param) => ({ ...param, type: external })),
      resultTypes: [external],
      blocks: fn.blocks.map((block) =>
        fn.name === "falsity" && throws
          ? {
              ...block,
              instrs: [
                ...block.instrs,
                { kind: "throw" as const, value: fn.params[0]!.value, result: null, resultType: null },
              ],
              terminator: { kind: "unreachable" as const },
            }
          : block,
      ),
    };
  });
  const original = functions.find((fn) => fn.name === "run")!;
  const unit = (name: string) => irUnitFuncRef(functions.find((fn) => fn.name === name)!);
  const b = new IrFunctionBuilder(original, [external], true);
  const number = { kind: "val", val: { kind: "f64" } } as const;
  const c = b.addParam("condition", number),
    a = b.addParam("a", external),
    other = b.addParam("b", external);
  b.openBlock();
  b.emitCall(unit("reset"), [], null);
  const result = b.declareSlot("result", external.val),
    caught = b.declareSlot("caught", external.val);
  const body = b.collectBodyInstrs(() => {
    const left = b.emitCall(unit("truth"), [a], external)!;
    const right = b.emitCall(unit("falsity"), [other], external)!;
    const condition = b.emitCall(unit("condition"), [c], number)!;
    const test = b.emitBinary("f64.ne", condition, b.emitConst({ kind: "f64", value: 0 }, number), integer);
    b.emitSlotWrite(result, b.emitSelect(test, left, right, external));
  });
  const handler = b.collectBodyInstrs(() => b.emitSlotWrite(result, b.emitSlotRead(caught)));
  b.emitTry({ body, catchClause: { payloadSlot: caught, body: handler } });
  b.terminate({ kind: "return", values: [b.emitSlotRead(result)] });
  return prepareFunctions(
    packet,
    functions.map((fn) => (fn === original ? b.finish() : fn)),
  );
}
for (const throws of [false, true])
  for (const decoded of [false, true])
    it(`preserves eager operand effects and exact abrupt completion: throws=${throws}, decoded=${decoded}`, async () => {
      const original = effectsFixture(throws);
      const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
      const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
      if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
      expect(outcome.run.emitted.module.imports).toEqual([]);
      expect(outcome.run.emitted.emittedUnitIds).toEqual(
        outcome.run.accepted.runtime.prepared.functions.map((fn) => fn.unitId),
      );
      const { run, read } = outcome.run.exports as Record<string, Function>;
      for (const condition of [0, 1]) {
        const left = {},
          right = {};
        expect(run!(condition, left, right)).toBe(throws || !condition ? right : left);
        expect(read!()).toBe(throws ? 12 : 123);
      }
    });
