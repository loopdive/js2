// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { beforeOptionalFieldModuleRecords } from "./helpers/ir-initial-graph-optional-fields-source.js";
import {
  authenticateProgramInitialGraphEvolution,
  createProgramInitialGraphReader,
  programInitialGraphInputPaths,
  programInitialGraphPaths,
  programInitialGraphPin,
  programInitialGraphReceiptPath,
  ProgramInitialGraphEvolutionError,
  reconstructProgramInitialGraph,
  verifyProgramInitialGraphReciprocal,
  type ProgramInitialGraphReader,
} from "./helpers/ir-program-initial-graph-evolution.js";
import { beforeCanonicalInstructionsSource, reconstructC1CurrentSources } from "./helpers/ir-c1-current-source.js";
import { runtimeProgramRelocationPairs } from "./helpers/ir-runtime-program-relocation.js";
import { captureSourceMapSchemaSourceEpoch } from "./helpers/ir-program-validator-relocation.js";

const target = "src/wasm/model/module-records.ts";
const currentPin = {
  bytes: 4111,
  sha256: "7a16486fdc674335c690ed51c4e2767486732275b3acad00af5429a7d3ebf4cc",
  gitBlob: "8ff4cab7afb94aea25b5b5a79a07fe89d0538d12",
};
const priorPin = {
  bytes: 3867,
  sha256: "0de6972cbc506dc29a04119fed1efbf9a4b84e4219a52363c120e0130364ae75",
  gitBlob: "c700df20e0e24aa54b0dd5d4a438773c22deb6f7",
};
const insertion =
  "  /**\n   * (#6867) The source property is declared optional (`k?: T`). A typed-ref\n   * coercion from a shape that lacks this field may complete it with\n   * `undefined` instead of failing its guarded downcast to null.\n   */\n  optional?: true;\n";
const actual = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const receiptText = actual(programInitialGraphReceiptPath);
const receipt = authenticateProgramInitialGraphEvolution(receiptText);

afterEach(async () => {
  await setImmediate();
});

function beforeC1(): ProgramInitialGraphReader {
  const sources = reconstructC1CurrentSources(actual);
  const sourceEpoch = captureSourceMapSchemaSourceEpoch(actual);
  const sourceEpochPaths: readonly string[] = [
    "src/ir/program/input-contracts.ts",
    "src/ir/program/prepared-contracts.ts",
    "src/ir/program/input.ts",
    "src/shared/contracts/ir-unit-inventory.ts",
  ];
  const historicalRuntimeRead = (path: string): string => {
    if (runtimeProgramRelocationPairs.some(([donor]) => donor === path)) {
      const source = sources.get(path as Parameters<typeof sources.get>[0]);
      if (source === undefined) throw new Error(`missing genuine C1 donor: ${path}`);
      return source;
    }
    const source = actual(path);
    return path === "src/wasm/model/instructions.ts" ? beforeCanonicalInstructionsSource(source) : source;
  };
  return (path) => {
    const source = historicalRuntimeRead(path);
    return sourceEpochPaths.includes(path) ? sourceEpoch.before(path, source) : source;
  };
}
function failure(run: () => unknown): ProgramInitialGraphEvolutionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProgramInitialGraphEvolutionError);
    return error as ProgramInitialGraphEvolutionError;
  }
  throw new Error("expected actual initial-graph refusal");
}
function changed(reader: ProgramInitialGraphReader, value: unknown): ProgramInitialGraphReader {
  return (path) => (path === target ? (value as string | undefined) : reader(path));
}

describe("finite initial-graph optional-field source association", () => {
  it("lazily authenticates exact current and prior pins and replays the complete current bytes", () => {
    const calls: string[] = [];
    const view: (path: string) => string = beforeOptionalFieldModuleRecords((path) => {
      calls.push(path);
      return actual(path);
    });
    expect(calls).toEqual([]);
    const current = actual(target),
      prior = view(target)!;
    expect(programInitialGraphPin(current)).toEqual(currentPin);
    expect(programInitialGraphPin(prior)).toEqual(priorPin);
    expect(receipt.inputs.find((input) => input.path === target)).toEqual({ path: target, ...priorPin });
    const bytes = Buffer.from(current),
      old = Buffer.from(prior),
      span = Buffer.from(insertion);
    expect(span.length).toBe(244);
    expect(bytes.subarray(2806, 3050).toString()).toBe(insertion);
    expect(Buffer.concat([old.subarray(0, 2806), span, old.subarray(2806)])).toEqual(bytes);
    expect(view(target)).toBe(prior);
    expect(calls).toEqual([target, target]);
    expect(actual(target)).toBe(current);
  });
  it("requires a callable supplied reader without observing a noncallable object", () => {
    let touched = 0;
    const object = {
      valueOf() {
        touched++;
        throw new Error("coercion observed");
      },
    };
    expect(failure(() => beforeOptionalFieldModuleRecords(object as unknown as ProgramInitialGraphReader)).code).toBe(
      "missing-source",
    );
    expect(touched).toBe(0);
  });
  it("lets unchanged kernel receipt authentication refuse before any supplied-source read", () => {
    let reads = 0;
    const view = beforeOptionalFieldModuleRecords(() => {
      reads++;
      throw new Error("source observed");
    });
    expect(failure(() => reconstructProgramInitialGraph(view, receiptText + "\n")).code).toBe("receipt");
    expect(reads).toBe(0);
  });
  it("proves genuine current-model refusal and the four old-pinned historical outputs", () => {
    const raw = beforeC1();
    const otherInputs = receipt.inputs.filter((input) => input.path !== target);
    expect(otherInputs).toHaveLength(16);
    for (const input of otherInputs)
      expect(programInitialGraphPin(raw(input.path)!)).toEqual({
        bytes: input.bytes,
        sha256: input.sha256,
        gitBlob: input.gitBlob,
      });
    expect(programInitialGraphPin(raw(target)!)).toEqual(currentPin);
    const refusal = failure(() => reconstructProgramInitialGraph(raw));
    expect(refusal.code).toBe("pin");
    expect(refusal.message).toContain(target);
    const view = beforeOptionalFieldModuleRecords(raw);
    const sources = reconstructProgramInitialGraph(view);
    expect([...sources.keys()]).toEqual(programInitialGraphPaths);
    expect(sources.size).toBe(4);
    for (const output of receipt.outputs)
      expect(programInitialGraphPin(sources.get(output.path)!)).toEqual({
        bytes: output.bytes,
        sha256: output.sha256,
        gitBlob: output.gitBlob,
      });
    expect(sources.has(target)).toBe(false);
    expect(Buffer.byteLength(actual(target))).toBe(currentPin.bytes);
  });
  it("captures exactly seventeen sources and the nested receipt afresh on two successive constructions", () => {
    const raw = beforeC1(),
      calls: string[] = [];
    const view = beforeOptionalFieldModuleRecords((path) => {
      calls.push(path);
      return raw(path);
    });
    const expected = [...programInitialGraphInputPaths, receipt.preAReceipt.path];
    const first = reconstructProgramInitialGraph(view);
    expect(calls).toEqual(expected);
    const second = reconstructProgramInitialGraph(view);
    expect(calls).toEqual([...expected, ...expected]);
    expect([...second]).toEqual([...first]);
    expect(first).not.toBe(second);
  });
  it("retains all three genuine kernel APIs and delegates module-records as an unknown output path", () => {
    const raw = beforeC1(),
      view = beforeOptionalFieldModuleRecords(raw);
    const outputs = reconstructProgramInitialGraph(view);
    const historical = createProgramInitialGraphReader(view);
    for (const path of programInitialGraphPaths) expect(historical(path)).toBe(outputs.get(path));
    expect(historical(target)).toBe(view(target));
    expect(programInitialGraphPaths).not.toContain(target);
    for (const record of receipt.records)
      expect(() =>
        verifyProgramInitialGraphReciprocal(record.path, view(record.path)!, outputs.get(record.path)!, view),
      ).not.toThrow();
    expect(programInitialGraphPin(actual(target))).toEqual(currentPin);
  });
  for (const kind of ["exact prior", "optional span", "unrelated body", "trailing source"] as const)
    it(`refuses ${kind} as current without normalizing it`, () => {
      const live = actual(target),
        prior = beforeOptionalFieldModuleRecords(actual)(target)!;
      const bad =
        kind === "exact prior"
          ? prior
          : kind === "optional span"
            ? live.replace("optional?: true;", "optional?: false;")
            : kind === "unrelated body"
              ? live.replace("export interface FieldDef", "export interface ForeignFieldDef")
              : live + "\n";
      expect(bad).not.toBe(live);
      expect(failure(() => beforeOptionalFieldModuleRecords(() => bad)(target)).code).toBe("pin");
    });
  for (const kind of ["undefined", "null", "empty", "boxed", "object"] as const)
    it(`refuses ${kind} target sources with zero coercion`, () => {
      let observed = 0;
      const object = {
        toString() {
          observed++;
          throw new Error("coercion observed");
        },
        valueOf() {
          observed++;
          throw new Error("coercion observed");
        },
      };
      const value =
        kind === "undefined"
          ? undefined
          : kind === "null"
            ? null
            : kind === "empty"
              ? ""
              : kind === "boxed"
                ? Object.assign(new String(actual(target)), object)
                : object;
      expect(failure(() => beforeOptionalFieldModuleRecords(() => value as string | undefined)(target)).code).toBe(
        "pin",
      );
      expect(observed).toBe(0);
    });
  it("observes a changed target after warm success and accepts fresh restoration", () => {
    const live = actual(target);
    let value = live,
      reads = 0;
    const view = beforeOptionalFieldModuleRecords(() => {
      reads++;
      return value;
    });
    const prior = view(target);
    value += "\n";
    expect(failure(() => view(target)).code).toBe("pin");
    value = live;
    expect(view(target)).toBe(prior);
    expect(reads).toBe(3);
    expect(actual(target)).toBe(live);
  });
  it("delegates unknown paths unchanged on every request including malicious values and undefined", () => {
    const unknown = "src/unknown-optional-fields.ts",
      calls: string[] = [];
    let value: unknown = {
      toString() {
        throw new Error("unknown coercion observed");
      },
    };
    const view = beforeOptionalFieldModuleRecords((path) => {
      calls.push(path);
      return value as string | undefined;
    });
    expect(view(unknown)).toBe(value);
    value = "changed raw unknown";
    expect(view(unknown)).toBe(value);
    value = undefined;
    expect(view(unknown)).toBeUndefined();
    expect(calls).toEqual([unknown, unknown, unknown]);
  });
  it("propagates supplied reader exception identity directly", () => {
    const error = new Error("actual supplied reader failed");
    const view = beforeOptionalFieldModuleRecords(() => {
      throw error;
    });
    for (const path of [target, "src/unknown.ts"]) {
      let caught: unknown;
      try {
        view(path);
      } catch (failure) {
        caught = failure;
      }
      expect(caught).toBe(error);
    }
  });
  it("preserves the unchanged kernel missing-source wrapper and typed pin cause for changed live input", () => {
    const raw = beforeC1();
    const view = beforeOptionalFieldModuleRecords(changed(raw, actual(target) + "\n"));
    const outer = failure(() => reconstructProgramInitialGraph(view));
    expect(outer.code).toBe("missing-source");
    expect(outer.cause).toBeInstanceOf(ProgramInitialGraphEvolutionError);
    expect((outer.cause as ProgramInitialGraphEvolutionError).code).toBe("pin");
    expect((outer.cause as Error).message).toContain(target);
  });
  it("passes genuine post-view historical mutations directly to the unchanged old kernel", () => {
    const raw = beforeC1(),
      view = beforeOptionalFieldModuleRecords(raw);
    reconstructProgramInitialGraph(view);
    const old = view(target)!;
    const mutant = changed(view, old + "\n");
    const refusal = failure(() => reconstructProgramInitialGraph(mutant));
    expect(refusal.code).toBe("pin");
    expect(refusal.cause).toBeUndefined();
    expect(refusal.message).toContain(target);
    expect(() => reconstructProgramInitialGraph(view)).not.toThrow();
    expect(programInitialGraphPin(actual(target))).toEqual(currentPin);
  });
});
