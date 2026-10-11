// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptedPhysicalSetupPlan, acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { planPhysicalSetup } from "../src/ir/program-physical-plan.js";
import { irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { planNativeSourceClosureRequirements } from "../src/ir/program/native-source-closure-requirements.js";
import { planNativeInvocationRequirements } from "../src/ir/program/native-invocation-requirements.js";
import { forEachInstrDeep, type IrInstr, type IrInstrCall } from "../src/ir/core/nodes.js";
import { prepareSourceClosureInvocations } from "../src/ir/source-closure-invocation.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";
import { RuntimeManifestBuilder, NUMBER_BOUNDARY_POLICY_DISABLED } from "../src/ir/runtime-manifest.js";

const source = `export function run(): number {
  const captured = 13;
  const fn = function (a: number, b: number): number { return captured + a * 10 + b; };
  const first = fn.call(null, 2, 3);
  const second = fn.apply(undefined, [4, 5]);
  return first + second;
}`;
const callbackSource = `export function run(): number {
  const cb = function(x: number): number { return x + 3; };
  const fn = function(callback: (x: number) => number): number { return callback(7); };
  return fn.call(null, cb);
}`;
const capturedCallbacksSource = `export function run(): number {
  const firstBias = 3;
  const secondBias = 19;
  const left = function(x: number): number { return x + firstBias; };
  const right = function(x: number): number { return x + secondBias; };
  const fn = function(callback: (x: number) => number): number { return callback(7); };
  return fn.call(null, left) * 100 + fn.apply(null, [right]);
}`;
function oracle(text: string): number {
  const exports: { run?: () => number } = {};
  runInNewContext(
    ts.transpileModule(text, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    { exports },
    { timeout: 1000 },
  );
  if (!exports.run) throw new Error("exact-source native oracle lacks run");
  return exports.run();
}
function input(text = source) {
  return {
    ...sourceInput({ "./entry.ts": text }),
    policy: {
      target: "standalone" as const,
      backend: "wasmgc" as const,
      numberBoundary: { box: "native" as const, unbox: "native" as const },
    },
  };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

describe("source-produced method and apply execution through the native consumer", () => {
  it("executes the actual callback through a decoded call", async () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const prepared = requireProgram(prepareWholeIrProgram(input(callbackSource)));
    const program = decodePreparedIrProgram(encodePreparedIrProgram(prepared));
    const requirements = planNativeSourceClosureRequirements(program, program.runtime[0]!);
    expect(requirements!.gaps).toEqual([]);
    expect(requirements!.units).toHaveLength(2);
    expect(requirements!.signatures.some((row) => row.signature.params.some((type) => type.kind === "callable"))).toBe(
      true,
    );
    const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
    if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome.failure));
    expect(outcome.run.emitted.module.imports).toEqual([]);
    expect(outcome.run.emitted.module.functions.some((fn) => fn.name === "__call_fn_method_1")).toBe(true);
    expect((outcome.run.exports.run as () => number)()).toBe(oracle(callbackSource));
  });

  for (const gvn of [false, true])
    for (const decoded of [false, true])
      it(`preserves distinct captured callbacks through call/apply, GVN=${gvn}, decoded=${decoded}`, async () => {
        vi.stubEnv("JS2WASM_IR_GVN", gvn ? "1" : "0");
        const original = requireProgram(prepareWholeIrProgram(input(capturedCallbacksSource)));
        const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
        const sourceRequirements = planNativeSourceClosureRequirements(program, program.runtime[0]!)!;
        expect(sourceRequirements.gaps).toEqual([]);
        expect(sourceRequirements.units).toHaveLength(3);
        const requirements = planNativeInvocationRequirements(sourceRequirements, { utf8Storage: false })!;
        expect(requirements.gaps).toEqual([]);
        const callbacks = requirements.uses.flatMap((use) => use.callbacks ?? []);
        expect(callbacks).toHaveLength(2);
        expect(new Set(callbacks.map((row) => row.liftedUnitId)).size).toBe(2);
        for (const callback of callbacks) {
          const association = sourceRequirements.allocations.find(
            (row) => row.occurrence === callback.allocationOccurrence,
          )!;
          expect(association.liftedUnitId).toBe(callback.liftedUnitId);
          const shape = sourceRequirements.shapes.find((row) => row.id === association.shapeId)!;
          expect(shape.captures).toHaveLength(1);
        }
        const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
        if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome.failure));
        expect(outcome.run.emitted.module.imports).toEqual([]);
        expect((outcome.run.exports.run as () => number)()).toBe(oracle(capturedCallbacksSource));
      });

  for (const gvn of [false, true])
    for (const decoded of [false, true])
      it(`executes actual captures through call and apply, GVN=${gvn}, decoded=${decoded}`, async () => {
        vi.stubEnv("JS2WASM_IR_GVN", gvn ? "1" : "0");
        const original = requireProgram(prepareWholeIrProgram(input()));
        const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
        const sourceRequirements = planNativeSourceClosureRequirements(program, program.runtime[0]!);
        expect(sourceRequirements).toBeDefined();
        const allocationViews = sourceRequirements!.allocations.map((row) => {
          const occurrence = sourceRequirements!.demands.occurrences[row.occurrence]!;
          const buffer = sourceRequirements!.demands.buffers[occurrence.bufferIndex]!;
          expect(buffer.ownerUnitId).toBe(row.ownerUnitId);
          expect(buffer.instructions[occurrence.instructionIndex]).toBe(occurrence.instruction);
          return buffer.view;
        });
        expect(allocationViews).toEqual(["program", "projection"]);
        const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
        if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome.failure));
        const plan = acceptedPhysicalSetupPlan(outcome.run.accepted);
        expect(plan.nativeInvocation).toMatchObject({
          methodArities: [2],
          applyVector: true,
          completionScope: "selected-source-invocation",
        });
        expect(plan.nativeInvocation!.sourceUseCount).toBeGreaterThanOrEqual(2);
        expect(plan.sourceClosures!.shapes.some((shape) => shape.captures.length > 0)).toBe(true);
        expect(outcome.run.emitted.module.imports).toEqual([]);
        expect(outcome.run.emitted.module.functions.some((fn) => fn.name === "__call_fn_method_2")).toBe(true);
        expect(outcome.run.emitted.module.functions.some((fn) => fn.name === "__apply_closure_vector")).toBe(true);
        expect((outcome.run.exports.run as () => number)()).toBe(oracle(source));
      });

  it("keeps an unrelated Boolean closure outside the selected dispatcher population", async () => {
    const mixed = source.replace(
      "const captured = 13;",
      "const unrelated = (value: boolean): boolean => value; const captured = 13;",
    );
    const program = requireProgram(prepareWholeIrProgram(input(mixed)));
    expect(
      program.ir.functions.some(
        (fn) =>
          fn.closureSubtype?.signature.returnType?.kind === "val" &&
          fn.closureSubtype.signature.returnType.val.kind === "i32",
      ),
    ).toBe(true);
    const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
    if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome.failure));
    expect((outcome.run.exports.run as () => number)()).toBe(oracle(mixed));
  });

  it("replays actual call/apply source in a fresh process without the frontend", () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const program = requireProgram(prepareWholeIrProgram(input()));
    const parent = resolve(".tmp/native-invocation-replay");
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, "child-"));
    const encoded = join(directory, "program.json"),
      expected = join(directory, "oracle.json");
    const calls = [{ export: "run", args: [], expected: oracle(source) }];
    writeFileSync(encoded, encodePreparedIrProgram(program));
    writeFileSync(expected, JSON.stringify({ targets: [{ backend: "wasmgc", target: "standalone" }], calls }));
    const args = [
      "--max-old-space-size=4096",
      "--import",
      "tsx",
      "scripts/ir-whole-program-replay.mjs",
      encoded,
      expected,
    ];
    const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(
      join(directory, "replay.json"),
      JSON.stringify({ args, status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }),
    );
    if (child.error) throw child.error;
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr + child.stdout).toBe(0);
    const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
    expect(report.ok).toBe(true);
    expect(report.reencodedIdentical).toBe(true);
    expect(report.loadedModuleCount).toBeGreaterThan(0);
    expect(report.typescriptModules).toEqual([]);
    expect(report.frontendModules).toEqual([]);
    expect(report.failures).toEqual([]);
    const target = report.targets["wasmgc:standalone"];
    expect(target.kind).toBe("ran");
    expect(target.emittedUnits).toBe(target.projectionUnits);
    expect(target.emittedUnits).toBeGreaterThan(1);
    expect(target.rows).toHaveLength(calls.length);
    expect(target.rows.every((row: { match: boolean }) => row.match)).toBe(true);
  });
});

describe("transported callback argument authority", () => {
  for (const method of ["call", "apply"] as const)
    it.each(["non-callable", "other-signature"] as const)(
      `refuses a substituted %s operand for ${method} after the actual producer positive`,
      (mutation) => {
        vi.stubEnv("JS2WASM_IR_GVN", "0");
        const text =
          method === "call" ? callbackSource : callbackSource.replace("fn.call(null, cb)", "fn.apply(null, [cb])");
        const original = requireProgram(prepareWholeIrProgram(input(text)));
        const projection = {
          ...original.runtime[0]!,
          prepared: {
            ...original.runtime[0]!.prepared,
            functions: structuredClone(original.runtime[0]!.prepared.functions),
          },
        };
        const program = {
          ...original,
          ir: { ...original.ir, functions: structuredClone(original.ir.functions) },
          runtime: [projection],
        };
        const options = replayOptions("wasmgc", "standalone");
        expect(acceptPreparedIrProgram(program, options).kind).toBe("accepted");
        let changed = 0;
        for (const module of [program.ir, projection.prepared]) {
          const run = module.functions.find((fn) => fn.name === "run")!;
          const instructions: IrInstr[] = [];
          for (const block of run.blocks)
            for (const root of block.instrs) forEachInstrDeep(root, (row) => instructions.push(row));
          const target = method === "call" ? "js.closure.call:1" : "js.closure.apply-vector";
          const calls = instructions.filter(
            (row): row is IrInstrCall =>
              row.kind === "call" && row.target.binding.kind === "intrinsic" && row.target.binding.symbol === target,
          );
          expect(calls).toHaveLength(1);
          const call = calls[0]!;
          const replacement =
            mutation === "non-callable" ? call.args[method === "call" ? 0 : 1]! : call.args[method === "call" ? 1 : 0]!;
          if (method === "call") Object.assign(call, { args: [call.args[0]!, call.args[1]!, replacement] });
          else {
            const argv = instructions.find((row) => row.result === call.args[2]);
            expect(argv?.kind).toBe("vec.new_fixed");
            Object.assign(argv!, { elements: [replacement] });
          }
          changed++;
        }
        expect(changed).toBe(2);
        expect(() => {
          const requirements = planNativeSourceClosureRequirements(program, projection)!;
          return planNativeInvocationRequirements(requirements, { utf8Storage: false });
        }).toThrow(/callback argument/);
        expect(() => acceptPreparedIrProgram(program, options)).toThrow(/callback argument/);
      },
    );
});

describe("undefined scalar invocation admission", () => {
  const absent = [
    ["call omitted", "f.call(null)"],
    ["apply empty", "f.apply(null, [])"],
    ["call explicit undefined", "f.call(null, undefined)"],
    ["apply explicit undefined", "f.apply(null, [undefined])"],
  ] as const;
  for (const decoded of [false, true])
    it.each(absent)(`refuses non-default %s before emission, decoded=${decoded}`, (_name, invocation) => {
      const text = `export function run(): number { const f = (x: number): number => x; return ${invocation}; }`;
      expect(oracle(text)).toBeUndefined();
      const original = requireProgram(prepareWholeIrProgram(input(text)));
      const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
      const sourceRequirements = planNativeSourceClosureRequirements(program, program.runtime[0]!)!;
      const requirements = planNativeInvocationRequirements(sourceRequirements, { utf8Storage: false })!;
      expect(requirements.gaps).toHaveLength(1);
      expect(requirements.gaps[0]!.unitId).toBe(program.ir.functions.find((fn) => fn.name === "run")!.unitId);
      expect(requirements.gaps[0]!.detail).toMatch(/undefined-preserving value carrier/);
      const accepted = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
      expect(accepted.kind).toBe("unsupported");
      if (accepted.kind === "accepted") throw new Error("unsupported undefined scalar silently admitted");
      expect(accepted.detail).toMatch(/undefined-preserving value carrier/);
    });

  it.each([
    ["default call omitted", "x: number = 7", "f.call(null)"],
    ["default apply empty", "x: number = 7", "f.apply(null, [])"],
    ["default call undefined", "x: number = 7", "f.call(null, undefined)"],
    ["default apply undefined", "x: number = 7", "f.apply(null, [undefined])"],
    ["ordinary NaN", "x: number", "f.call(null, 0 / 0)"],
    ["default ordinary NaN", "x: number = 7", "f.call(null, 0 / 0)"],
  ])("executes %s with its exact JavaScript result", async (_name, parameter, invocation) => {
    const text = `export function run(): number { const f = (${parameter}): number => x; return ${invocation}; }`;
    const prepared = requireProgram(prepareWholeIrProgram(input(text)));
    const program = decodePreparedIrProgram(encodePreparedIrProgram(prepared));
    const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
    if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome.failure));
    expect(outcome.run.emitted.module.imports).toEqual([]);
    expect((outcome.run.exports.run as () => number)()).toBe(oracle(text));
  });
});

describe("closed primordial effect proof", () => {
  it.each([
    [
      "external callback",
      `export function run(cb: (x: number) => number): number {
      const fn = function(callback: (x: number) => number): number { return callback(7); };
      return fn.call(null, cb);
    }`,
    ],
    [
      "escaping callback parameter",
      callbackSource.replace("return callback(7);", "const escaped = callback; return 7;"),
    ],
    ["callback body unknown call", callbackSource.replace("x + 3", "externalCall(x)")],
    [
      "callback coercion from an unknown producer",
      callbackSource.replace("run()", "run(value: any)").replace("callback(7)", "callback(value as number)"),
    ],
    ["callback allocation escape", callbackSource.replace("return fn.call", "const escaped = cb; return fn.call")],
  ])("refuses %s without callback allocation authority", (_name, text) => {
    const ast = input(text);
    expect(() => prepareSourceClosureInvocations(ast.checker, ast.sourceFiles)).toThrow(/native closure invocation/);
  });

  it("accepts the exact execution source and inert !/typeof/strict equality", () => {
    const text = source.replace(
      "const captured = 13;",
      "const inert = !null; const name = typeof null; const equal = null === null; const captured = 13;",
    );
    const ast = input(text);
    expect(prepareSourceClosureInvocations(ast.checker, ast.sourceFiles).size).toBe(2);
  });
  it("rejects a selected closure exposed by a module export", () => {
    const ast = input(`export const fn = function(a: number): number { return a; };
      export function run(): number { return fn.call(null, 1); }`);
    expect(() => prepareSourceClosureInvocations(ast.checker, ast.sourceFiles)).toThrow(/closure export escapes/);
  });
  const effects = [
    ["numeric unary", "+x;"],
    ["cast numeric unary", "+(x as unknown as number);"],
    ["cast binary coercion", "(x as unknown as number) + 1;"],
    ["update coercion", "x++;"],
    ["template coercion", "`${x}`;"],
    ["computed key", "const value = {[x]: 0};"],
    ["object spread", "const value = {...x};"],
    ["array spread", "const value = [...x];"],
    ["for-of iteration", "for (const item of x) {}"],
    ["for-in proxy", "for (const item in x) {}"],
    ["destructuring getter", "const {value} = x;"],
    ["destructuring default", "const [value = x()] = x;"],
    ["unknown call", "x();"],
    ["getter read", "x.value;"],
    ["prototype mutation", "Function.prototype.call = x;"],
    ["closure member mutation", "fn.call = x;"],
    ["closure escape", "x(fn);"],
  ] as const;
  it.each(effects)("refuses %s before replacing any member read", (_name, effect) => {
    const text = `export function run(x: any): number {
      const fn = function(a: number): number { return a; };
      ${effect}
      return fn.call(null, 1);
    }`;
    const ast = input(text);
    expect(() => prepareSourceClosureInvocations(ast.checker, ast.sourceFiles)).toThrow(/native closure invocation/);
  });

  it("retains the exact numeric-unary counterexample as an actual runtime member replacement", () => {
    const text = `export function run(x: any): number {
      +x;
      const fn = function(a: number): number { return a; };
      return fn.call(null, 1);
    }`;
    const javascript = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const exports: { result?: number } = {};
    runInNewContext(
      javascript +
        `exports.result = exports.run({valueOf() {
      Function.prototype.call = function() { return 99; }; return 0;
    }});`,
      { exports },
      { timeout: 1000 },
    );
    expect(exports.result).toBe(99);
    const ast = input(text);
    expect(() => prepareSourceClosureInvocations(ast.checker, ast.sourceFiles)).toThrow(/numeric unary/);
  });
});

describe("explicit native boxing dependency", () => {
  it("requires the actual native value setup even with the explicit native policy", () => {
    const program = requireProgram(prepareWholeIrProgram(input("export function fail(): number { throw 17; }")));
    const options = replayOptions("wasmgc", "standalone");
    const accepted = acceptPreparedIrProgram(program, options);
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") throw new Error(accepted.detail);
    const plan = acceptedPhysicalSetupPlan(accepted);
    expect(plan.nativeStrings?.resources.mode).toBe("number-boundary");
    expect(plan.hostNumberBoundary?.imports ?? []).toEqual([]);
    const missing = planPhysicalSetup(program, options, program.runtime[0]!);
    expect(missing.kind).toBe("unsupported");
    if (missing.kind === "planned") throw new Error("native policy granted a box without its value setup");
    expect(missing.detail).toContain("intrinsic js.number.box needs callable provider materialization");
  });
  it("rejects an altered native box attachment after an accepted canonical positive", () => {
    const program = requireProgram(prepareWholeIrProgram(input("export function fail(): number { throw 17; }")));
    const options = replayOptions("wasmgc", "standalone");
    expect(acceptPreparedIrProgram(program, options).kind).toBe("accepted");
    let altered = 0;
    const malformed = {
      ...program,
      runtime: program.runtime.map((projection) => ({
        ...projection,
        prepared: {
          ...projection.prepared,
          functions: projection.prepared.functions.map((fn) => ({
            ...fn,
            blocks: fn.blocks.map((block) => ({
              ...block,
              instrs: block.instrs.map((instruction) => {
                if (instruction.kind !== "intrinsic" || instruction.id !== "js.number.box") return instruction;
                altered++;
                return {
                  ...instruction,
                  provider: { kind: "callable" as const, target: irRuntimeFuncRef("__unbox_number") },
                };
              }),
            })),
          })),
        },
      })),
    };
    expect(altered).toBe(1);
    expect(() => acceptPreparedIrProgram(malformed, options)).toThrow(/provider|binding|canonical|number/);
  });
  it("keeps the disabled number-boundary default", () => {
    const builder = new RuntimeManifestBuilder({ target: "standalone", backend: "wasmgc" });
    expect(builder.freeze().policy.numberBoundary).toEqual(NUMBER_BOUNDARY_POLICY_DISABLED);
    const result = prepareWholeIrProgram({ ...input(), policy: { target: "standalone", backend: "wasmgc" } });
    expect(result.kind).not.toBe("prepared");
    if (result.kind === "prepared") throw new Error("disabled native box was silently selected");
    expect(result.detail).toMatch(/js.number.box|unsupported.*number|number.*unsupported/);
  });
  it("preserves the exact host box capability", () => {
    const builder = new RuntimeManifestBuilder({
      target: "host",
      backend: "wasmgc",
      numberBoundary: { box: "host", unbox: "unsupported" },
    });
    builder.requestFeature("js.number.box");
    const manifest = builder.freeze();
    expect(manifest.providers.find((row) => row.feature === "js.number.box")).toMatchObject({
      id: "host.js.number.box",
      implementation: { kind: "host-callable", capability: "number.box" },
    });
  });
  it.each(["host", "strict-no-host", "wasi"] as const)("does not grant native box on %s", (target) => {
    const builder = new RuntimeManifestBuilder({
      target,
      backend: "wasmgc",
      numberBoundary: { box: "native", unbox: "unsupported" },
    });
    builder.requestFeature("js.number.box");
    expect(() => builder.freeze()).toThrow();
  });
});
