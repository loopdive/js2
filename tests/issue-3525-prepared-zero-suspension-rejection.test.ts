// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createContext, runInContext } from "node:vm";
import { inspect, types as utilTypes } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { compileMultiSource, runPreparedIrPipelinePresentation } from "../src/compiler.js";
import * as producer from "../src/ir/async-prepare-ir.js";
import * as presentation from "../src/compiler/ir-program-presentation.js";
import * as gcCodegen from "../src/codegen/index.js";
import * as linearCodegen from "../src/codegen-linear/index.js";
import { emittedPhysicalSetupPlan, emittedProgramBindingIndex } from "../src/ir/program-consumer.js";
import { emitBinary } from "../src/emit/binary.js";
import { ts } from "../src/ts-api.js";

const SOURCE = "export async function reject(value:number):Promise<number>{if(value<0)throw null;return value+1;}";
const DIGEST = "94b33355141949ce931730767308505fb55744cd3fc79c5b68724b94101db9c5";
const CASES = [-1, -Infinity, -0, 0, 2, NaN, Infinity];
type Input = Parameters<typeof runPreparedIrPipelinePresentation>[0];
type Artifact = Extract<ReturnType<typeof runPreparedIrPipelinePresentation>, { kind: "artifacts" }>;
const snapshot = (value: unknown) => inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null });
function input(backend: "wasmgc" | "linear" = "wasmgc"): Input {
  const ast = analyzeMultiSource({ "./entry.ts": SOURCE }, "./entry.ts");
  expect(ast.syntacticDiagnostics).toEqual([]);
  return {
    userSourceFiles: ast.sourceFiles,
    entryAst: {
      sourceFile: ast.entryFile,
      checker: ast.checker,
      program: ast.program,
      diagnostics: ast.diagnostics,
      syntacticDiagnostics: ast.syntacticDiagnostics,
    },
    multiAst: ast,
    errors: [],
    codegenOptions: { link: [], sourceMap: false },
    sourcesContent: new Map(ast.sourceFiles.map((file) => [file.fileName, file.text])),
    diagnosticAnchor: ast.entryFile,
    options: {
      target: backend === "wasmgc" ? "gc" : "linear",
      optimize: false,
      sourceMap: false,
      moduleName: "zero-suspension",
    },
  };
}
function artifacts(): Artifact {
  const result = runPreparedIrPipelinePresentation(input());
  expect(result.kind, snapshot(result)).toBe("artifacts");
  if (result.kind !== "artifacts") throw Error(snapshot(result));
  expect(result.artifacts.success).toBe(true);
  expect(result.artifacts.errors).toEqual([]);
  expect(WebAssembly.validate(new Uint8Array(result.artifacts.binary))).toBe(true);
  return result;
}
function encode(value: number): number | string {
  return Number.isNaN(value)
    ? "NaN"
    : Object.is(value, -0)
      ? "-0"
      : value === Infinity
        ? "Infinity"
        : value === -Infinity
          ? "-Infinity"
          : value;
}
// Identical observation protocol runs native source and each ORIGINAL generated helper.
async function observe(reject: (value: number) => unknown, isPromise: (value: unknown) => value is Promise<unknown>) {
  const rows = [];
  for (const value of [-1, -Infinity, -0, 0, 2, NaN, Infinity, -1, 2]) {
    const events = ["before-call"];
    let returned: unknown;
    let syncThrow = false;
    try {
      returned = reject(value);
    } catch {
      syncThrow = true;
    }
    if (syncThrow) throw Error("synchronous throw");
    if (!isPromise(returned)) throw Error("not a real Promise");
    let reactions = 0;
    const reactionCount = () => reactions;
    const settled = returned.then(
      (result) => {
        reactions++;
        events.push("fulfilled");
        return { kind: "fulfilled" as const, value: result };
      },
      (reason) => {
        reactions++;
        events.push("rejected");
        return { kind: "rejected" as const, reason };
      },
    );
    events.push("after-call");
    if (reactions !== 0) throw Error("synchronous reaction");
    const result = await settled;
    await Promise.resolve();
    if (reactionCount() !== 1) throw Error("reaction not once");
    if (value < 0) {
      if (result.kind !== "rejected" || !Object.is(result.reason, null)) throw Error("reason is not exact null");
    } else if (result.kind !== "fulfilled" || typeof result.value !== "number" || !Object.is(result.value, value + 1))
      throw Error("wrong fulfillment");
    rows.push({
      input: encode(value),
      kind: result.kind,
      value: result.kind === "fulfilled" && typeof result.value === "number" ? encode(result.value) : null,
      events,
      reactions,
    });
  }
  const order: string[] = [];
  let evaluated = 0;
  const argument = (value: number) => {
    evaluated++;
    return value;
  };
  const negative = reject(argument(-1));
  const positive = reject(argument(2));
  if (!isPromise(negative) || !isPromise(positive)) throw Error("caller not a Promise");
  const a = negative.then(
    () => {
      throw Error("negative fulfilled");
    },
    (reason) => {
      if (reason !== null) throw Error("negative reason");
      order.push("negative");
    },
  );
  const b = positive.then((value) => {
    if (!Object.is(value, 3)) throw Error("positive value");
    order.push("positive");
  });
  order.push("caller");
  if (evaluated !== 2) throw Error("caller argument count");
  await Promise.all([a, b]);
  if (evaluated !== 2 || order.join(",") !== "caller,negative,positive") throw Error("caller order/count");
  return { rows, order, evaluated };
}
function native() {
  const context = createContext({});
  const module = { exports: {} as { reject: (value: number) => unknown } };
  const js = ts.transpileModule(SOURCE, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInContext(`(function(exports,module){${js}\n})`, context)(module.exports, module);
  return module.exports.reject;
}
async function helper(artifact: Pick<Artifact["artifacts"], "binary" | "importsHelper">) {
  const dir = mkdtempSync(join(tmpdir(), "zero-suspension-helper-"));
  try {
    const runtime = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;
    const adapted = artifact.importsHelper.replace('from "js2wasm"', `from ${JSON.stringify(runtime)}`);
    expect(adapted).not.toBe(artifact.importsHelper);
    writeFileSync(join(dir, "module.imports.mjs"), adapted);
    writeFileSync(join(dir, "module.wasm"), artifact.binary);
    writeFileSync(
      join(dir, "run.mjs"),
      `import {readFileSync} from 'node:fs';import {types as utilTypes} from 'node:util';import {instantiateBytes} from './module.imports.mjs';const instance=await instantiateBytes(readFileSync(new URL('./module.wasm',import.meta.url)));const encode=${encode.toString()};const observe=${observe.toString()};console.log(JSON.stringify(await observe(instance.exports.reject,utilTypes.isPromise)));`,
    );
    const child = spawnSync(process.execPath, ["--import", "tsx", join(dir, "run.mjs")], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stderr).toBe("");
    return JSON.parse(child.stdout.trim()) as Awaited<ReturnType<typeof observe>>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
afterEach(() => vi.restoreAllMocks());
describe("#3525 genuine zero-suspension conditional null rejection", () => {
  it("executes unchanged97 through native and prepared ORIGINAL helpers and checks legacy artifact metadata", async () => {
    expect(Buffer.byteLength(SOURCE)).toBe(97);
    expect(createHash("sha256").update(SOURCE).digest("hex")).toBe(DIGEST);
    const oracle = await observe(native(), utilTypes.isPromise);
    const current = artifacts();
    expect(await helper(current.artifacts)).toEqual(oracle);
    const legacy = await compileMultiSource({ "./entry.ts": SOURCE }, "./entry.ts", input().options);
    expect(legacy.success, snapshot(legacy.errors)).toBe(true);
    expect(legacy.errors).toEqual([]);
    // Issue3525 parity gap: the genuine legacy helper synchronously throws null or returns
    // raw numbers for this async source (retained seven-input diagnostic); no runtime
    // equality or legacy retirement follows. Preserve its artifact metadata oracle.
    expect(current.artifacts.dts).toBe(legacy.dts);
    expect(current.artifacts.exportSignatures?.reject?.result).toBe("promise");
    expect(oracle.rows.slice(0, 7).map((row) => row.input)).toEqual(CASES.map(encode));
  });
  it("preserves the genuine three-block helper and source-owned one-state plan before optimization", () => {
    const original = producer.prepareSuspendingIrFunction;
    const captured: { fn: Parameters<typeof original>[0]; result: NonNullable<ReturnType<typeof original>> }[] = [];
    vi.spyOn(producer, "prepareSuspendingIrFunction").mockImplementation((fn, boundary) => {
      const result = original(fn, boundary);
      if (fn.name === "reject" && result) captured.push({ fn, result });
      return result;
    });
    const current = artifacts();
    expect(captured).toHaveLength(1);
    const { fn, result } = captured[0]!;
    expect(fn.blocks).toHaveLength(3);
    expect(fn.funcKind).toBe("async");
    expect(result.stateFunctions).toHaveLength(1);
    const derived = result.stateFunctions[0]!;
    expect(derived.blocks).toEqual(fn.blocks);
    expect(derived.params).toEqual(fn.params);
    expect(derived.resultTypes).toEqual(fn.resultTypes);
    expect(derived.valueCount).toBe(fn.valueCount);
    expect(derived.funcKind).toBe("regular");
    expect(derived.exported).toBe(false);
    expect(result.provenance).toHaveLength(1);
    expect(result.provenance[0]).toMatchObject({
      id: derived.unitId,
      parentId: fn.unitId,
      role: "ir-async-state",
      ordinal: 0,
    });
    const plan = result.main.asyncPlan!;
    expect(plan.ownerUnitId).toBe(fn.unitId);
    expect(plan.states).toHaveLength(1);
    expect(plan.spills).toEqual([]);
    expect(plan.handlers).toEqual([]);
    expect(plan.states[0]!.terminator.kind).toBe("resolve");
    expect(plan.abi.fulfillmentType).toEqual({ kind: "val", val: { kind: "f64" } });
    expect(plan.abi.rejectionType).toBe("dynamic");
    expect(current.program.derivedUnits).toContainEqual(
      expect.objectContaining({ id: derived.unitId, parentId: fn.unitId, role: "ir-async-state", ordinal: 0 }),
    );
    expect(current.emission.emittedUnitIds).toContain(derived.unitId);
    const frame = emittedPhysicalSetupPlan(current.emission).asyncFrames!;
    expect(frame.frames).toHaveLength(1);
    expect(current.program.inventory.sources).toHaveLength(1);
  });
  it("finalizes detached output while preserving the original accepted emission and actual helper binding", () => {
    const original = presentation.beginPreparedPresentationFinalization;
    let handoff: Parameters<typeof original>[0] | undefined;
    let bytes: Uint8Array | undefined;
    let before = "";
    const begin = vi.spyOn(presentation, "beginPreparedPresentationFinalization").mockImplementation((value) => {
      handoff = value;
      before = snapshot(value.emission.module);
      bytes = emitBinary(value.emission.module);
      return original(value);
    });
    const current = artifacts();
    expect(begin).toHaveBeenCalledTimes(1);
    expect(current.program).toBe(handoff!.program);
    expect(current.emission).toBe(handoff!.emission);
    expect(snapshot(current.emission.module)).toBe(before);
    expect(emitBinary(current.emission.module)).toEqual(bytes);
    expect(current.finalization?.originalEmissionUnchanged).toBe(true);
    const plan = emittedPhysicalSetupPlan(current.emission);
    expect(emittedPhysicalSetupPlan(current.emission)).toBe(plan);
    const exports = current.emission.module.exports.filter((row) => row.name === "reject");
    expect(exports).toHaveLength(1);
    expect(exports[0]!.desc.kind).toBe("func");
    const frame = plan.asyncFrames!.frames[0]!;
    expect(frame).toBeDefined();
    // All actual async entry aliases must resolve to the certified target, not guessed callback names.
    for (const callback of frame.callbacks) {
      expect(plan.asyncFrames!.entries.filter((row) => row.id === callback.entry.id)).toEqual([callback.entry]);
      const target = emittedProgramBindingIndex(current.emission, callback.targetBindingId);
      expect(target?.space).toBe("function");
      expect(emittedProgramBindingIndex(current.emission, callback.entry.id)).toEqual(target);
      expect(current.emission.module.exports).toContainEqual({
        name: callback.externalName,
        desc: { kind: "func", index: target!.index },
      });
    }
  });
  it("uses real IR admission without any attached legacy body generator", () => {
    const poison = () => {
      throw Error("zero-suspension legacy body poison");
    };
    vi.spyOn(gcCodegen, "generateModule").mockImplementation(poison);
    vi.spyOn(gcCodegen, "generateMultiModule").mockImplementation(poison);
    vi.spyOn(linearCodegen, "generateLinearModule").mockImplementation(poison);
    vi.spyOn(linearCodegen, "generateLinearMultiModule").mockImplementation(poison);
    expect(artifacts().emission.emittedUnitIds.length).toBeGreaterThan(0);
  });
  it("refuses genuine captured CFG near-misses at the producer while retaining a fresh healthy witness", () => {
    const original = producer.prepareSuspendingIrFunction;
    let owner: Parameters<typeof original>[0] | undefined;
    vi.spyOn(producer, "prepareSuspendingIrFunction").mockImplementation((fn, boundary) => {
      const result = original(fn, boundary);
      if (fn.name === "reject" && result) owner = fn;
      return result;
    });
    artifacts();
    expect(owner).toBeDefined();
    if (!owner) throw Error("genuine original typed owner absent");
    const fresh = () => structuredClone(owner!);
    const variants: { name: string; fn: Parameters<typeof original>[0] }[] = [];
    const target = fresh();
    const branch = target.blocks[0]!.terminator;
    if (branch.kind !== "br_if") throw Error("genuine branch absent");
    variants.push({
      name: "duplicate branch target",
      fn: {
        ...target,
        blocks: target.blocks.map((block, index) =>
          index === 0
            ? { ...block, terminator: { ...branch, ifTrue: { ...branch.ifTrue, target: branch.ifFalse.target } } }
            : block,
        ),
      },
    });
    const arguments_ = fresh();
    const edge = arguments_.blocks[0]!.terminator;
    if (edge.kind !== "br_if") throw Error("genuine branch absent");
    variants.push({
      name: "nonempty branch arguments",
      fn: {
        ...arguments_,
        blocks: arguments_.blocks.map((block, index) =>
          index === 0
            ? { ...block, terminator: { ...edge, ifTrue: { ...edge.ifTrue, args: [arguments_.params[0]!.value] } } }
            : block,
        ),
      },
    });
    const carrier = fresh();
    const nullValue = carrier.blocks[1]!.instrs[0]!;
    expect(nullValue.kind).toBe("const");
    variants.push({
      name: "mismatched null result carrier",
      fn: {
        ...carrier,
        blocks: carrier.blocks.map((block, index) =>
          index === 1
            ? {
                ...block,
                instrs: block.instrs.map((instr, ordinal) =>
                  ordinal === 0 ? { ...instr, resultType: { kind: "val", val: { kind: "f64" } } } : instr,
                ),
              }
            : block,
        ),
      },
    });
    const use = fresh();
    const thrown = use.blocks[1]!.instrs[1]!;
    if (thrown.kind !== "throw") throw Error("genuine throw absent");
    variants.push({
      name: "throw uses numeric parameter instead of null",
      fn: {
        ...use,
        blocks: use.blocks.map((block, index) =>
          index === 1
            ? {
                ...block,
                instrs: block.instrs.map((instr, ordinal) =>
                  ordinal === 1 ? { ...thrown, value: use.params[0]!.value } : instr,
                ),
              }
            : block,
        ),
      },
    });
    const extra = fresh();
    variants.push({
      name: "extra duplicate CFG block",
      fn: { ...extra, blocks: [...extra.blocks, structuredClone(extra.blocks[1]!)] },
    });
    for (const variant of variants) {
      expect(original(fresh()), "healthy before " + variant.name).not.toBeNull();
      expect(original(variant.fn), "producer refusal " + variant.name).toBeNull();
      expect(original(fresh()), "healthy after " + variant.name).not.toBeNull();
    }
  });
  it("retains the separate genuine Linear Promise capability refusal", () => {
    artifacts();
    const result = runPreparedIrPipelinePresentation(input("linear"));
    expect(result.kind, snapshot(result)).toBe("unsupported");
    if (result.kind !== "unsupported") throw Error(snapshot(result));
    expect(result.failure.detail).toMatch(/promise\.capability\.create has no linear adapter/);
    expect(result).not.toHaveProperty("artifacts");
  });
});
