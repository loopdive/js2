// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { prepareIrProgramRuntimeCallables } from "../src/ir/program-runtime-abi.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import type { TypedIrProgramInput, TypedIrProgramOptions } from "../src/ir/program/input-contracts.js";
import { asValueId, type IrInstr, type IrInstrCall } from "../src/ir/core/nodes.js";
import { irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import {
  NATIVE_ASYNC_CALLABLE_DECLARATIONS,
  collectNativeAsyncCallableDemands,
} from "../src/ir/runtime/native-async-callables.js";
import { sourcePacket, typedOptions } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

const POLICY = {
  target: "standalone",
  backend: "wasmgc",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
const OPTIONS: TypedIrProgramOptions = { ...typedOptions, policy: POLICY, runtimePolicies: [POLICY] };

function exactDelaySource(): string {
  const path = new URL("./issue-4573-standalone-native-promise-delay.test.ts", import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = source.statements
    .flatMap((statement) => (ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []))
    .filter((declaration) => declaration.name.getText(source) === "EXACT_DELAY");
  if (
    declarations.length !== 1 ||
    !declarations[0]!.initializer ||
    !ts.isNoSubstitutionTemplateLiteral(declarations[0]!.initializer)
  )
    throw new Error("missing exact native delay source fixture");
  return declarations[0]!.initializer.text;
}

function required(result: ReturnType<typeof prepareTypedIrProgram>): PreparedIrProgram {
  expect(result.kind, JSON.stringify(result.kind === "prepared" ? {} : result)).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(result.detail);
  return result.program;
}

let packet: TypedIrProgramInput;
let prepared: PreparedIrProgram;
beforeAll(() => {
  const analyzed = analyzeMultiSource({ "./entry.ts": exactDelaySource() }, "./entry.ts");
  expect(analyzed.diagnostics).toEqual([]);
  const source = prepareIrProgramSources({
    sourceFiles: analyzed.sourceFiles,
    entrySource: analyzed.entryFile,
    checker: analyzed.checker,
    policy: POLICY,
    deferTopLevelInit: false,
    promiseDelayProjection: "standalone-native",
  });
  expect(source.kind).toBe("prepared");
  if (source.kind !== "prepared") throw new Error(source.detail);
  packet = captureTypedIrProgramInput(source);
  prepared = required(prepareTypedIrProgram(packet, OPTIONS));
});

describe("typed native callable preparation and honest physical frontier", () => {
  it("prepares unchanged actual delay source and retains both original support records", () => {
    expect(exactDelaySource()).toBe(
      "\nexport function delay(ms: number, value: number): Promise<number> {\n  return new Promise<number>((resolve) => {\n    setTimeout(() => resolve(value), ms);\n  });\n}\n",
    );
    expect(packet.inventory.allUnits).toHaveLength(3);
    expect(packet.inventory.terminalUnits).toHaveLength(1);
    expect(packet.inventory.allUnits.filter((unit) => !unit.terminal)).toHaveLength(2);
    expect(prepared.inventory).toEqual(packet.inventory);
    expect(prepared.derivedUnits).toEqual([]);
    expect(prepared.ir.functions).toHaveLength(1);
    expect(collectNativeAsyncCallableDemands(prepared.ir.functions)[0]!.uses).toHaveLength(1);
    expect(prepared.runtime[0]!.prepared.manifest.features).toContain("async.native.delay");
    expect(prepared.runtime[0]!.prepared.functions[0]!.asyncRuntime).toBeUndefined();
  });

  it.each(["off", "on"] as const)(
    "retains full input inventory and canonical prepared bytes through both codecs, GVN %s",
    (gvnMode) => {
      const wire = encodeTypedPacket(packet),
        decoded = decodeTypedPacket(wire);
      expect(encodeTypedPacket(decoded)).toBe(wire);
      expect(decoded.inventory).toEqual(packet.inventory);
      const options = { ...OPTIONS, controls: { ...OPTIONS.controls, gvnMode } };
      const original = required(prepareTypedIrProgram(packet, options));
      const replayed = required(prepareTypedIrProgram(decoded, options));
      const encoded = encodePreparedIrProgram(original);
      expect(encodePreparedIrProgram(replayed)).toBe(encoded);
      const transported = decodePreparedIrProgram(encoded);
      expect(encodePreparedIrProgram(transported)).toBe(encoded);
      expect(transported.runtime).toEqual(original.runtime);
      expect(() => assertPreparedIrProgram(transported)).not.toThrow();
    },
  );

  it("retains the located physical refusal rather than treating declaration/provider rows as implementation", () => {
    const original = acceptPreparedIrProgram(prepared, replayOptions("wasmgc", "standalone"));
    const replayed = acceptPreparedIrProgram(
      decodePreparedIrProgram(encodePreparedIrProgram(prepared)),
      replayOptions("wasmgc", "standalone"),
    );
    expect(original.kind).not.toBe("accepted");
    expect(replayed).toEqual(original);
    if (original.kind === "accepted") throw new Error("unmaterialized native delay unexpectedly accepted");
    expect(original).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "build",
      unitId: packet.inventory.terminalUnits[0]!.id,
      sourceFile: "entry.ts",
    });
    expect(original.detail).toContain("physical setup cannot be materialized");
    expect(original.detail).toContain("__ir_promise_delay_native");
    expect(original.location).toMatchObject({
      declarationStart: packet.inventory.terminalUnits[0]!.declarationStart,
      declarationEnd: packet.inventory.terminalUnits[0]!.declarationEnd,
    });
  });

  it("rejects missing explicit native policy with the actual requesting source owner", () => {
    expect(prepareTypedIrProgram(packet, typedOptions)).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "build",
      unitId: packet.inventory.terminalUnits[0]!.id,
      sourceFile: "entry.ts",
      detail: expect.stringContaining("native string storage"),
    });
  });

  it.each(["missing", "duplicate", "signature", "origin", "slot"])(
    "replay rejects %s runtime ABI evidence",
    (mutation) => {
      const entries = [...prepared.abi.entries];
      const index = entries.findIndex(
        (entry) => entry.contract.kind === "callable" && entry.contract.ref.binding.kind === "runtime",
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const entry = entries[index]!;
      if (entry.contract.kind !== "callable" || entry.plan.intent.kind !== "callable")
        throw new Error("missing runtime entry");
      if (mutation === "missing") entries.splice(index, 1);
      if (mutation === "duplicate") entries.push(entry);
      if (mutation === "signature")
        entries[index] = {
          ...entry,
          contract: { ...entry.contract, results: [{ kind: "val", val: { kind: "externref" } }] },
        };
      if (mutation === "origin")
        entries[index] = { ...entry, plan: { ...entry.plan, intent: { ...entry.plan.intent, origin: "intrinsic" } } };
      if (mutation === "slot")
        entries[index] = {
          ...entry,
          plan: {
            id: entry.plan.id,
            order: entry.plan.order,
            displayName: entry.plan.displayName,
            structuralReferenceKey: entry.plan.structuralReferenceKey,
            slotPolicy: "none",
            intent: entry.plan.intent,
          },
        };
      expect(() => assertPreparedIrProgram({ ...prepared, abi: { entries } })).toThrow();
      expect(() => assertPreparedIrProgram(prepared)).not.toThrow();
    },
  );

  it("preserves unknown-runtime located failure and does not admit a wrong-kind known name", () => {
    const fn = packet.ir.functions[0]!;
    const block = fn.blocks[0]!;
    const index = block.instrs.findIndex((instr) => instr.kind === "call");
    expect(index).toBeGreaterThanOrEqual(0);
    const call = block.instrs[index] as IrInstrCall;
    for (const target of [
      irRuntimeFuncRef("unimplemented.runtime", "__ir_promise_delay_native"),
      irRuntimeFuncRef("async.clock.snapshot"),
    ]) {
      const instrs = [...block.instrs];
      instrs[index] = { ...call, target };
      const result = prepareIrProgramRuntimeCallables({
        ...packet,
        ir: { functions: [{ ...fn, blocks: [{ ...block, instrs }] }] },
      });
      expect(result).toMatchObject({
        kind: "invariant",
        code: "unknown-function-ref",
        stage: "resolve",
        unitId: fn.unitId,
        sourceFile: "entry.ts",
        detail: expect.stringContaining(target.binding.kind === "runtime" ? target.binding.symbol : "unreachable"),
      });
    }
  });

  it("gives all six logical declarations stable ABI identities, with no phantom clock slot", () => {
    // Explicitly logical fixture, not a claim of producing the full family from source.
    const empty = sourcePacket({ "./entry.ts": "export function logical(): void { return; }" }).packet;
    const fn = empty.ir.functions[0]!;
    const params = NATIVE_ASYNC_CALLABLE_DECLARATIONS.flatMap((declaration) => declaration.params).map(
      (type, index) => ({ name: `value${index}`, value: asValueId(index), type }),
    );
    let offset = 0,
      result = params.length;
    const instrs: IrInstr[] = NATIVE_ASYNC_CALLABLE_DECLARATIONS.map((declaration) => {
      const args = params.slice(offset, offset + declaration.params.length).map((param) => param.value);
      offset += declaration.params.length;
      return {
        kind: "call",
        target: declaration.ref,
        args,
        result: declaration.results.length ? asValueId(result++) : null,
        resultType: declaration.results[0] ?? null,
      };
    });
    const logical = {
      ...empty,
      ir: { functions: [{ ...fn, params, valueCount: result, blocks: [{ ...fn.blocks[0]!, instrs }] }] },
    };
    const collection = prepareIrProgramRuntimeCallables(logical);
    expect(collection.kind).toBe("prepared");
    if (collection.kind !== "prepared") throw new Error(collection.detail);
    expect(collection.declarations).toHaveLength(6);
    const entries = prepareIrProgramAbiEntries(logical, collection.declarations);
    const builtins = entries.filter(
      (entry) =>
        entry.contract.kind === "callable" && ["runtime", "intrinsic"].includes(entry.contract.ref.binding.kind),
    );
    expect(builtins).toHaveLength(6);
    const clock = builtins.find(
      (entry) => entry.contract.kind === "callable" && entry.contract.ref.name === "async.clock.snapshot",
    )!;
    expect(clock.plan).toMatchObject({ slotPolicy: "none", intent: { kind: "callable", origin: "intrinsic" } });
    expect(Object.hasOwn(clock.plan, "slotSpace")).toBe(false);
    expect(builtins.filter((entry) => entry.plan.slotPolicy === "required")).toHaveLength(5);
    const decoded = decodeTypedPacket(encodeTypedPacket(logical));
    const replayed = prepareIrProgramRuntimeCallables(decoded);
    expect(replayed).toEqual(collection);
    expect(prepareIrProgramAbiEntries(decoded, collection.declarations)).toEqual(entries);
    expect(() =>
      prepareIrProgramAbiEntries(logical, [...collection.declarations, collection.declarations[0]!]),
    ).toThrow("runtime ABI duplicates declaration");
  });
});
