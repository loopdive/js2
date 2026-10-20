// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { compileSource, compileSourceSync, compileMultiSource } from "../src/compiler.js";
import * as compilerLifecycle from "../src/compiler/pipeline-result-finalizer.js";
import * as optimizer from "../src/optimize.js";
import * as legacyGc from "../src/codegen/index.js";
import * as legacyLinear from "../src/codegen-linear/index.js";
import {
  applyIssuedNativeNumberUndefinedOptimization,
  nativeNumberUndefinedOptimizationObservation,
  issueNativeNumberUndefinedOptimizationInput,
} from "../src/compiler/ir-native-number-undefined-optimization.js";
import { inspectNativeNumberUndefinedBinary } from "../src/wasm/physical/native-number-undefined-binary.js";
import { analyzeSource } from "../src/checker/index.js";
import {
  prepareIrProgramPresentation,
  preparedPresentationNativeDts,
} from "../src/compiler/ir-program-presentation.js";
import { emitBinary } from "../src/emit/binary.js";
import { resolveCompileTargetProfile } from "../src/target-profile.js";
import type { CompileOptions } from "../src/index.js";
const source = "export function run(x:number,i:number):number{const a=[x];const v=a[i];return v===undefined?1:0;}";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const options = { ...policies[0], sourceMap: false, optimize: true } as const;
afterEach(() => vi.restoreAllMocks());
function run(binary: Uint8Array) {
  expect(WebAssembly.validate(Uint8Array.from(binary))).toBe(true);
  const module = new WebAssembly.Module(Uint8Array.from(binary));
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  if (instance.exports._start) Reflect.apply(instance.exports._start as Function, undefined, []);
  for (const [x, i] of [
    [2, 0],
    [NaN, 0],
    [2, 99],
    [NaN, 99],
    [2, -1],
    [2, 0.5],
    [2, NaN],
    [-0, 0],
  ])
    expect(
      Object.is(Reflect.apply(instance.exports.run as Function, undefined, [x, i]), [x][i] === undefined ? 1 : 0),
    ).toBe(true);
}
it("keeps sync optimization pending without Binaryen effects or changed bytes on all four profiles", async () => {
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
  for (const policy of policies) {
    await yieldTurn();
    const no = compileSourceSync(source, { ...policy, sourceMap: false, optimize: false });
    const yes = compileSourceSync(source, { ...policy, sourceMap: false, optimize: true });
    expect(no.success, JSON.stringify(no.errors)).toBe(true);
    expect(yes.success, JSON.stringify(yes.errors)).toBe(true);
    expect(yes.binary).toEqual(no.binary);
    expect(nativeNumberUndefinedOptimizationObservation(yes)).toMatchObject({
      level: 3,
      attempted: false,
      accepted: false,
      disposition: "sync-pending",
    });
    run(yes.binary);
  }
  expect(spy).not.toHaveBeenCalled();
}, 120000);
it("invokes actual optimizer and authenticates accepted or explicit fallback outputs on four profiles", async () => {
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
  const gc = vi.spyOn(legacyGc, "generateModule").mockImplementation(() => {
    throw Error("legacy GC forbidden");
  });
  const linear = vi.spyOn(legacyLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("legacy Linear forbidden");
  });
  const receipts: unknown[] = [];
  for (const policy of policies) {
    await yieldTurn();
    const result = await compileSource(source, { ...policy, sourceMap: false, optimize: true });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const observation = nativeNumberUndefinedOptimizationObservation(result)!;
    receipts.push({
      ...policy,
      ...observation,
      warnings: result.errors.filter((row) => row.severity === "warning").map((row) => row.message),
    });
    expect(observation).toMatchObject({ level: 3, attempted: true });
    expect(observation.accepted || result.errors.some((row) => row.severity === "warning")).toBe(true);
    run(result.binary);
  }
  console.info("native Number/Undefined actual optimization receipts", JSON.stringify(receipts));
  expect(spy).toHaveBeenCalledTimes(4);
  expect(gc).not.toHaveBeenCalled();
  expect(linear).not.toHaveBeenCalled();
}, 120000);
it.each([1, 2, 3, 4] as const)(
  "binds genuine optimizer level %s in both async single and multi wrappers",
  async (level) => {
    await yieldTurn();
    const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
    const opts = { ...options, optimize: level };
    for (const result of [
      await compileSource(source, opts),
      await compileMultiSource({ "entry.ts": source }, "entry.ts", opts),
    ]) {
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      expect(nativeNumberUndefinedOptimizationObservation(result)).toMatchObject({ level, attempted: true });
      run(result.binary);
    }
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.every((row) => row[1]?.level === level)).toBe(true);
  },
  120000,
);
it.each([0, -1, 5, 1.5, NaN, Infinity, "true", {}])("refuses invalid native optimization request %s", async (value) => {
  await yieldTurn();
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
  const result = compileSourceSync(source, { ...options, optimize: value } as CompileOptions);
  expect(result.success).toBe(false);
  expect(spy).not.toHaveBeenCalled();
});
it("preserves scalar true refusal and scalar false success without issuing native receipt", async () => {
  await yieldTurn();
  const scalar = "export function run(x:number):number{return x*2;}";
  const no = compileSourceSync(scalar, { ...options, optimize: false });
  const yes = compileSourceSync(scalar, options);
  expect(no.success).toBe(true);
  expect(nativeNumberUndefinedOptimizationObservation(no)).toBeUndefined();
  expect(yes.success).toBe(false);
  expect(yes.errors.some((row) => row.message.includes("separate complete presentation contract"))).toBe(true);
});
it.each([{ sourceMap: true }, { abi: "c" as const }])("retains immediate unrelated output gate %s", async (extra) => {
  await yieldTurn();
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
  expect(compileSourceSync(source, { ...options, ...extra }).success).toBe(false);
  expect(spy).not.toHaveBeenCalled();
});
it("refuses copied result authority and original byte drift before optimizer effects", async () => {
  await yieldTurn();
  const result = compileSourceSync(source, options);
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
  expect(await applyIssuedNativeNumberUndefinedOptimization({ ...result }, options)).toBeUndefined();
  result.binary[8] ^= 1;
  await expect(applyIssuedNativeNumberUndefinedOptimization(result, options)).rejects.toThrow();
  expect(spy).not.toHaveBeenCalled();
});
it("keeps exact bytes on real unavailable result and consumes input once", async () => {
  await yieldTurn();
  const result = compileSourceSync(source, options),
    before = Uint8Array.from(result.binary);
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  vi.spyOn(optimizer, "optimizeBinaryAsync").mockImplementation(async (binary) => ({
    binary,
    optimized: false,
    warning: "instrumented optimizer unavailable",
  }));
  expect(await applyIssuedNativeNumberUndefinedOptimization(result, options)).toBe(result);
  expect(result.binary).toEqual(before);
  expect(nativeNumberUndefinedOptimizationObservation(result)).toMatchObject({
    attempted: true,
    accepted: false,
    disposition: "unavailable",
  });
  await expect(applyIssuedNativeNumberUndefinedOptimization(result, options)).rejects.toThrow("consumed");
});
it("rejects valid but wrong public export candidate and preserves original bytes visibly", async () => {
  await yieldTurn();
  const result = compileSourceSync(source, options),
    before = Uint8Array.from(result.binary);
  const other = compileSourceSync("export function wrong(x:number):number{return x;}", { ...options, optimize: false });
  vi.spyOn(optimizer, "optimizeBinaryAsync").mockResolvedValue({ binary: other.binary, optimized: true });
  await applyIssuedNativeNumberUndefinedOptimization(result, options);
  expect(result.binary).toEqual(before);
  expect(nativeNumberUndefinedOptimizationObservation(result)).toMatchObject({
    attempted: true,
    accepted: false,
    disposition: "rejected",
  });
  expect(result.errors.some((row) => row.message.includes("public boundary drift"))).toBe(true);
});
it("rejects semantic/options drift during await rather than treating stale original as fallback", async () => {
  await yieldTurn();
  const opts: CompileOptions = { ...options },
    result = compileSourceSync(source, opts);
  vi.spyOn(optimizer, "optimizeBinaryAsync").mockImplementation(async (binary) => {
    opts.optimize = 2;
    return { binary, optimized: false, warning: "unavailable" };
  });
  await expect(applyIssuedNativeNumberUndefinedOptimization(result, opts)).rejects.toThrow("options changed");
});
it.each(["getter", "shadow", "prototype"])("screens binary %s before engine/decoder effects", (kind) => {
  const binary = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
  let reads = 0;
  if (kind === "getter")
    Object.defineProperty(binary, "shadow", {
      get() {
        reads++;
        return 0;
      },
    });
  if (kind === "shadow") Object.defineProperty(binary, "shadow", { value: 0 });
  if (kind === "prototype") Object.setPrototypeOf(binary, Object.create(Uint8Array.prototype));
  expect(() => inspectNativeNumberUndefinedBinary(binary)).toThrow();
  expect(reads).toBe(0);
});

it("rejects malformed warning before any candidate commit and preserves original buffer identity", async () => {
  await yieldTurn();
  const result = compileSourceSync(source, options),
    original = result.binary,
    before = Uint8Array.from(original);
  const candidate = Uint8Array.from(original);
  vi.spyOn(optimizer, "optimizeBinaryAsync").mockResolvedValue({
    binary: candidate,
    optimized: true,
    warning: 123,
  } as unknown as optimizer.OptimizeResult);
  await applyIssuedNativeNumberUndefinedOptimization(result, options);
  expect(result.binary).toBe(original);
  expect(result.binary).toEqual(before);
  expect(nativeNumberUndefinedOptimizationObservation(result)).toMatchObject({
    attempted: true,
    optimized: true,
    accepted: false,
    disposition: "rejected",
  });
  expect(result.errors.some((row) => row.message.includes("warning DATA") && row.message.includes("unoptimized"))).toBe(
    true,
  );
});
it("records thrown actual invocation as failed with no accepted bytes and preserves thrown semantics", async () => {
  await yieldTurn();
  const result = compileSourceSync(source, options),
    original = result.binary;
  const error = new Error("instrumented invocation failure");
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync").mockRejectedValue(error);
  await expect(applyIssuedNativeNumberUndefinedOptimization(result, options)).rejects.toBe(error);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(result.binary).toBe(original);
  expect(nativeNumberUndefinedOptimizationObservation(result)).toMatchObject({
    attempted: true,
    optimized: undefined,
    accepted: false,
    disposition: "failed",
  });
});

it("does not issue arbitrary artifact copies from a genuine presentation before compiler finalization", async () => {
  await yieldTurn();
  const ast = analyzeSource(source, "entry.ts");
  const p = prepareIrProgramPresentation({
    preparation: {
      sourceFiles: [ast.sourceFile],
      entrySource: ast.sourceFile,
      checker: ast.checker,
      policy: policies[0],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    },
    backendOptions: {
      ...policies[0],
      sharedExceptionTag: false,
      utf8Storage: false,
      sourceMap: false,
      moduleName: "module",
    },
    output: {
      entryAst: ast,
      diagnosticAnchor: ast.sourceFile,
      options,
      errors: [],
      sourcesContent: new Map([[ast.sourceFile.fileName, source]]),
      codegenOptions: { link: undefined },
    },
  });
  expect(p.kind).toBe("prepared-presentation");
  if (p.kind !== "prepared-presentation") throw Error(JSON.stringify(p));
  const fields = [
    "wat",
    "importsHelper",
    "stringPool",
    "sourceMap",
    "imports",
    "runtimeRecGroupFingerprint",
    "hostImportInventory",
    "hostImportSummary",
    "capabilityRequirements",
    "capabilityProviderDiagnostics",
    "cHeader",
    "wit",
    "hasMain",
    "hasTopLevelStatements",
    "exportBoundaryPolicies",
    "adapterManifest",
    "explanation",
  ];
  const fabricated = Object.fromEntries(fields.map((key) => [key, undefined]));
  Object.assign(fabricated, {
    binary: emitBinary(p.emission.module),
    dts: preparedPresentationNativeDts(p, p.emission.module),
    success: true,
    errors: [],
    exportSignatures: p.emission.module.exportSignatures,
    targetProfile: resolveCompileTargetProfile(options),
    wat: "fabricated WAT",
    importsHelper: "fabricated helper",
  });
  expect(() =>
    issueNativeNumberUndefinedOptimizationInput(
      p,
      p.emission.module,
      fabricated as unknown as Parameters<typeof issueNativeNumberUndefinedOptimizationInput>[2],
    ),
  ).toThrow();
});
it("measures actual Linear optimizer sections without admitting unreceived grammar", async () => {
  await yieldTurn();
  const result = compileSourceSync(source, options);
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const actual = await optimizer.optimizeBinaryAsync(Uint8Array.from(result.binary), { level: 3 });
  if (!actual.optimized) {
    console.info("Linear optimizer unavailable", actual.warning);
    return;
  }
  let at = 8;
  const read = () => {
    let value = 0,
      shift = 0;
    for (;;) {
      const b = actual.binary[at++]!;
      value += (b & 127) * 2 ** shift;
      if (!(b & 128)) return value;
      shift += 7;
    }
  };
  const sections: unknown[] = [];
  while (at < actual.binary.length) {
    const id = actual.binary[at++]!,
      size = read(),
      begin = at,
      end = begin + size;
    if (id === 12) sections.push({ id, size, dataCount: read(), consumed: at === end });
    else if (id === 11) {
      const segmentCount = read(),
        segments: unknown[] = [];
      for (let n = 0; n < segmentCount; n++) {
        const mode = read(),
          opcode = actual.binary[at++]!,
          offset = read(),
          terminator = actual.binary[at++]!,
          length = read();
        const bytes = [...actual.binary.subarray(at, at + length)];
        at += length;
        segments.push({ mode, opcode, offset, terminator, length, bytes });
      }
      sections.push({ id, size, segmentCount, segments, consumed: at === end });
    } else sections.push({ id, size });
    at = end;
  }
  console.info("actual Linear optimized section census", JSON.stringify(sections));
  expect(WebAssembly.validate(Uint8Array.from(actual.binary))).toBe(true);
});

function dataBinary(mode = 0, offset = 0, declared: number | null = 1, extra: number[] = []): Uint8Array {
  const sections = [5, 3, 1, 0, 1]; // One unshared one-page memory.
  if (declared !== null) sections.push(12, 1 + extra.length, declared, ...extra);
  const data = mode === 1 ? [1, 1, 2, 1, 2] : [1, mode, ...(mode === 2 ? [0] : []), 65, offset, 11, 2, 1, 2];
  sections.push(11, data.length, ...data);
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, ...sections]);
}
it("authenticates active DataCount and the same observable initialized bytes with absent count", () => {
  expect(inspectNativeNumberUndefinedBinary(dataBinary())).toEqual(
    inspectNativeNumberUndefinedBinary(dataBinary(0, 0, null)),
  );
  expect(inspectNativeNumberUndefinedBinary(dataBinary()).initialBytes).toEqual([
    [0, 1],
    [1, 2],
  ]);
});
it.each(["count", "tail", "duplicate", "truncated", "order"])("refuses malformed data-count %s", (kind) => {
  let binary = dataBinary();
  if (kind === "count") binary = dataBinary(0, 0, 2);
  if (kind === "tail") binary = dataBinary(0, 0, 1, [0]);
  if (kind === "duplicate") binary = Uint8Array.from([...binary.slice(0, 16), 12, 1, 1, ...binary.slice(16)]);
  if (kind === "truncated") binary = binary.slice(0, -1);
  if (kind === "order")
    binary = Uint8Array.from([...binary.slice(0, 13), ...binary.slice(16), ...binary.slice(13, 16)]);
  expect(() => inspectNativeNumberUndefinedBinary(binary)).toThrow();
});
it.each([1, 2])("refuses engine-valid unsupported data segment mode %s", (mode) => {
  const binary = dataBinary(mode);
  expect(WebAssembly.validate(Uint8Array.from(binary))).toBe(true);
  expect(() => inspectNativeNumberUndefinedBinary(binary)).toThrow("non-active/default data");
});
it("refuses output descriptor/frozen diagnostic drift before any optimizer invocation", async () => {
  await yieldTurn();
  const result = compileSourceSync(source, options);
  Object.freeze(result.errors);
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
  await expect(applyIssuedNativeNumberUndefinedOptimization(result, options)).rejects.toThrow(
    "diagnostic array changed",
  );
  expect(spy).not.toHaveBeenCalled();
});

it.each([0, NaN, "", null])("preserves ordinary nonissued scalar falsey-option %s semantics", async (value) => {
  await yieldTurn();
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
  const result = compileSourceSync("export function run(x:number):number{return x*2;}", {
    ...options,
    optimize: value,
  } as CompileOptions);
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(nativeNumberUndefinedOptimizationObservation(result)).toBeUndefined();
  expect(spy).not.toHaveBeenCalled();
});
it("handles declared zero data and proves overlapping zero writes in observable initial memory", () => {
  const header = [0, 97, 115, 109, 1, 0, 0, 0],
    memory = [5, 3, 1, 0, 1];
  const empty = Uint8Array.from([...header, ...memory, 12, 1, 0, 11, 1, 0]);
  expect(inspectNativeNumberUndefinedBinary(empty).initialBytes).toEqual([]);
  const overlapping = [2, 0, 65, 0, 11, 2, 1, 2, 0, 65, 1, 11, 2, 0, 3];
  const normalized = [1, 0, 65, 0, 11, 3, 1, 0, 3];
  const a = Uint8Array.from([...header, ...memory, 12, 1, 2, 11, overlapping.length, ...overlapping]);
  const b = Uint8Array.from([...header, ...memory, 12, 1, 1, 11, normalized.length, ...normalized]);
  expect(inspectNativeNumberUndefinedBinary(a)).toEqual(inspectNativeNumberUndefinedBinary(b));
});
it("rejects engine-valid negative active offsets at actual memory population bounds", () => {
  const binary = dataBinary(0, 127);
  expect(WebAssembly.validate(Uint8Array.from(binary))).toBe(true);
  expect(() => inspectNativeNumberUndefinedBinary(binary)).toThrow("data bounds");
});

it.each(["dts", "errors", "binary"])("refuses issued artifact %s getter before optimizer effects", async (key) => {
  await yieldTurn();
  const result = compileSourceSync(source, options);
  let reads = 0;
  Object.defineProperty(result, key, {
    enumerable: true,
    configurable: true,
    get() {
      reads++;
      throw Error("getter executed");
    },
  });
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
  await expect(applyIssuedNativeNumberUndefinedOptimization(result, options)).rejects.toThrow();
  expect(reads).toBe(0);
  expect(spy).not.toHaveBeenCalled();
});
it("refuses caller option getter with zero reads before actual optimizer effects", async () => {
  await yieldTurn();
  const opts: CompileOptions = { ...options },
    result = compileSourceSync(source, opts);
  let reads = 0;
  Object.defineProperty(opts, "optimize", {
    get() {
      reads++;
      throw Error("getter executed");
    },
  });
  const spy = vi.spyOn(optimizer, "optimizeBinaryAsync");
  await expect(applyIssuedNativeNumberUndefinedOptimization(result, opts)).rejects.toThrow();
  expect(reads).toBe(0);
  expect(spy).not.toHaveBeenCalled();
});
it.each(["warning", "binary"])(
  "refuses actual optimizer result %s getter without reading or committing candidate",
  async (key) => {
    await yieldTurn();
    const result = compileSourceSync(source, options),
      original = result.binary;
    let reads = 0;
    vi.spyOn(optimizer, "optimizeBinaryAsync").mockImplementation(async (binary) => {
      const output = { binary, optimized: true };
      Object.defineProperty(output, key, {
        get() {
          reads++;
          throw Error("getter executed");
        },
        enumerable: true,
      });
      return output;
    });
    await applyIssuedNativeNumberUndefinedOptimization(result, options);
    expect(reads).toBe(0);
    expect(result.binary).toBe(original);
    expect(nativeNumberUndefinedOptimizationObservation(result)).toMatchObject({
      accepted: false,
      disposition: "rejected",
    });
  },
);
it.each(["original", "detached"])(
  "refuses genuine %s physical module mutation during actual await",
  async (location) => {
    await yieldTurn();
    const actual = compilerLifecycle.finalizePreparedPipelinePresentation;
    let tuple:
      | [
          Parameters<typeof actual>[0],
          Parameters<typeof issueNativeNumberUndefinedOptimizationInput>[1],
          Parameters<typeof issueNativeNumberUndefinedOptimizationInput>[2],
          Uint8Array,
        ]
      | undefined;
    vi.spyOn(compilerLifecycle, "finalizePreparedPipelinePresentation").mockImplementation((presentation) => {
      const done = actual(presentation);
      if (done.kind === "completed-finalization")
        tuple = [presentation, done.module, done.artifacts, done.artifacts.binary];
      return done;
    });
    const opts = { ...options, backend: "wasmgc" as const },
      result = compileSourceSync(source, opts);
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(tuple).toBeDefined();
    const program = tuple![0],
      finalModule = tuple![1];
    expect(finalModule).not.toBe(program.emission.module);
    vi.spyOn(optimizer, "optimizeBinaryAsync").mockImplementation(async (binary) => {
      (location === "original" ? program.emission.module : finalModule).globals[0]!.mutable = true;
      return { binary, optimized: false, warning: "instrumented unavailable" };
    });
    await expect(applyIssuedNativeNumberUndefinedOptimization(result, opts)).rejects.toThrow();
  },
);
it("refuses contradictory optimized/timedOut envelope without committing valid candidate", async () => {
  await yieldTurn();
  const result = compileSourceSync(source, options),
    original = result.binary;
  vi.spyOn(optimizer, "optimizeBinaryAsync").mockResolvedValue({
    binary: Uint8Array.from(original),
    optimized: true,
    timedOut: true,
  });
  await applyIssuedNativeNumberUndefinedOptimization(result, options);
  expect(result.binary).toBe(original);
  expect(nativeNumberUndefinedOptimizationObservation(result)).toMatchObject({
    accepted: false,
    disposition: "rejected",
  });
});
