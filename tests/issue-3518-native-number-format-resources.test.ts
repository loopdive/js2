// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import type { IrNumberFormatRadixSupport } from "../src/ir/program/runtime-support.js";
import { irCallableBindingKey } from "../src/ir/core/callable-bindings.js";
import { preparedIrDataMismatch } from "../src/ir/program/data.js";
import type { IrTypeRef } from "../src/ir/core/types.js";
import type { IrFuncRef } from "../src/ir/core/value-references.js";
import { numberFormatRadixSupportDeclarations } from "../src/ir/program/formatter-support.js";
import { createIrSourceId } from "../src/ir/identity.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { lowerIrFunctionBody, wasmValueTypeConverter, type IrLowerResolver } from "../src/ir/lower.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { buildInlineNativeStringLiteral } from "../src/runtime/wasmgc/values/string-literal-bodies.js";
import { emitBinary } from "../src/emit/binary.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  declareNativeNumberFormatResources,
  reserveNativeNumberFormatResources,
  requireNativeNumberFormatReservations,
  nativeNumberFormatReservationInventory,
  fillNativeNumberFormatResources,
  requireCompletedNativeNumberFormat,
} from "../src/backend/wasmgc/resources/native-number-format.js";

const input = { key: "formatter", stringKey: "strings", integerBeforeScratch: true } as const;
function fixture() {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, { key: "strings", utf8Storage: false, literals: [] });
  return { module, tx, strings };
}
function future(tx: PhysicalModuleReservations) {
  const type = tx.reserveType("future:type", { kind: "struct", fields: [], name: "future" });
  const fn = tx.reserveFunction("future:function", "future", { params: [], results: [] });
  return { key: type.key, index: type.typeIndex, handle: fn.handle, signature: fn.object.typeIdx };
}

describe("complete formatter resource ownership", () => {
  it("retains canonical interleaving and exact issued inventory tokens", () => {
    const { tx, strings, module } = fixture();
    const pack = reserveNativeNumberFormatResources(tx, input, strings);
    requireNativeNumberFormatReservations(tx, pack, input, strings);
    const rows = nativeNumberFormatReservationInventory(tx, pack);
    const recipe = declareNativeNumberFormatResources(input);
    expect(rows.map(({ key, space }) => ({ key, space }))).toEqual(
      recipe.declarations.map(({ key, space }) => ({ key, space })),
    );
    expect(rows.filter((row) => row.space === "function")).toHaveLength(13);
    expect(rows.filter((row) => row.space === "global")).toHaveLength(2);
    expect(rows.filter((row) => row.space === "type")).toHaveLength(1);
    expect(rows[8]!.reservation).toBe(pack.ryu.mulShift);
    expect(rows[9]!.reservation).toBe(pack.ryu.tableType);
    expect(rows[10]!.reservation).toBe(pack.ryu.inverse);
    expect(rows[11]!.reservation).toBe(pack.ryu.powers);
    expect(rows[12]!.reservation).toBe(pack.ryu.digits);
    expect(rows[13]!.reservation).toBe(pack.ryu.toBuffer);
    expect(module.functions.map((fn) => fn.name)).toEqual(
      recipe.declarations.filter((row) => row.space === "function").map((row) => row.name),
    );
    expect(Object.isFrozen(rows)).toBe(true);
    expect(rows.every(Object.isFrozen)).toBe(true);
    expect(pack.strings).toBe(strings);
    expect(() => requireCompletedNativeNumberFormat(tx, pack)).toThrow();
  });

  it.each(["foreign", "copied", "wrong-key", "wrong-option"] as const)(
    "rejects %s dependencies without changing populations or future ordinals",
    (mutation) => {
      const control = fixture();
      const candidate = fixture();
      const before = structuredClone(candidate.module);
      const actualStrings =
        mutation === "foreign" ? control.strings : mutation === "copied" ? { ...candidate.strings } : candidate.strings;
      const actualInput =
        mutation === "wrong-key"
          ? { ...input, stringKey: "wrong" }
          : mutation === "wrong-option"
            ? { ...input, integerBeforeScratch: undefined as unknown as boolean }
            : input;
      // Genuine positive admission in a pristine twin precedes every negative.
      const positive = fixture();
      const pack = reserveNativeNumberFormatResources(positive.tx, input, positive.strings);
      requireNativeNumberFormatReservations(positive.tx, pack, input, positive.strings);
      expect(() => reserveNativeNumberFormatResources(candidate.tx, actualInput, actualStrings)).toThrow();
      expect(candidate.module).toStrictEqual(before);
      expect(future(candidate.tx)).toStrictEqual(future(control.tx));
    },
  );

  it("rejects pack copies and changed options at lookup without allocating", () => {
    const { tx, strings, module } = fixture();
    const pack = reserveNativeNumberFormatResources(tx, input, strings);
    requireNativeNumberFormatReservations(tx, pack, input, strings);
    const before = structuredClone(module);
    expect(() => nativeNumberFormatReservationInventory(tx, { ...pack })).toThrow(/owner/);
    expect(() =>
      requireNativeNumberFormatReservations(tx, pack, { ...input, integerBeforeScratch: false }, strings),
    ).toThrow(/input/);
    expect(module).toStrictEqual(before);
  });

  it.each(["completion", "duplicate", "seal"] as const)("isolates missing radix-body %s rejection", (operation) => {
    const { tx, strings } = fixture();
    const pack = reserveNativeNumberFormatResources(tx, input, strings);
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, strings);
    fillNativeNumberFormatResources(tx, pack);
    expect(pack.functions["radix-body"].object.body).toEqual([]);
    expect(tx.state).toBe("filling");
    if (operation === "completion") expect(() => requireCompletedNativeNumberFormat(tx, pack)).toThrow(/completion/);
    if (operation === "duplicate") expect(() => fillNativeNumberFormatResources(tx, pack)).toThrow(/duplicate/);
    if (operation === "seal") expect(() => tx.seal()).toThrow(/missing function fill formatter:radix-body/);
  });

  for (const operation of ["inventory", "freeze"] as const)
    it.each(["signature", "table", "name"] as const)(
      `reauthenticates actual %s descriptors at independent ${operation}`,
      (mutation) => {
        const { tx, strings } = fixture();
        const pack = reserveNativeNumberFormatResources(tx, input, strings);
        expect(nativeNumberFormatReservationInventory(tx, pack)).toHaveLength(16);
        if (mutation === "name") pack.functions.new.object.name = "changed";
        if (mutation === "signature") pack.functions.get.object.typeIdx = pack.functions.set.object.typeIdx;
        if (mutation === "table") Reflect.set(pack.ryu.tableType.object, "mutable", true);
        if (operation === "inventory")
          expect(() => nativeNumberFormatReservationInventory(tx, pack)).toThrow(/altered/);
        else expect(() => tx.freezeReservations()).toThrow(/altered/);
      },
    );
});

// This observes the real source-produced support body and resource closure,
// not whole-program consumer execution (the complete async join is separate).
function genuineProgram() {
  const original = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
  const policy = {
    backend: "wasmgc",
    target: "standalone",
    stringConst: { storage: "native" },
    stringConcat: { concat: "native" },
  } as const;
  return requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({ "./entry.ts": original }),
      policy,
      promiseDelayProjection: "standalone-native",
      asyncFamilyProjection: "standalone-native",
    }),
  );
}
function genuineSupport(decoded: boolean) {
  const originalProgram = genuineProgram();
  const source = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(originalProgram)) : originalProgram;
  assertPreparedIrProgram(source);
  const support = source.runtimeSupport;
  if (!support || support.batches.length !== 1) throw new Error("missing genuine formatter support");
  const batch = support.batches[0]!;
  expect(source.ir.functions.includes(batch.implementation.body)).toBe(false);
  return batch;
}

function kernelFor(batch: IrNumberFormatRadixSupport, ref: IrFuncRef) {
  const kernel = batch.kernels.find(
    (entry) => irCallableBindingKey(entry.ref.binding) === irCallableBindingKey(ref.binding),
  );
  const canonical = numberFormatRadixSupportDeclarations(batch.sourceId).kernels.find(
    (entry) => entry.role === kernel?.role,
  );
  if (
    !kernel ||
    !canonical ||
    preparedIrDataMismatch(canonical, kernel) !== undefined ||
    preparedIrDataMismatch(kernel.ref, ref) !== undefined
  )
    throw new Error("foreign support call contract");
  return kernel;
}
function requireScratch(batch: IrNumberFormatRadixSupport, ref: IrTypeRef): void {
  const expected = batch.scratch.type.ref;
  if (
    preparedIrDataMismatch(numberFormatRadixSupportDeclarations(batch.sourceId).scratch, batch.scratch) !== undefined ||
    ref.binding.kind !== expected.binding.kind ||
    ref.binding.bindingId !== expected.binding.bindingId ||
    preparedIrDataMismatch(expected, ref) !== undefined
  )
    throw new Error("foreign support scratch contract");
}
function executable(batch: IrNumberFormatRadixSupport, integerBeforeScratch: boolean) {
  const { module, tx, strings } = fixture();
  const pack = reserveNativeNumberFormatResources(tx, { ...input, integerBeforeScratch }, strings);
  // Separately reserved test-only observers, never counted as compiler helpers.
  const length = tx.reserveFunction("observe:length", "length", {
    params: [{ kind: "externref" }],
    results: [{ kind: "i32" }],
  });
  const char = tx.reserveFunction("observe:char", "char", {
    params: [{ kind: "externref" }, { kind: "i32" }],
    results: [{ kind: "i32" }],
  });
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, strings);
  fillNativeNumberFormatResources(tx, pack);
  const resolver: IrLowerResolver = {
    resolveFunc(ref) {
      const kernel = kernelFor(batch, ref);
      return pack.functions[kernel.role].handle;
    },
    resolveGlobal() {
      throw new Error("unexpected support global");
    },
    resolveType(ref) {
      requireScratch(batch, ref);
      return strings.layout.nativeStrDataTypeIdx;
    },
    internFuncType(type) {
      return tx.internFunctionType(type.params, type.results, type.name);
    },
    nativeStrings: () => true,
    resolveString: () => ({ kind: "ref", typeIdx: strings.layout.anyStrTypeIdx }),
    emitStringConst(value, alloc) {
      if (!batch.literals.some((row) => row.value === value && row.alloc === alloc))
        throw new Error("foreign support literal");
      return buildInlineNativeStringLiteral(strings.layout, value);
    },
  };
  const preparedSupport = prepareIrRuntimeManifest({
    functions: [batch.implementation.body],
    sourceFile: "<stdlib:__sh_num_toString_radix>",
    policy: { backend: "wasmgc", target: "standalone" },
  });
  if (!preparedSupport || preparedSupport.functions.length !== 1)
    throw new Error("missing canonical support intrinsic preparation");
  const body = preparedSupport.functions[0]!;
  const lowered = lowerIrFunctionBody(
    body,
    resolver,
    new WasmGcEmitter(resolver),
    wasmValueTypeConverter("wasmgc", resolver, body.name),
  );
  expect(lowered.params.flatMap((row) => row.slots)).toEqual([{ kind: "f64" }, { kind: "f64" }]);
  expect(lowered.results.flat()).toEqual([{ kind: "ref", typeIdx: strings.layout.anyStrTypeIdx }]);
  tx.fillFunction(pack.functions["radix-body"], {
    body: lowered.body,
    locals: lowered.locals.flatMap((row) => row.slots.map((type) => ({ name: row.name, type }))),
  });
  tx.fillFunction(length, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: strings.layout.nativeStrTypeIdx },
      { op: "struct.get", typeIdx: strings.layout.nativeStrTypeIdx, fieldIdx: 0 },
    ],
  });
  tx.fillFunction(char, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: strings.layout.nativeStrTypeIdx },
      { op: "struct.get", typeIdx: strings.layout.nativeStrTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 1 },
      { op: "array.get_u", typeIdx: strings.layout.nativeStrDataTypeIdx },
    ],
  });
  tx.defineExport("export:decimal", "decimal", pack.functions["to-string"]);
  tx.defineExport("export:radix", "radix", pack.functions["radix-thunk"]);
  tx.defineExport("export:length", "length", length);
  tx.defineExport("export:char", "char", char);
  tx.seal();
  requireCompletedNativeNumberFormat(tx, pack);
  const binary = emitBinary(module);
  expect(WebAssembly.validate(binary)).toBe(true);
  return new WebAssembly.Module(binary);
}

describe("genuine D1 support resource execution", () => {
  for (const decoded of [false, true])
    it.each([false, true])(`executes canonical formatting decoded=${decoded}, integerBeforeScratch=%s`, (fast) => {
      const module = executable(genuineSupport(decoded), fast);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      for (let instanceIndex = 0; instanceIndex < 2; instanceIndex++) {
        const api = new WebAssembly.Instance(module).exports as unknown as {
          decimal(value: number): unknown;
          radix(value: number, radix: number): unknown;
          length(value: unknown): number;
          char(value: unknown, index: number): number;
        };
        const read = (value: unknown) =>
          Array.from({ length: api.length(value) }, (_, index) => String.fromCharCode(api.char(value, index))).join("");
        for (const value of [
          -0,
          NaN,
          Infinity,
          -Infinity,
          70,
          3e9,
          0.1 + 0.2,
          1 / 3,
          1e20,
          1e21,
          1e-6,
          1e-7,
          Number.MIN_VALUE,
          2 ** -1022,
          Number.MAX_VALUE,
          Number.MAX_SAFE_INTEGER,
        ]) {
          expect(read(api.decimal(value))).toBe(String(value));
          expect(read(api.decimal(value))).toBe(String(value));
        }
        for (let radix = 2; radix <= 36; radix++) {
          for (const value of [0, -0, 1, -1, 255, 70, 3e9])
            expect(read(api.radix(value, radix))).toBe(value.toString(radix));
          expect(() => api.radix(Number.MAX_SAFE_INTEGER + 1, radix)).toThrow(WebAssembly.RuntimeError);
        }
        // The unchanged issue3305 exact matrix, separate from inherited fraction debt.
        const radixCases = [
          [255, 16],
          [255, 2],
          [-255, 16],
          [0, 2],
          [1, 36],
          [35, 36],
          [1e15, 36],
          [0.5, 2],
          [3.75, 2],
          [-10.625, 16],
          [123.456, 8],
          [1234567, 10],
          [NaN, 16],
          [Infinity, 2],
          [-Infinity, 36],
          [-0, 8],
          [-0.25, 2],
          [4095.9375, 16],
          [255.5, 16],
          [1048575, 32],
          [777, 8],
        ] as const;
        expect(radixCases).toHaveLength(21);
        for (const [value, radix] of radixCases) expect(read(api.radix(value, radix))).toBe(value.toString(radix));
        const bits = new DataView(new ArrayBuffer(8));
        issue1537Corpus((value) => expect(read(api.decimal(value))).toBe(String(value)));
        let state = 0x15373305n;
        for (let index = 0; index < 20000; index++) {
          state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
          bits.setBigUint64(0, state, true);
          const value = bits.getFloat64(0, true);
          expect(read(api.decimal(value)), `raw bits ${state.toString(16)}`).toBe(String(value));
        }
      }
    });
});

it("executes the same support resource harness after guarded fresh-process codec replay", async () => {
  const program = genuineProgram();
  const directory = mkdtempSync(join(tmpdir(), "js2-number-format-replay-"));
  const packet = join(directory, "program.json");
  const census = join(directory, "loads.jsonl");
  const runner = join(directory, "execute.mjs");
  writeFileSync(packet, encodePreparedIrProgram(program));
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const parsed = ts.createSourceFile("resources.ts", source, ts.ScriptTarget.Latest, true);
  const modules = [
    "../src/ir/types.js",
    "../src/wasm/physical/module-reservations.js",
    "../src/backend/wasmgc/resources/native-string-literals.js",
    "../src/backend/wasmgc/resources/native-number-format.js",
    "../src/ir/lower.js",
    "../src/ir/backend/wasmgc-emitter.js",
    "../src/runtime/wasmgc/values/string-literal-bodies.js",
    "../src/emit/binary.js",
    "../src/ir/core/callable-bindings.js",
    "../src/ir/program/data.js",
  ];
  modules.push("../src/ir/program/formatter-support.js");
  modules.push("../src/ir/intrinsic-support.js");
  const imports = parsed.statements
    .filter(ts.isImportDeclaration)
    .filter((row) => ts.isStringLiteral(row.moduleSpecifier) && modules.includes(row.moduleSpecifier.text));
  expect(imports).toHaveLength(modules.length);
  const dynamicImports = imports
    .map((row) => {
      const clause = row.importClause?.namedBindings;
      if (!clause || !ts.isNamedImports(clause) || !ts.isStringLiteral(row.moduleSpecifier))
        throw new Error("changed backend harness import");
      const names = clause.elements
        .filter((element) => !element.isTypeOnly)
        .map((element) =>
          element.propertyName ? `${element.propertyName.text}: ${element.name.text}` : element.name.text,
        );
      return `const { ${names.join(", ")} } = await import(${JSON.stringify(new URL(row.moduleSpecifier.text, import.meta.url).href)});`;
    })
    .join("\n");
  const functions = ["fixture", "kernelFor", "requireScratch", "executable"]
    .map((name) => {
      const matches = parsed.statements.filter(
        (row): row is ts.FunctionDeclaration => ts.isFunctionDeclaration(row) && row.name?.text === name,
      );
      if (matches.length !== 1) throw new Error("changed shared execution harness");
      return matches[0]!.getText(parsed);
    })
    .join("\n");
  // Reuse the existing loader guard verbatim; the backend functions are taken
  // from this live test, not a second handwritten lowering implementation.
  const existingGuard = readFileSync(new URL("./helpers/runtime-support-source-free.mjs", import.meta.url), "utf8");
  const guardEnd = existingGuard.indexOf("const report =");
  if (guardEnd < 0) throw new Error("changed canonical replay guard");
  const body = `
    import assert from "node:assert/strict";
    const expect = (actual) => ({ toBe: (expected) => assert.strictEqual(actual, expected), toEqual: (expected) => assert.strictEqual(preparedIrDataMismatch(actual, expected), undefined) });
    const input = ${JSON.stringify(input)};
    ${dynamicImports}
    ${functions}
    const { decodePreparedIrProgram } = await import(${JSON.stringify(new URL("../src/ir/program-codec.js", import.meta.url).href)});
    const program = decodePreparedIrProgram(readFileSync(packetFile, "utf8"));
    const batch = program.runtimeSupport?.batches[0];
    assert.ok(batch);
    for (const fast of [false, true]) {
      const module = executable(batch, fast);
      assert.deepStrictEqual(WebAssembly.Module.imports(module), []);
      for (let instance = 0; instance < 2; instance++) {
        const api = new WebAssembly.Instance(module).exports;
        for (const value of [70, 3e9, 1/3, Number.MIN_VALUE, Number.MAX_VALUE]) {
          const result = api.decimal(value);
          const text = Array.from({length: api.length(result)}, (_, index) => String.fromCharCode(api.char(result, index))).join("");
          assert.strictEqual(text, String(value));
        }
      }
    }
    process.stdout.write(JSON.stringify({ok:true, batches:program.runtimeSupport.batches.length}) + "\\n");
  `;
  writeFileSync(
    runner,
    existingGuard.slice(0, guardEnd) +
      ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } })
        .outputText,
  );
  const child = await replayTerminal(runner, packet, census);
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.signal, child.stderr).toBeNull();
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toEqual({ ok: true, batches: 1 });
  const loads = readFileSync(census, "utf8")
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  expect(loads.length).toBeGreaterThan(0);
  expect(loads.filter((row) => row.denied)).toEqual([]);
}, 0);

// Exact issue1537 RNG, draw order, endianness and filtering, including its
// historical subnormal-labelled generation (do not silently "correct" it).
function issue1537Corpus(observe: (value: number) => void): void {
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  const rnd = makeRng(0x1537abcd);
  const dv = new DataView(new ArrayBuffer(8));
  const check = (x: number): void => {
    if (!Number.isFinite(x) || x === 0) return;
    observe(x);
  };
  for (let i = 0; i < 20000; i++) {
    dv.setUint32(0, (rnd() * 2 ** 32) >>> 0);
    dv.setUint32(4, (rnd() * 2 ** 32) >>> 0);
    check(dv.getFloat64(0));
  }
  for (let k = -12; k <= 21; k++) {
    for (let i = 0; i < 200; i++) check((rnd() * 2 - 1) * Math.pow(10, k));
  }
  for (let i = 0; i < 3000; i++) {
    dv.setUint32(0, (rnd() * 2 ** 32) >>> 0);
    dv.setUint32(4, (rnd() * 0x000fffff) >>> 0);
    check(dv.getFloat64(0));
  }
}

it.each([false, true])("authenticates replay-equivalent contracts and rejects foreign owners decoded=%s", (decoded) => {
  const batch = genuineSupport(decoded);
  expect(kernelFor(batch, structuredClone(batch.kernels[0].ref))).toBe(batch.kernels[0]);
  expect(() => requireScratch(batch, structuredClone(batch.scratch.type.ref))).not.toThrow();
  const foreign = numberFormatRadixSupportDeclarations(
    createIrSourceId({ kind: "entry", sourceKey: "./foreign.ts", order: 1 }),
  );
  expect(foreign.kernels[0].ref.name).toBe(batch.kernels[0].ref.name);
  expect(() => kernelFor(batch, foreign.kernels[0].ref)).toThrow(/call contract/);
  expect(() => requireScratch(batch, foreign.scratch.type.ref)).toThrow(/scratch contract/);
  expect(() => kernelFor(batch, { ...batch.kernels[0].ref, name: "same-binding-wrong-name" })).toThrow(/call contract/);
  expect(() => requireScratch(batch, { ...batch.scratch.type.ref, name: "same-binding-wrong-name" })).toThrow(
    /scratch contract/,
  );
});

function replayTerminal(
  runner: string,
  packet: string,
  census: string,
): Promise<{ error?: Error; signal: NodeJS.Signals | null; status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const processHandle = spawn(process.execPath, ["--import", "tsx", runner, packet, census, "replay"], {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      error: Error | undefined;
    const started = Date.now();
    console.info(`formatter replay launched pid=${processHandle.pid} runner=${runner} census=${census}`);
    const progress = setInterval(
      () =>
        console.info(
          `formatter replay pid=${processHandle.pid} elapsedMs=${Date.now() - started} stdoutBytes=${Buffer.byteLength(stdout)} stderrBytes=${Buffer.byteLength(stderr)}`,
        ),
      15000,
    );
    processHandle.stdout.setEncoding("utf8").on("data", (data: string) => {
      stdout += data;
    });
    processHandle.stderr.setEncoding("utf8").on("data", (data: string) => {
      stderr += data;
    });
    processHandle.on("error", (value) => {
      error = value;
    });
    processHandle.on("close", (status, signal) => {
      clearInterval(progress);
      console.info(`formatter replay terminal pid=${processHandle.pid} status=${status} signal=${signal}`);
      resolve({ error, status, signal, stdout, stderr });
    });
  });
}
