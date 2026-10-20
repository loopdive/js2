// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import {
  collectNativeProgramClassRequirements,
  nativeProgramClassConstruction,
} from "../src/ir/program/native-program-resource-requirements.js";

import { ts } from "../src/ts-api.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { emitBinary } from "../src/emit/binary.js";
import { BUILTIN_TYPE_TAGS } from "../src/shared/contracts/js-builtin-tags.js";
import * as sourceProducer from "../src/ir/program-source.js";
import * as directGc from "../src/codegen/index.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as astLowerer from "../src/ir/from-ast.js";

const source =
  "let count:number=0;function bump():number{count=count+1;return count;}class A{constructor(value:number){}}export function run():number{new A();new A(bump(),bump());return count;}";
function prepare(target: "standalone" | "wasi", text = source) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const policy = { backend: "wasmgc" as const, target };
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  return result.program;
}
function catalogue(program: PreparedIrProgram) {
  const projection = program.runtime[0]!;
  const requirements = collectNativeProgramClassRequirements(program, projection)!;
  return nativeProgramClassConstruction(requirements, program, projection);
}
function instructions(program: PreparedIrProgram, view: "original" | "selected") {
  const result: IrInstr[] = [];
  const functions = view === "original" ? program.ir.functions : program.runtime[0]!.prepared.functions;
  for (const fn of functions)
    for (const block of fn.blocks)
      for (const root of block.instrs) forEachInstrDeep(root, (instruction) => result.push(instruction));
  return result;
}
function expectClosedCatalogue(program: PreparedIrProgram) {
  const projection = program.runtime[0]!,
    requirements = collectNativeProgramClassRequirements(program, projection)!;
  expect(requirements.domain.definitions).toHaveLength(1);
  const { id: bindingId, definition } = requirements.domain.definitions[0]!;
  const rows = nativeProgramClassConstruction(requirements, program, projection);
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.gap).toBeUndefined();
    expect(row.targets).toHaveLength(1);
    expect(row.newTargets).toEqual([bindingId]);
    expect(row.targets[0]!.definitionId).toBe(bindingId);
    expect(row.targets[0]!.fn.unitId).toBe(definition.constructor.unitId);
    const actual = projection.prepared.functions.filter((fn) => fn.unitId === definition.constructor.unitId);
    expect(actual).toHaveLength(1);
    expect(row.targets[0]!.fn).toEqual(actual[0]);
  }
  return rows;
}
let wasi: PreparedIrProgram;
it.each(["standalone", "wasi"] as const)(
  "retains genuine %s TDZ operations and distinguishes graph closure from candidate closure",
  async (target) => {
    await yieldTurn();
    const program = prepare(target);
    if (target === "wasi") wasi = program;
    for (const view of ["original", "selected"] as const)
      expect(instructions(program, view).filter((row) => row.kind === "throw")).toHaveLength(target === "wasi" ? 4 : 0);
    const rows = catalogue(program);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.instruction.args.length)).toEqual([0, 2]);
    expectClosedCatalogue(program);
    const encoded = encodePreparedIrProgram(program),
      decoded = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(decoded)).toBe(encoded);
    expectClosedCatalogue(decoded);
    expect(catalogue(decoded).map((row) => row.gap)).toEqual(rows.map((row) => row.gap));
    await yieldTurn();
  },
);
it("retains the actual nonclosed source-control refusal before any local TDZ permission", async () => {
  await yieldTurn();
  expect(() =>
    prepare(
      "wasi",
      "let count:number=0;class A{constructor(){}}export function run():number{if(count){new A();return count;}new A();return count;}",
    ),
  ).toThrow("nonclosed control or async body");
  await yieldTurn();
});

const mutations = [
  "wrong-pair",
  "duplicate-pair",
  "wrong-source",
  "flag-mutability",
  "null-type",
  "condition-op",
  "call-target",
  "throw-ssa",
  "extra-then",
  "nonempty-else",
  "branch-dominance",
  "provider",
] as const;
it.each(mutations)("refuses %s without granting authority to modified prepared DATA", async (mutation) => {
  await yieldTurn();
  expect(wasi).toBeDefined();
  // This is deliberately unissued malformed DATA. Earlier canonical refusal also counts as refusal,
  // never as evidence that the local matcher itself ran or accepted the changed branch.
  const program: PreparedIrProgram = {
    ...wasi,
    ir: structuredClone(wasi.ir),
    startup: structuredClone(wasi.startup),
    abi: structuredClone(wasi.abi),
    runtime: wasi.runtime.map((row) => ({
      ...row,
      prepared: { ...row.prepared, manifest: structuredClone(row.prepared.manifest) },
    })),
  };
  const all = instructions(program, "original");
  const branch = all.find((row) => row.kind === "if.stmt");
  if (branch?.kind !== "if.stmt") throw Error("missing actual generated TDZ branch");
  const [message, call, thrown] = branch.then;
  if (message?.kind !== "const" || call?.kind !== "call" || thrown?.kind !== "throw")
    throw Error("wrong genuine guard");
  const binding = program.startup[0]!.bindings[0]!;
  switch (mutation) {
    case "wrong-pair":
      Reflect.set(binding, "tdzBindingId", binding.globalBindingId);
      break;
    case "duplicate-pair":
      (program.startup[0]!.bindings as (typeof binding)[]).push(binding);
      break;
    case "wrong-source":
      Reflect.set(program.startup[0]!, "sourceId", "foreign-source");
      break;
    case "flag-mutability": {
      const entry = program.abi.entries.find((row) => row.plan.id === binding.tdzBindingId)!;
      Reflect.set(entry.contract, "mutable", false);
      break;
    }
    case "null-type":
      Reflect.set(message.value, "ty", { kind: "val", val: { kind: "f64" } });
      break;
    case "condition-op": {
      const condition = all.find((row) => row.result === branch.cond)!;
      Reflect.set(condition, "op", "f64.neg");
      break;
    }
    case "call-target":
      Reflect.set(call.target.binding, "symbol", "__new_TypeError");
      break;
    case "throw-ssa":
      Reflect.set(thrown, "value", message.result);
      break;
    case "extra-then":
      (branch.then as IrInstr[]).push({ ...message });
      break;
    case "nonempty-else":
      (branch.else as IrInstr[]).push({ ...message });
      break;
    case "branch-dominance":
      Reflect.set(branch, "cond", message.result);
      break;
    case "provider":
      Reflect.set(program.runtime[0]!.prepared.manifest.providers, 0, "foreign");
      break;
  }
  let canonicalRefusal: unknown;
  let rows: ReturnType<typeof catalogue> | undefined;
  try {
    rows = catalogue(program);
  } catch (error) {
    canonicalRefusal = error;
  }
  if (canonicalRefusal === undefined) {
    expect(rows).toHaveLength(2);
    expect(
      rows!.every((row) => /opaque or reference-transporting|unissued write\/effect: throw/.test(row.gap ?? "")),
    ).toBe(true);
  } else expect(canonicalRefusal).toBeInstanceOf(Error);
  expectClosedCatalogue(wasi);
  await yieldTurn();
});
it("refuses copied and foreign acquisition even after a successful generated TDZ derivation", async () => {
  await yieldTurn();
  const projection = wasi.runtime[0]!,
    requirements = collectNativeProgramClassRequirements(wasi, projection)!;
  expectClosedCatalogue(wasi);
  expect(() => nativeProgramClassConstruction({ ...requirements }, wasi, projection)).toThrow(
    "unissued logical acquisition",
  );
  expect(() => nativeProgramClassConstruction(requirements, wasi, { ...projection })).toThrow(
    "unissued logical acquisition",
  );
  expect(Reflect.set(instructions(wasi, "original").find((row) => row.kind === "throw")!, "value", 9000)).toBe(false);
  expectClosedCatalogue(wasi);
  await yieldTurn();
});

// This independent no-construct fixture observes the existing canonical error/tag protocol.
// It provides no constructor execution or prototype/instanceof credit.
const prestart = new Map<string, PreparedIrProgram>();
let prestartLiveBinary: Uint8Array | undefined;
it.each(["prepare", "roundtrip", "live", "codec"] as const)(
  "observes genuine WASI scalar TDZ through %s without a constructor claim",
  async (phase) => {
    await yieldTurn();
    const text =
      "let count:number=7;class A{constructor(){}}export function run():number{return count;}export function bump():number{count=count+1;return count;}";
    if (phase === "prepare") {
      const javascript = ts.transpileModule(text, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const reference: { run?: () => number; bump?: () => number } = {};
      new Function("exports", javascript)(reference);
      expect([reference.run!(), reference.bump!(), reference.run!()]).toEqual([7, 8, 8]);
      const program = prepare("wasi", text);
      for (const view of ["original", "selected"] as const) {
        const rows = instructions(program, view);
        expect(rows.filter((row) => row.kind === "js.class.construct")).toHaveLength(0);
        expect(rows.filter((row) => row.kind === "throw")).toHaveLength(4);
      }
      expect(program.startup[0]!.invocation).toMatchObject({ kind: "wasi-start-export", exactlyOnce: true });
      expect(
        program.runtime[0]!.prepared.manifest.providers.some((row) => row.id === "native.error.reference.construct"),
      ).toBe(true);
      prestart.set("live", program);
      await yieldTurn();
      return;
    }
    const original = prestart.get("live");
    if (!original) throw Error("missing actual TDZ source preparation phase");
    if (phase === "roundtrip") {
      const encoded = encodePreparedIrProgram(original),
        decoded = decodePreparedIrProgram(encoded);
      expect(encodePreparedIrProgram(decoded)).toBe(encoded);
      prestart.set("codec", decoded);
      await yieldTurn();
      return;
    }
    const program = prestart.get(phase);
    if (!program) throw Error("missing actual TDZ transport peer");
    const sourcePoison = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
      throw Error("source reconstruction forbidden");
    });
    const gcPoison = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
      throw Error("legacy GC forbidden");
    });
    const linearPoison = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
      throw Error("legacy Linear forbidden");
    });
    const bodyPoison = vi.spyOn(astLowerer, "lowerNativeJsClassBodyToIr").mockImplementation(() => {
      throw Error("class source reconstruction forbidden");
    });
    const modulePoison = vi.spyOn(astLowerer, "lowerNativeJsClassModuleToIr").mockImplementation(() => {
      throw Error("class module reconstruction forbidden");
    });
    try {
      const accepted = acceptPreparedIrProgram(program, {
        backend: "wasmgc",
        target: "wasi",
        moduleName: "class-tdz",
        sharedExceptionTag: true,
        utf8Storage: false,
        sourceMap: false,
      });
      if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
      const emitted = emitAcceptedIrProgram(accepted),
        binary = new Uint8Array(emitBinary(emitted.module));
      const errorConstructor = emitted.module.functions.find((row) => row.name === "__new_ReferenceError");
      expect(errorConstructor).toBeDefined();
      expect(
        errorConstructor!.body.some((row) => row.op === "i32.const" && row.value === BUILTIN_TYPE_TAGS.ReferenceError),
      ).toBe(true);
      const tag = new WebAssembly.Tag({ parameters: ["externref"] });
      const instance = new WebAssembly.Instance(new WebAssembly.Module(binary.buffer), {
        env: { __exn: tag },
      } as unknown as WebAssembly.Imports);
      const run = instance.exports.run as () => number,
        bump = instance.exports.bump as () => number;
      let observed: unknown;
      try {
        run();
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(WebAssembly.Exception);
      const exception = observed as WebAssembly.Exception;
      expect(exception.is(tag)).toBe(true);
      expect(exception.getArg(tag, 0)).not.toBeNull();
      expect(typeof exception.getArg(tag, 0)).toBe("object");
      (instance.exports._start as () => void)();
      expect(run()).toBe(7);
      expect(bump()).toBe(8);
      (instance.exports._start as () => void)();
      expect(run()).toBe(8);
      if (phase === "live") prestartLiveBinary = binary;
      else {
        expect(prestartLiveBinary).toBeDefined();
        expect(binary).toEqual(prestartLiveBinary);
      }
      for (const poison of [sourcePoison, gcPoison, linearPoison, bodyPoison, modulePoison])
        expect(poison).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
    await yieldTurn();
  },
);
