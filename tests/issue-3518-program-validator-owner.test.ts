// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { beforeAll, describe, expect, it } from "vitest";
import { assertPreparedIrProgram as oldValidate } from "../src/ir/program-validation.js";
import { assertPreparedIrProgram as validate } from "../src/ir/program/validation.js";
import { ProgramAbiMap as oldAbiMap } from "../src/ir/program-abi.js";
import { ProgramAbiMap } from "../src/ir/program/abi.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { PreparedIrProgramInvariantError as oldError } from "../src/ir/program.js";
import { preparedIrReadonlyMap } from "../src/ir/program/data.js";
import { irCapabilityImportFuncRef, irCallableBindingKey } from "../src/ir/core/callable-bindings.js";
import type { PreparedIrAbiEntry, PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { requireProgram, sourceInput } from "./helpers/typed-program-fixtures.js";

let program: PreparedIrProgram;
beforeAll(() => {
  program = requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({
        "./entry.ts": "let base: number = 4; export function main(value: number): number { return value + base; }",
      }),
      policy: { backend: "wasmgc", target: "host" },
      runtimePolicies: [{ backend: "wasmgc", target: "host" }],
    }),
  );
});
function error(value: PreparedIrProgram): PreparedIrProgramInvariantError {
  try {
    validate(value);
  } catch (cause) {
    expect(cause).toBeInstanceOf(PreparedIrProgramInvariantError);
    return cause as PreparedIrProgramInvariantError;
  }
  throw new Error("expected validator refusal");
}
function expectInvalid(value: PreparedIrProgram, message: string) {
  const cause = error(value);
  expect(cause.code).toBe("invalid-prepared-data");
  expect(cause.message).toContain(message);
  expect(cause.name).toBe("PreparedIrProgramInvariantError");
  expect(cause).not.toHaveProperty("location");
  return cause;
}
function entries(change: (entry: PreparedIrAbiEntry, index: number) => PreparedIrAbiEntry): PreparedIrProgram {
  return { ...program, abi: { entries: program.abi.entries.map(change) } };
}

describe("canonical complete prepared-program validator owner", () => {
  it("uses one validator, one ABI constructor and one invariant class", () => {
    expect(oldValidate).toBe(validate);
    expect(oldAbiMap).toBe(ProgramAbiMap);
    expect(oldError).toBe(PreparedIrProgramInvariantError);
    const authority = new ProgramAbiMap(program.inventory, program.derivedUnits);
    expect(authority).toBeInstanceOf(oldAbiMap);
  });
  it("accepts a genuine source program with startup, ABI and runtime projections", () => {
    expect(program.inventory.terminalUnits).toHaveLength(2);
    expect(program.ir.functions).toHaveLength(2);
    expect(program.startup.length).toBeGreaterThan(0);
    expect(program.abi.entries.length).toBeGreaterThan(0);
    expect(() => validate(program)).not.toThrow();
    expect(() => oldValidate(program)).not.toThrow();
  });
  it("checks seal before missing population when both are defective", () => {
    const paired = { ...program, sealed: false, ir: { functions: [] } } as PreparedIrProgram;
    expectInvalid(paired, "program is not a complete prepared program");
    expectInvalid({ ...program, ir: { functions: [] } }, "missing body");
  });
  it("checks original population before undefined runtime support", () => {
    const paired = { ...program, ir: { functions: [] }, runtimeSupport: undefined };
    expectInvalid(paired, "missing body");
    expectInvalid({ ...program, runtimeSupport: undefined }, "runtime support must be absent");
  });
  it("rejects a foreign body despite matching the original body count", () => {
    const foreign = requireProgram(
      prepareWholeIrProgram(
        sourceInput({
          "./entry.ts": 'export { foreign } from "./other";',
          "./other.ts": "export function foreign(): number { return 9; }",
        }),
      ),
    );
    const functions = [...program.ir.functions];
    functions[0] = foreign.ir.functions[0]!;
    expectInvalid({ ...program, ir: { functions } }, "no original owner");
  });
  it("checks semantic provider contamination before unit receipt mismatch", () => {
    const fn = program.ir.functions[0]!,
      block = fn.blocks[0]!;
    const contaminated = {
      ...fn,
      blocks: [
        {
          ...block,
          instrs: [
            {
              kind: "intrinsic",
              id: "math.sqrt",
              provider: { kind: "backend-op", opcode: "f64.sqrt" },
              args: [],
              result: null,
              resultType: null,
            } as unknown as (typeof block.instrs)[number],
          ],
        },
      ],
    };
    const paired = {
      ...program,
      ir: { functions: program.ir.functions.map((item) => (item === fn ? contaminated : item)) },
      units: preparedIrReadonlyMap([]),
    };
    expectInvalid(paired, "physical intrinsic provider");
    expectInvalid({ ...program, units: preparedIrReadonlyMap([]) }, "receipt denominator");
  });
  it("checks unit receipts before a duplicate ABI binding", () => {
    const duplicate = { entries: [...program.abi.entries, program.abi.entries[0]!] };
    expectInvalid({ ...program, units: preparedIrReadonlyMap([]), abi: duplicate }, "receipt denominator");
    expectInvalid({ ...program, abi: duplicate }, "ABI duplicates a binding");
  });
  it("refuses a contradictory original receipt with the correct denominator", () => {
    const unit = program.inventory.terminalUnits[0]!;
    const units = preparedIrReadonlyMap(
      [...program.units].map(
        ([id, receipt]) =>
          [id, id === unit.id ? { ...receipt, declarationStart: receipt.declarationStart + 1 } : receipt] as const,
      ),
    );
    expectInvalid({ ...program, units }, `program receipt ${unit.id} contradicts`);
  });
  it("refuses a complete callable signature substitution", () => {
    let altered = false;
    const changed = entries((entry) => {
      if (altered || entry.contract.kind !== "callable" || entry.plan.intent.kind !== "callable") return entry;
      altered = true;
      return {
        ...entry,
        plan: { ...entry.plan, intent: { ...entry.plan.intent, signature: { params: ["false-type"], results: [] } } },
      };
    });
    expect(altered).toBe(true);
    expectInvalid(changed, "complete callable signature");
  });
  it("refuses an export alias that names a different target", () => {
    let altered = false;
    const changed = entries((entry) => {
      if (entry.contract.kind !== "export" || entry.plan.intent.kind !== "export" || entry.plan.slotPolicy !== "alias")
        return entry;
      altered = true;
      return {
        ...entry,
        plan: {
          ...entry.plan,
          aliasOf:
            program.abi.entries[0]!.plan.id === entry.plan.aliasOf
              ? program.abi.entries[1]!.plan.id
              : program.abi.entries[0]!.plan.id,
        },
      };
    });
    expect(altered).toBe(true);
    expectInvalid(changed, "declared target");
  });
  it("checks exact import capability provenance without a second issuer", () => {
    const original = program.abi.entries.find(
      (entry) => entry.contract.kind === "callable" && entry.plan.intent.kind === "callable",
    )!;
    if (original.contract.kind !== "callable" || original.plan.intent.kind !== "callable")
      throw new Error("missing genuine callable ABI");
    const ref = irCapabilityImportFuncRef("env", "probe", "probe-capability", "probe-provider");
    const entry: PreparedIrAbiEntry = {
      ...original,
      plan: {
        ...original.plan,
        slotPolicy: "required",
        slotSpace: "function",
        structuralReferenceKey: irCallableBindingKey(ref.binding),
        intent: {
          ...original.plan.intent,
          origin: "import",
          capabilityId: "foreign-capability",
          providerId: "probe-provider",
        },
      },
      contract: { ...original.contract, ref },
    };
    const changed = {
      ...program,
      abi: { entries: program.abi.entries.map((value) => (value === original ? entry : value)) },
    };
    expectInvalid(changed, "capability provenance");
  });
  it("retains full runtime reconstruction after ABI acceptance", () => {
    const runtime = program.runtime[0]!;
    const functions = runtime.prepared.functions.map((fn, index) =>
      index === 0 ? { ...fn, exported: !fn.exported } : fn,
    );
    expectInvalid({ ...program, runtime: [{ ...runtime, prepared: { ...runtime.prepared, functions } }] }, "exported");
  });
  it("checks callable signature before reference payload when both are defective", () => {
    let altered = false;
    const changed = entries((entry) => {
      if (altered || entry.contract.kind !== "callable" || entry.plan.intent.kind !== "callable") return entry;
      altered = true;
      return {
        ...entry,
        plan: {
          ...entry.plan,
          structuralReferenceKey: "false-reference",
          intent: { ...entry.plan.intent, signature: { params: ["false-type"], results: [] } },
        },
      };
    });
    expect(altered).toBe(true);
    expectInvalid(changed, "complete callable signature");
  });
});
