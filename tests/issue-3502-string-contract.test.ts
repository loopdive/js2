// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import {
  bindLinearStringRuntime,
  LINEAR_STRING_ASCII_PROOF_REQUIRED,
} from "../src/ir/analysis/linear-string-runtime.js";
import {
  LINEAR_STRING_ELEMENTS_OFFSET,
  LINEAR_STRING_LENGTH_OFFSET,
  LINEAR_STRING_PAYLOAD_PREFIX_BYTES,
  LINEAR_STRING_PAYLOAD_SIZE_OFFSET,
  planLinearMemory,
} from "../src/ir/analysis/linear-memory-plan.js";
import {
  proveTypedStringAppend,
  proveTypedStringMethod,
  type TypedValueEvidence,
} from "../src/ir/analysis/string-evidence.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { forEachInstrDeep, irVal, type IrInstr, type IrType } from "../src/ir/nodes.js";
import { IR_STRING_RUNTIME, utf16CharAt, utf16CharCodeAt } from "../src/ir/string-runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3502-string-contract");
const STRING: IrType = { kind: "string" };
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const sourcePath = "website/public/benchmarks/competitive/programs/string-hash.js";

const stringEvidence = (
  carrierType: IrType,
  stringEncoding: "ascii" | "utf8-guaranteed" | "wtf16",
  semanticSource: "checker" | "producer",
): TypedValueEvidence => ({ semanticType: "string", carrierType, stringEncoding, semanticSource });
const numberEvidence: TypedValueEvidence = {
  semanticType: "number",
  carrierType: F64,
  semanticSource: "checker",
};

function writeLinearUtf8String(memory: WebAssembly.Memory, pointer: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  const view = new DataView(memory.buffer);
  view.setUint32(pointer + LINEAR_STRING_PAYLOAD_SIZE_OFFSET, LINEAR_STRING_PAYLOAD_PREFIX_BYTES + bytes.length, true);
  view.setUint32(pointer + LINEAR_STRING_LENGTH_OFFSET, bytes.length, true);
  new Uint8Array(memory.buffer, pointer + LINEAR_STRING_ELEMENTS_OFFSET, bytes.length).set(bytes);
}

describe("#3502 backend-neutral string contract", () => {
  it("claims the untouched landing source with typed append and character IR", async () => {
    const source = readFileSync(sourcePath, "utf8");
    await compile(source, { fileName: sourcePath, target: "linear" });
    const report = getLastLinearIrReport();

    expect(report?.compiled).toEqual(["run"]);
    expect(report?.rejected).toEqual([]);
    const instructions: IrInstr[] = [];
    for (const block of report!.irModule.functions[0]!.blocks) {
      for (const instruction of block.instrs) {
        forEachInstrDeep(instruction, (nested) => instructions.push(nested));
      }
    }
    expect(instructions.some((instr) => instr.kind === "string.char_at")).toBe(true);
    expect(instructions.some((instr) => instr.kind === "string.char_code_at")).toBe(true);
    expect(instructions.filter((instr) => instr.kind === "string.concat")).toHaveLength(3);
    expect(
      instructions
        .filter((instr): instr is Extract<IrInstr, { kind: "string.concat" }> => instr.kind === "string.concat")
        .every((instr) => instr.concatMode === "owned-append" && instr.encodingEvidence === "ascii"),
    ).toBe(true);
    expect(
      report!.memoryPlan.allocations
        .filter((allocation) => allocation.allocationKind === "string")
        .every((allocation) => allocation.encoding === "ascii"),
    ).toBe(true);
    expect(() =>
      lowerIrModuleToPorffor(report!.irModule, { memoryPlan: report!.memoryPlan, prefs: { gc: false } }),
    ).not.toThrow();
  });

  it("uses semantic checker/producer evidence instead of the linear carrier", () => {
    const asciiSlot = stringEvidence(I32, "ascii", "checker");
    const asciiProducer = stringEvidence(I32, "ascii", "producer");
    const unicodeProducer = stringEvidence(I32, "utf8-guaranteed", "producer");

    expect(proveTypedStringAppend(asciiSlot, asciiProducer)).toEqual({
      intrinsic: "concat",
      resultType: STRING,
      resultEncoding: "ascii",
    });
    expect(proveTypedStringAppend(asciiSlot, unicodeProducer)?.resultEncoding).toBe("utf8-guaranteed");
    expect(proveTypedStringAppend(asciiSlot, numberEvidence)).toBeNull();
    expect(proveTypedStringAppend(numberEvidence, asciiProducer)).toBeNull();

    expect(proveTypedStringMethod(asciiSlot, "charAt", [])).toMatchObject({
      intrinsic: "char-at",
      omittedIndex: true,
      resultType: STRING,
      receiverEncoding: "ascii",
      resultEncoding: "ascii",
    });
    expect(proveTypedStringMethod(asciiSlot, "charAt", [I32])).toMatchObject({
      intrinsic: "char-at",
      omittedIndex: false,
      indexInputType: I32,
    });
    expect(proveTypedStringMethod(unicodeProducer, "charAt", [F64])?.resultEncoding).toBe("wtf16");
    expect(proveTypedStringMethod(asciiSlot, "charCodeAt", [F64])).toMatchObject({
      intrinsic: "char-code-at",
      resultType: F64,
    });
    expect(proveTypedStringMethod(numberEvidence, "charAt", [F64])).toBeNull();
    expect(proveTypedStringMethod(asciiSlot, "slice", [F64])).toBeNull();
    expect(proveTypedStringMethod(asciiSlot, "charAt", [STRING])).toBeNull();
    expect(proveTypedStringMethod(asciiSlot, "charAt", [F64, F64])).toBeNull();
  });

  it("makes UTF-16 indexing, defaults, and bounds match Node", () => {
    const values = ["", "Az", "é世", "😀", "A😀B", "\ud800", "\udc00", "\ud800A\udc00"];
    const positions: Array<number | undefined> = [
      undefined,
      Number.NaN,
      -Infinity,
      -1,
      -0,
      0,
      0.9,
      1,
      1.9,
      2,
      Infinity,
    ];

    for (const value of values) {
      for (const position of positions) {
        const expectedChar = position === undefined ? value.charAt() : value.charAt(position);
        const expectedCode = position === undefined ? value.charCodeAt() : value.charCodeAt(position);
        expect(utf16CharAt(value, position), `${JSON.stringify(value)}.charAt(${String(position)})`).toBe(expectedChar);
        expect(
          Object.is(utf16CharCodeAt(value, position), expectedCode),
          `${JSON.stringify(value)}.charCodeAt(${String(position)})`,
        ).toBe(true);
      }
    }

    expect(IR_STRING_RUNTIME["char-at"].index).toEqual({
      conversion: "ToIntegerOrInfinity",
      unit: "utf16-code-unit",
      omitted: 0,
      outOfBounds: "empty-string",
    });
    expect(IR_STRING_RUNTIME["char-code-at"].index?.outOfBounds).toBe("nan");
  });

  it("binds only proven ASCII work to the established LinearMemoryPlan layout", () => {
    const registry = new AllocSiteRegistry();
    const builder = new IrFunctionBuilder(identities.next("strings"), [F64], true, registry);
    builder.openBlock();
    const left = builder.emitStringConst("A");
    const right = builder.emitStringConst("B");
    builder.emitStringConcat(left, right);
    builder.emitStringConst("é");
    const zero = builder.emitConst({ kind: "f64", value: 0 }, F64);
    builder.terminate({ kind: "return", values: [zero] });
    const plan = planLinearMemory({ functions: [builder.finish()] }, registry);
    const concat = plan.allocations.find(
      (allocation) => allocation.allocationKind === "string" && allocation.dataSegmentId === undefined,
    );
    const nonAscii = plan.allocations.find((allocation) => allocation.encoding === "utf8-guaranteed");
    expect(concat).toBeDefined();
    expect(concat?.encoding).toBe("ascii");
    expect(nonAscii).toBeDefined();

    const concatBinding = bindLinearStringRuntime(plan, { intrinsic: "concat", alloc: concat!.id });
    expect(concatBinding.operation).toEqual({
      family: "string",
      operation: "concat",
      elementStorage: "i8",
      encoding: "ascii",
    });
    expect(bindLinearStringRuntime(plan, { intrinsic: "length", inputEncoding: "ascii" }).operation).toEqual({
      family: "string",
      operation: "length",
      elementStorage: "i8",
      encoding: "ascii",
    });
    expect(() => bindLinearStringRuntime(plan, { intrinsic: "char-at", inputEncoding: "ascii" })).toThrow(
      /requires an allocation site/,
    );
    expect(() => bindLinearStringRuntime(plan, { intrinsic: "constant", alloc: nonAscii!.id })).toThrow(
      `${LINEAR_STRING_ASCII_PROOF_REQUIRED} for constant result (got utf8-guaranteed)`,
    );
    expect(() => bindLinearStringRuntime(plan, { intrinsic: "char-code-at", inputEncoding: "wtf16" })).toThrow(
      `${LINEAR_STRING_ASCII_PROOF_REQUIRED} for char-code-at input (got wtf16)`,
    );
    expect(() => bindLinearStringRuntime(plan, { intrinsic: "length" })).toThrow(
      `${LINEAR_STRING_ASCII_PROOF_REQUIRED} for length input (got unproven)`,
    );
    expect(JSON.stringify(concatBinding)).not.toMatch(/funcIdx|typeIdx|RawC|renderer|#include|__str_/);
  });

  it("rejects non-ASCII source at the linear runtime boundary with a stable diagnostic", async () => {
    await compile(
      `
        /** @param {number} n @returns {number} */
        export function unicodeAppend(n) {
          let text = "";
          for (let i = 0; i < n; i++) {
            text += "é";
          }
          return text.charCodeAt(0);
        }
      `,
      { fileName: "issue-3502-non-ascii.js", target: "linear" },
    );
    const report = getLastLinearIrReport();
    expect(report?.compiled).toStrictEqual([]);
    expect(report?.rejected).toContainEqual({
      func: "unicodeAppend",
      reason: "build",
      detail: `${LINEAR_STRING_ASCII_PROOF_REQUIRED} for constant result (got utf8-guaranteed)`,
    });
    expect(() =>
      lowerIrModuleToPorffor(report!.irModule, {
        memoryPlan: report!.memoryPlan,
        prefs: { gc: false },
      }),
    ).toThrow(`${LINEAR_STRING_ASCII_PROOF_REQUIRED} for constant result (got utf8-guaranteed)`);
  });

  it("keeps concat immutable when a loop observes the previous string value", async () => {
    const compiled = await compile(
      `
        /** @param {number} n @returns {number} */
        export function observedAppend(n) {
          let text = "";
          let previous = "";
          for (let i = 0; i < n; i++) {
            previous = text;
            text += "a";
          }
          return previous.length;
        }
      `,
      { fileName: "issue-3502-observed-append.js", target: "linear" },
    );
    expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
    const report = getLastLinearIrReport();
    expect(report?.compiled).toStrictEqual(["observedAppend"]);
    expect(report?.rejected).toStrictEqual([]);
    const concats: Array<Extract<IrInstr, { kind: "string.concat" }>> = [];
    for (const block of report!.irModule.functions[0]!.blocks) {
      for (const instruction of block.instrs) {
        forEachInstrDeep(instruction, (nested) => {
          if (nested.kind === "string.concat") concats.push(nested);
        });
      }
    }
    expect(concats).toHaveLength(1);
    expect(concats[0]?.concatMode).toBe("immutable");
    const { instance } = await WebAssembly.instantiate(compiled.binary, compiled.importObject ?? {});
    const observedAppend = (instance.exports as Record<string, (n: number) => number>).observedAppend;
    expect(observedAppend(3)).toBe(2);
  });

  it("kills stale ASCII evidence at statement, expression, and loop-carried joins", async () => {
    const executableSource = `
      /** @param {number} take @param {string} input @returns {number} */
      export function conditionalJoin(take, input) {
        let text = "A";
        if (take > 0) text = input;
        return text.charCodeAt(0) === input.charCodeAt(0) ? 1 : 0;
      }

      /** @param {number} count @param {string} input @returns {number} */
      export function loopCarriedJoin(count, input) {
        let text = "A";
        let other = "B";
        let observed = 0;
        let i = 0;
        while (i < count) {
          observed = text.charCodeAt(0);
          text = other;
          other = input;
          i++;
        }
        return observed === input.charCodeAt(0) ? 1 : 0;
      }
    `;

    const compiled = await compile(executableSource, {
      fileName: "issue-3502-encoding-joins.js",
      target: "linear",
      allocator: "bump",
    });
    const report = getLastLinearIrReport();
    expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(report?.compiled).toStrictEqual(["conditionalJoin", "loopCarriedJoin"]);
    expect(report?.rejected).toStrictEqual([]);

    const instructions: IrInstr[] = [];
    for (const func of report!.irModule.functions) {
      for (const block of func.blocks) {
        for (const instruction of block.instrs) {
          forEachInstrDeep(instruction, (nested) => instructions.push(nested));
        }
      }
    }
    expect(instructions.some((instruction) => instruction.kind === "string.char_code_at")).toBe(false);
    expect(
      instructions.filter(
        (instruction) => instruction.kind === "call" && instruction.target.name === "__linear_ir_str_char_code_at",
      ),
    ).not.toHaveLength(0);
    expect(() =>
      lowerIrModuleToPorffor(report!.irModule, {
        memoryPlan: report!.memoryPlan,
        prefs: { gc: false },
      }),
    ).toThrow("porffor assembler: unresolved intrinsic '__linear_ir_str_char_code_at'");

    const { instance } = await WebAssembly.instantiate(compiled.binary, compiled.importObject ?? {});
    const exports = instance.exports as Record<string, WebAssembly.ExportValue>;
    const memory = exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("linear memory export is absent");
    const inputPointer = 60_000;
    writeLinearUtf8String(memory, inputPointer, "é");
    const call = (name: string, first: number): number => {
      const fn = exports[name];
      if (typeof fn !== "function") throw new Error(`linear export ${name} is absent`);
      return (fn as (value: number, input: number) => number)(first, inputPointer);
    };

    expect(call("conditionalJoin", 1)).toBe(1);
    expect(call("loopCarriedJoin", 3)).toBe(1);

    const expressionSource = `
      /** @param {number} take @param {string} input @returns {number} */
      export function elseJoin(take, input) {
        let text = "A";
        if (take > 0) text = "B";
        else text = input;
        return text.charCodeAt(0) === input.charCodeAt(0) ? 1 : 0;
      }

      /** @param {number} take @param {string} input @returns {number} */
      export function ternaryJoin(take, input) {
        let text = "A";
        take > 0 ? (text = input) : text;
        return text.charCodeAt(0) === input.charCodeAt(0) ? 1 : 0;
      }

      /** @param {number} take @param {string} input @returns {number} */
      export function shortCircuitJoin(take, input) {
        let text = "A";
        take > 0 && (text = input) === input;
        return text.charCodeAt(0) === input.charCodeAt(0) ? 1 : 0;
      }
    `;
    await compile(expressionSource, {
      fileName: "issue-3502-expression-joins.js",
      target: "linear",
      allocator: "bump",
    });
    const expressionReport = getLastLinearIrReport();
    expect(expressionReport?.compiled).toStrictEqual(["elseJoin"]);
    expect(expressionReport?.rejected).toStrictEqual([
      { func: "ternaryJoin", reason: "select:body-shape-rejected", detail: undefined },
      { func: "shortCircuitJoin", reason: "select:body-shape-rejected", detail: undefined },
    ]);

    const executableExpression = await compile(
      `
        /** @param {number} take @param {string} input @returns {number} */
        export function elseJoin(take, input) {
          let text = "A";
          if (take > 0) text = "B";
          else text = input;
          return text.charCodeAt(0) === input.charCodeAt(0) ? 1 : 0;
        }
      `,
      {
        fileName: "issue-3502-executable-else-join.js",
        target: "linear",
        allocator: "bump",
      },
    );
    expect(executableExpression.success, executableExpression.errors.map((error) => error.message).join("\n")).toBe(
      true,
    );
    const expressionInstance = await WebAssembly.instantiate(
      executableExpression.binary,
      executableExpression.importObject ?? {},
    );
    const expressionExports = expressionInstance.instance.exports as Record<string, WebAssembly.ExportValue>;
    const expressionMemory = expressionExports.memory;
    const elseJoin = expressionExports.elseJoin;
    if (!(expressionMemory instanceof WebAssembly.Memory) || typeof elseJoin !== "function") {
      throw new Error("linear expression-join exports are incomplete");
    }
    const expressionInputPointer = 60_000;
    writeLinearUtf8String(expressionMemory, expressionInputPointer, "é");
    expect((elseJoin as (take: number, input: number) => number)(0, expressionInputPointer)).toBe(1);
    expect((elseJoin as (take: number, input: number) => number)(1, expressionInputPointer)).toBe(0);
  });
});
