// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";

import { addRuntime } from "../src/codegen-linear/runtime.js";
import {
  authenticateLinearStringRepeatReservationReceipt,
  issueLinearStringRepeatReservationReceipt,
  reserveLinearStringRepeatProvider,
} from "../src/codegen-linear/string-repeat.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/nodes.js";
import { parseIrCountedStringAppendSiteId } from "../src/ir/counted-string-append-provenance.js";
import { IR_STRING_REPEAT_FN } from "../src/ir/string-runtime.js";
import { createEmptyModule } from "../src/ir/types.js";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";

const ORIGINAL_LINEAR_IR = process.env.JS2WASM_LINEAR_IR;
const TAMPER_RESERVATION = "JS2WASM_TEST_TAMPER_LINEAR_COUNTED_REPEAT_RESERVATION";

afterEach(() => {
  if (ORIGINAL_LINEAR_IR === undefined) Reflect.deleteProperty(process.env, "JS2WASM_LINEAR_IR");
  else process.env.JS2WASM_LINEAR_IR = ORIGINAL_LINEAR_IR;
  vi.unstubAllEnvs();
});

async function compileCounted(tripCount: number) {
  vi.stubEnv("JS2WASM_LINEAR_IR", "1");
  vi.stubEnv("JS2WASM_IR_STRING_BUILDER", "1");
  const result = await compile(
    `
      export function run(): string {
        let value = "seed";
        for (let index = 0; index < ${tripCount}; index++) value = value + "xy";
        return value;
      }
    `,
    {
      target: "linear",
      fileName: `issue-3518-linear-counted-${tripCount}.ts`,
      emitWat: true,
      optimize: false,
    },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const report = getLastLinearIrReport();
  expect(report?.compiled).toContain("run");
  expect(report?.preparedCountedStringAppendReceipts).toHaveLength(1);
  expect(report?.preparedCountedStringAppendReceipts[0]?.plan.syntaxPlan.tripCount).toBe(tripCount);
  expect(report?.preparedCountedStringAppendReceipts[0]?.siteId).toBe(
    report?.preparedCountedStringAppendReceipts[0]?.plan.siteId,
  );
  expect(parseIrCountedStringAppendSiteId(report?.preparedCountedStringAppendReceipts[0]?.siteId ?? "")).toMatchObject({
    ownerUnitId: report?.preparedCountedStringAppendReceipts[0]?.plan.ownerUnitId,
    sourceId: report?.preparedCountedStringAppendReceipts[0]?.plan.sourceId,
  });
  return { result, report: report! };
}

describe("#3518 linear counted-string repeat reservation", () => {
  it("does not reserve repeat for exact N=0/N=1 Prepared plans", async () => {
    const zero = await compileCounted(0);
    expect(zero.result.wat).not.toContain("$__str_repeat");
    expect(zero.report.preparedCountedStringAppendReceipts[0]?.siteId).toBeDefined();

    const one = await compileCounted(1);
    expect(one.result.wat).not.toContain("$__str_repeat");
    expect(one.report.preparedCountedStringAppendReceipts[0]?.siteId).toBeDefined();
  });

  it("reserves and authenticates repeat before slots for an exact N>=2 Prepared plan", async () => {
    const { result, report } = await compileCounted(3);
    expect(result.wat).toContain("$__str_repeat");
    const run = report.irModule.functions.find((fn) => fn.name === "run");
    const repeats: Extract<IrInstr, { kind: "string.repeat" }>[] = [];
    for (const instruction of run?.blocks.flatMap((block) => block.instrs) ?? []) {
      forEachInstrDeep(instruction, (nested) => {
        if (nested.kind === "string.repeat") repeats.push(nested);
      });
    }
    expect(repeats).toHaveLength(1);
    expect(repeats[0]?.provider?.binding).toEqual({ kind: "intrinsic", symbol: IR_STRING_REPEAT_FN });
    expect(repeats[0]?.countedStringAppendSite).toBe(report.preparedCountedStringAppendReceipts[0]?.siteId);

    const { instance } = await WebAssembly.instantiate(result.binary);
    const pointer = (instance.exports.run as () => number)();
    const memory = instance.exports.memory as WebAssembly.Memory;
    const length = new DataView(memory.buffer).getUint32(pointer + 8, true);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, pointer + 12, length))).toBe("seedxyxyxy");
  });

  it("fails typed and closed when the linear string runtime lacks non-ASCII evidence", async () => {
    vi.stubEnv("JS2WASM_LINEAR_IR", "1");
    vi.stubEnv("JS2WASM_IR_STRING_BUILDER", "1");
    const result = await compile(
      `
        export function run(): string {
          let value = "seed";
          for (let index = 0; index < 3; index++) value = value + "é";
          return value;
        }
      `,
      {
        target: "linear",
        fileName: "issue-3518-linear-counted-nonascii.ts",
        optimize: false,
      },
    );
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toMatch(
      /prepared counted-string owner .* did not build: block 0 instr string\.repeat: linear backend requires authenticated ASCII evidence for string\.repeat/,
    );
    expect(getLastLinearIrReport()?.compiled).not.toContain("run");
    expect(getLastLinearIrReport()?.preparedCountedStringAppendReceipts).toEqual([]);
  });

  it("keeps the direct AST repeat heuristic independent of the IR preparation", async () => {
    vi.stubEnv("JS2WASM_LINEAR_IR", "0");
    const result = await compile(`export function run(): string { return "xy".repeat(3); }`, {
      target: "linear",
      fileName: "issue-3518-linear-direct-repeat.ts",
      emitWat: true,
      optimize: false,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.wat).toContain("$__str_repeat");
  });

  it("fails closed after preparation when the reserved provider drifts", async () => {
    vi.stubEnv("JS2WASM_LINEAR_IR", "1");
    vi.stubEnv("JS2WASM_IR_STRING_BUILDER", "1");
    vi.stubEnv(TAMPER_RESERVATION, "1");
    const result = await compile(
      `
        export function run(): string {
          let value = "seed";
          for (let index = 0; index < 3; index++) value = value + "xy";
          return value;
        }
      `,
      {
        target: "linear",
        fileName: "issue-3518-linear-counted-tamper.ts",
        optimize: false,
      },
    );
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toMatch(
      /prepared counted-string owner .* failed after reservation: linear string\.repeat reservation lost its exact provider ABI/,
    );
    expect(getLastLinearIrReport()?.compiled).not.toContain("run");
    expect(getLastLinearIrReport()?.preparedCountedStringAppendReceipts).toEqual([]);
  });

  it("rejects a receipt borrowed from another source or preparation", () => {
    const module = createEmptyModule();
    addRuntime(module);
    const reservation = reserveLinearStringRepeatProvider(module);
    const sourceFile = ts.createSourceFile("a.ts", "", ts.ScriptTarget.ES2022, true);
    const otherSourceFile = ts.createSourceFile("b.ts", "", ts.ScriptTarget.ES2022, true);
    const preparation = Object.freeze({ sourceFile });
    const otherPreparation = Object.freeze({ sourceFile });
    const receipt = issueLinearStringRepeatReservationReceipt(module, reservation, sourceFile, preparation);

    expect(authenticateLinearStringRepeatReservationReceipt(module, receipt, sourceFile, preparation)).toBeGreaterThan(
      0,
    );
    expect(() =>
      authenticateLinearStringRepeatReservationReceipt(module, receipt, otherSourceFile, preparation),
    ).toThrow(/exact source\/preparation identity/);
    expect(() =>
      authenticateLinearStringRepeatReservationReceipt(module, receipt, sourceFile, otherPreparation),
    ).toThrow(/exact source\/preparation identity/);
    expect(() =>
      authenticateLinearStringRepeatReservationReceipt(module, { ...receipt }, sourceFile, preparation),
    ).toThrow(/exact source\/preparation identity/);
  });
});
