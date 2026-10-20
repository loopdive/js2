// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { analyzeSource } from "../src/checker/index.js";
import { compileSourceSync } from "../src/compiler.js";
import { prepareIrProgramPresentation } from "../src/compiler/ir-program-presentation.js";
import { completedNativeNumberUndefinedPresentation } from "../src/compiler/ir-native-number-undefined-presentation.js";
import {
  finalizePreparedPipelinePresentation,
  assertCompilerNativeNumberUndefinedFinalization,
  preparedPipelineArtifacts,
  issueNativeNumberUndefinedOptimizationInput,
  nativeNumberUndefinedOptimizationObservation,
  applyIssuedNativeNumberUndefinedOptimization,
} from "../src/compiler/pipeline-result-finalizer.js";
import { emitBinary } from "../src/emit/binary.js";
import * as optimizer from "../src/optimize.js";
import * as binaryEmitter from "../src/emit/binary.js";
const source = "export function run(x:number,i:number):number{const a=[x];const v=a[i];return v===undefined?1:0;}";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
afterEach(() => vi.restoreAllMocks());
function prepare(policy: (typeof policies)[number] = policies[0], inputSource = source, optimize = true) {
  const ast = analyzeSource(inputSource, "entry.ts");
  const p = prepareIrProgramPresentation({
    preparation: {
      sourceFiles: [ast.sourceFile],
      entrySource: ast.sourceFile,
      checker: ast.checker,
      policy,
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    },
    backendOptions: {
      ...policy,
      sharedExceptionTag: false,
      utf8Storage: false,
      sourceMap: false,
      moduleName: "module",
    },
    output: {
      entryAst: ast,
      diagnosticAnchor: ast.sourceFile,
      options: { ...policy, optimize, sourceMap: false },
      errors: [],
      sourcesContent: new Map([[ast.sourceFile.fileName, inputSource]]),
      codegenOptions: { link: undefined },
    },
  });
  if (p.kind !== "prepared-presentation") throw Error(JSON.stringify(p));
  return p;
}
it.each(policies)(
  "actual productive finalization owns artifacts and runtime values %j",
  async (policy) => {
    await yieldTurn();
    const p = prepare(policy),
      before = p.emission.module;
    const done = finalizePreparedPipelinePresentation(p);
    expect(done.kind).toBe("completed-finalization");
    if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
    expect(done.finalized.success, JSON.stringify(done.finalized.errors)).toBe(true);
    expect(done.artifacts).not.toBe(done.finalized);
    expect(done.artifacts.binary).toBe(done.finalized.binary);
    if (p.requiresDetachedFinalization) expect(done.module).not.toBe(before);
    else expect(done.module).toBe(before);
    expect(() =>
      assertCompilerNativeNumberUndefinedFinalization(p, done.module, done.artifacts, done.artifacts.binary),
    ).not.toThrow();
    const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(done.artifacts.binary)), {});
    if (instance.exports._start) Reflect.apply(instance.exports._start as Function, undefined, []);
    const run = instance.exports.run as (x: number, i: number) => number;
    for (const [x, i] of [
      [2, 0],
      [NaN, 0],
      [2, 99],
      [NaN, 99],
    ])
      expect(run(x, i)).toBe(i === 0 ? 0 : 1);
    expect(() =>
      assertCompilerNativeNumberUndefinedFinalization(p, done.module, { ...done.artifacts }, done.artifacts.binary),
    ).toThrow();
    expect(() =>
      assertCompilerNativeNumberUndefinedFinalization(p, { ...before }, done.artifacts, done.artifacts.binary),
    ).toThrow();
    expect(() =>
      assertCompilerNativeNumberUndefinedFinalization(
        p,
        done.module,
        done.artifacts,
        Uint8Array.from(done.artifacts.binary),
      ),
    ).toThrow();
    if (p.requiresDetachedFinalization) expect(() => finalizePreparedPipelinePresentation(p)).toThrow();
  },
  120000,
);
it("genuine pre-finalization presentation plus actual emitted bytes cannot mint an artifact witness", async () => {
  await yieldTurn();
  const p = prepare(),
    module = p.emission.module,
    binary = emitBinary(module);
  const fabricated = { binary, success: true, errors: [], wat: "fake", dts: "fake", importsHelper: "fake" };
  expect(() => assertCompilerNativeNumberUndefinedFinalization(p, module, fabricated, binary)).toThrow(
    "actual completed compiler artifacts",
  );
  expect(() =>
    assertCompilerNativeNumberUndefinedFinalization(p, module, preparedPipelineArtifacts(fabricated as never), binary),
  ).toThrow();
});
it.each(["output", "emission", "startup"])("copied presentation %s getter refuses before effects", async (key) => {
  await yieldTurn();
  const p = prepare();
  let reads = 0;
  const fake = { ...p };
  Object.defineProperty(fake, key, {
    get() {
      reads++;
      throw Error("getter executed");
    },
  });
  const spy = vi.spyOn(binaryEmitter, "emitBinary");
  expect(() => finalizePreparedPipelinePresentation(fake)).toThrow();
  expect(reads).toBe(0);
  expect(spy).not.toHaveBeenCalled();
});
it("copied presentation and replacement captured options never acquire productive authority", async () => {
  await yieldTurn();
  const p = prepare();
  expect(() => finalizePreparedPipelinePresentation({ ...p })).toThrow();
  expect(() =>
    finalizePreparedPipelinePresentation({
      ...p,
      output: { ...p.output, options: { ...p.output.options, optimize: false } },
    }),
  ).toThrow();
});
it("original module drift refuses before finalizer output effects", async () => {
  await yieldTurn();
  const p = prepare();
  p.emission.module.exports.push({ name: "foreign", desc: { kind: "func", index: 0 } } as never);
  const spy = vi.spyOn(binaryEmitter, "emitBinary");
  if (p.requiresDetachedFinalization) expect(() => finalizePreparedPipelinePresentation(p)).toThrow();
  expect(spy).not.toHaveBeenCalled();
});
it("real emitter failure never registers completed artifact authority", async () => {
  await yieldTurn();
  const p = prepare();
  vi.spyOn(binaryEmitter, "emitBinary").mockImplementation(() => {
    throw Error("controlled final emission failure");
  });
  const done = finalizePreparedPipelinePresentation(p);
  expect(done.kind).toBe("completed-finalization");
  if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
  expect(done.finalized.success).toBe(false);
  expect(done.finalized.errors.some((e) => e.message.includes("controlled final emission failure"))).toBe(true);
  expect(() =>
    assertCompilerNativeNumberUndefinedFinalization(p, done.module, done.artifacts, done.artifacts.binary),
  ).toThrow();
});
it("ordinary scalar synchronous finalization preserves output and never invokes optimizer", async () => {
  await yieldTurn();
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
  const result = compileSourceSync("export function run(x:number):number{return x*2;}", {
    ...policies[0],
    optimize: false,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(spy).not.toHaveBeenCalled();
  const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(result.binary)), {});
  expect((instance.exports.run as (x: number) => number)(3)).toBe(6);
});

it.each([null, undefined, false, 0, "presentation", {}, Object.create(null), () => undefined])(
  "unissued presentation %s cannot enter productive finalization",
  (value) => {
    const spy = vi.spyOn(binaryEmitter, "emitBinary");
    expect(() => finalizePreparedPipelinePresentation(value as never)).toThrow("actual constructor identity");
    expect(spy).not.toHaveBeenCalled();
  },
);
it("actual presentation and captured output fields cannot be replaced with getters", async () => {
  await yieldTurn();
  const p = prepare();
  for (const key of ["output", "emission", "startup"] as const) {
    expect(Object.getOwnPropertyDescriptor(p, key)).toMatchObject({ configurable: false, writable: false });
    expect(() =>
      Object.defineProperty(p, key, {
        get() {
          throw Error("unreachable getter");
        },
      }),
    ).toThrow(TypeError);
  }
  expect(Object.isFrozen(p.output)).toBe(true);
  expect(Object.isFrozen(p.output.options)).toBe(true);
});
it.each(["exports", "globals", "memories"])(
  "actual current module %s getter rejects without invocation",
  async (key) => {
    await yieldTurn();
    const p = prepare();
    let reads = 0;
    Object.defineProperty(p.emission.module, key, {
      configurable: true,
      get() {
        reads++;
        throw Error("getter executed");
      },
    });
    const spy = vi.spyOn(binaryEmitter, "emitBinary");
    expect(() => finalizePreparedPipelinePresentation(p)).toThrow();
    expect(reads).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  },
);

it("genuine presentation rejects inherited detached getter before productive effects", async () => {
  await yieldTurn();
  const p = prepare();
  expect(Object.hasOwn(p, "requiresDetachedFinalization")).toBe(false);
  const prototype = Object.getPrototypeOf(p),
    key = "requiresDetachedFinalization";
  const before = Object.getOwnPropertyDescriptor(prototype, key);
  expect(before).toBeUndefined();
  let reads = 0;
  const spy = vi.spyOn(binaryEmitter, "emitBinary");
  try {
    Object.defineProperty(prototype, key, {
      configurable: true,
      get() {
        reads++;
        throw Error("inherited getter executed");
      },
    });
    expect(() => finalizePreparedPipelinePresentation(p)).toThrow("inherited detached flag");
    expect(reads).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    if (before) Object.defineProperty(prototype, key, before);
    else Reflect.deleteProperty(prototype, key);
  }
});
it("genuine completed tuple rejects later inherited detached getter without invocation", async () => {
  await yieldTurn();
  const p = prepare(),
    done = finalizePreparedPipelinePresentation(p);
  if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
  expect(done.finalized.success).toBe(true);
  const prototype = Object.getPrototypeOf(p),
    key = "requiresDetachedFinalization";
  const before = Object.getOwnPropertyDescriptor(prototype, key);
  expect(before).toBeUndefined();
  let reads = 0;
  try {
    Object.defineProperty(prototype, key, {
      configurable: true,
      get() {
        reads++;
        throw Error("inherited getter executed");
      },
    });
    expect(() =>
      assertCompilerNativeNumberUndefinedFinalization(p, done.module, done.artifacts, done.artifacts.binary),
    ).toThrow("inherited detached flag");
    expect(reads).toBe(0);
  } finally {
    if (before) Object.defineProperty(prototype, key, before);
    else Reflect.deleteProperty(prototype, key);
  }
  expect(() =>
    assertCompilerNativeNumberUndefinedFinalization(p, done.module, done.artifacts, done.artifacts.binary),
  ).not.toThrow();
});

it.each(["importsHelper", "dts", "wat", "sourceMap", "cHeader", "wit"] as const)(
  "pre-first issuance refuses mutation of actual produced %s field",
  async (field) => {
    await yieldTurn();
    const p = prepare(),
      done = finalizePreparedPipelinePresentation(p);
    if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
    expect(Object.hasOwn(done.artifacts, field)).toBe(true);
    Object.defineProperty(done.artifacts, field, {
      value: "caller replacement",
      writable: true,
      configurable: true,
      enumerable: true,
    });
    const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
    expect(() => issueNativeNumberUndefinedOptimizationInput(p, done.module, done.artifacts)).toThrow("construction");
    expect(nativeNumberUndefinedOptimizationObservation(done.artifacts)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  },
);
it.each(["imports", "stringPool", "targetProfile", "capabilityRequirements", "hostImportInventory"] as const)(
  "pre-first issuance refuses same-value alias replacement of produced %s",
  async (field) => {
    await yieldTurn();
    const p = prepare(),
      done = finalizePreparedPipelinePresentation(p);
    if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
    const original = done.artifacts[field];
    expect(original).toBeTypeOf("object");
    const replacement = Array.isArray(original) ? [...original] : { ...original };
    Object.defineProperty(done.artifacts, field, {
      value: replacement,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    expect(() => issueNativeNumberUndefinedOptimizationInput(p, done.module, done.artifacts)).toThrow("construction");
    expect(nativeNumberUndefinedOptimizationObservation(done.artifacts)).toBeUndefined();
  },
);
it.each(["irOutcomes", "irBodyRouteAudit", "importObject", "callerAuthority"])(
  "pre-first issuance refuses unproduced %s shape",
  async (field) => {
    await yieldTurn();
    const p = prepare(),
      done = finalizePreparedPipelinePresentation(p);
    if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
    Object.defineProperty(done.artifacts, field, { value: {}, writable: true, configurable: true, enumerable: true });
    expect(() => issueNativeNumberUndefinedOptimizationInput(p, done.module, done.artifacts)).toThrow(
      "foreign artifact shape",
    );
    expect(nativeNumberUndefinedOptimizationObservation(done.artifacts)).toBeUndefined();
  },
);
it("pre-first construction accessor refuses without invoking getter", async () => {
  await yieldTurn();
  const p = prepare(),
    done = finalizePreparedPipelinePresentation(p);
  if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
  let reads = 0;
  Object.defineProperty(done.artifacts, "importsHelper", {
    configurable: true,
    enumerable: true,
    get() {
      reads++;
      throw Error("getter executed");
    },
  });
  expect(() => issueNativeNumberUndefinedOptimizationInput(p, done.module, done.artifacts)).toThrow("construction");
  expect(reads).toBe(0);
});
it("pre-first construction refuses diagnostics population mutation", async () => {
  await yieldTurn();
  const p = prepare(),
    done = finalizePreparedPipelinePresentation(p);
  if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
  done.artifacts.errors.push({ severity: "warning", line: 1, column: 1, message: "caller diagnostic" });
  expect(() => issueNativeNumberUndefinedOptimizationInput(p, done.module, done.artifacts)).toThrow("construction");
});
it("pre-first construction refuses valid binary mutation changing actual run semantics", async () => {
  await yieldTurn();
  const p = prepare(),
    done = finalizePreparedPipelinePresentation(p);
  if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
  const binary = done.artifacts.binary;
  const run = (bytes: Uint8Array) => {
    const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {});
    if (instance.exports._start) Reflect.apply(instance.exports._start as Function, undefined, []);
    return (instance.exports.run as (x: number, i: number) => number)(2, 99);
  };
  expect(run(binary)).toBe(1);
  let changed = false;
  for (let index = 0; index + 8 < binary.length; index++) {
    if (
      binary[index] !== 0x44 ||
      binary[index + 7] !== 0xf0 ||
      binary[index + 8] !== 0x3f ||
      !Array.from(binary.subarray(index + 1, index + 7)).every((value) => value === 0)
    )
      continue;
    const candidate = Uint8Array.from(binary);
    candidate[index + 7] = 0;
    candidate[index + 8] = 0x40;
    if (!WebAssembly.validate(candidate) || run(candidate) !== 2) continue;
    binary.set(candidate);
    changed = true;
    break;
  }
  expect(changed).toBe(true);
  expect(WebAssembly.validate(Uint8Array.from(binary))).toBe(true);
  expect(run(binary)).toBe(2);
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
  expect(() => issueNativeNumberUndefinedOptimizationInput(p, done.module, done.artifacts)).toThrow(
    "constructed binary bytes changed",
  );
  expect(nativeNumberUndefinedOptimizationObservation(done.artifacts)).toBeUndefined();
  expect(spy).not.toHaveBeenCalled();
});
it("healthy constructed artifacts issue once without changing construction", async () => {
  await yieldTurn();
  const p = prepare(),
    done = finalizePreparedPipelinePresentation(p);
  if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
  issueNativeNumberUndefinedOptimizationInput(p, done.module, done.artifacts);
  expect(nativeNumberUndefinedOptimizationObservation(done.artifacts)).toMatchObject({
    accepted: false,
    disposition: "sync-pending",
  });
  expect(() =>
    assertCompilerNativeNumberUndefinedFinalization(p, done.module, done.artifacts, done.artifacts.binary),
  ).not.toThrow();
});

it("pre-first construction preserves actual absent export signature contract", async () => {
  await yieldTurn();
  const p = prepare(),
    done = finalizePreparedPipelinePresentation(p);
  if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
  expect(Object.hasOwn(done.artifacts, "exportSignatures")).toBe(true);
  expect(done.artifacts.exportSignatures).toBeUndefined();
  Object.defineProperty(done.artifacts, "exportSignatures", {
    value: [],
    configurable: true,
    enumerable: true,
    writable: true,
  });
  expect(() => issueNativeNumberUndefinedOptimizationInput(p, done.module, done.artifacts)).toThrow("construction");
});

it("accepted optimization retains direct-checker custody of original binary alias bytes", async () => {
  await yieldTurn();
  const p = prepare(),
    done = finalizePreparedPipelinePresentation(p);
  if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
  const original = done.artifacts.binary;
  issueNativeNumberUndefinedOptimizationInput(p, done.module, done.artifacts);
  await applyIssuedNativeNumberUndefinedOptimization(done.artifacts, p.output.options);
  expect(nativeNumberUndefinedOptimizationObservation(done.artifacts)).toMatchObject({
    accepted: true,
    disposition: "accepted",
  });
  expect(done.artifacts.binary).not.toBe(original);
  expect(() => assertCompilerNativeNumberUndefinedFinalization(p, done.module, done.artifacts, original)).not.toThrow();
  original[original.length - 1] ^= 1;
  expect(() => assertCompilerNativeNumberUndefinedFinalization(p, done.module, done.artifacts, original)).toThrow(
    "original constructed binary bytes changed",
  );
  expect(() => nativeNumberUndefinedOptimizationObservation(done.artifacts)).toThrow(
    "original constructed binary bytes changed",
  );
});
it("trusted warning retains diagnostics array and nested diagnostic identity", async () => {
  await yieldTurn();
  const p = prepare(),
    done = finalizePreparedPipelinePresentation(p);
  if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
  const original = done.artifacts.binary,
    errors = done.artifacts.errors;
  issueNativeNumberUndefinedOptimizationInput(p, done.module, done.artifacts);
  vi.spyOn(optimizer, "optimizeBinaryAsync").mockResolvedValue({
    binary: original,
    optimized: false,
    warning: "instrumented unavailable",
  });
  await applyIssuedNativeNumberUndefinedOptimization(done.artifacts, p.output.options);
  expect(done.artifacts.errors).toBe(errors);
  expect(errors).toHaveLength(1);
  expect(() => assertCompilerNativeNumberUndefinedFinalization(p, done.module, done.artifacts, original)).not.toThrow();
  errors[0] = { ...errors[0]! };
  expect(() => assertCompilerNativeNumberUndefinedFinalization(p, done.module, done.artifacts, original)).toThrow(
    "graph descriptor/value/alias changed",
  );
});

it("ordinary scalar completed artifacts never acquire a Number/Undefined construction witness", async () => {
  await yieldTurn();
  const p = prepare(policies[0], "export function run(x:number):number{return x*2;}", false);
  expect(
    completedNativeNumberUndefinedPresentation(p.program, p.emission, {
      ...policies[0],
      moduleName: "module",
      sharedExceptionTag: false,
      utf8Storage: false,
      sourceMap: false,
    }),
  ).toBeUndefined();
  const done = finalizePreparedPipelinePresentation(p);
  if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
  expect(done.finalized.success).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(done.artifacts.binary)), {});
  expect((instance.exports.run as (x: number) => number)(3)).toBe(6);
  expect(() =>
    assertCompilerNativeNumberUndefinedFinalization(p, done.module, done.artifacts, done.artifacts.binary),
  ).toThrow();
  expect(nativeNumberUndefinedOptimizationObservation(done.artifacts)).toBeUndefined();
});
it.each(policies)("genuine Number/Undefined optimize:false retains only construction witness %j", async (policy) => {
  await yieldTurn();
  const p = prepare(policy, source, false),
    done = finalizePreparedPipelinePresentation(p);
  expect(
    completedNativeNumberUndefinedPresentation(p.program, p.emission, {
      ...policy,
      moduleName: "module",
      sharedExceptionTag: false,
      utf8Storage: false,
      sourceMap: false,
    }),
  ).toBeDefined();
  if (done.kind !== "completed-finalization") throw Error(JSON.stringify(done));
  expect(done.finalized.success).toBe(true);
  expect(() =>
    assertCompilerNativeNumberUndefinedFinalization(p, done.module, done.artifacts, done.artifacts.binary),
  ).not.toThrow();
  issueNativeNumberUndefinedOptimizationInput(p, done.module, done.artifacts);
  expect(nativeNumberUndefinedOptimizationObservation(done.artifacts)).toBeUndefined();
  const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(done.artifacts.binary)), {});
  if (instance.exports._start) Reflect.apply(instance.exports._start as Function, undefined, []);
  const run = instance.exports.run as (x: number, i: number) => number;
  expect(run(NaN, 0)).toBe(0);
  expect(run(2, 99)).toBe(1);
});
