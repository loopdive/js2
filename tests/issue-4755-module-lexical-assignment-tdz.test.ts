// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4755 — the transitional direct frontend must perform PutValue's module-
 * lexical TDZ check after evaluating the assignment value, including the
 * already-live object/array destructuring sinks. Every runtime row deliberately
 * pins `experimentalIR: false` in both WasmGC lanes so an IR-owned body cannot
 * hide a legacy-body failure.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import { compile, compileMulti, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;
type Target = (typeof TARGETS)[number];

const DIRECT_OPTIONS = {
  experimentalIR: false,
  deferTopLevelInit: true,
  emitWat: true,
  skipSemanticDiagnostics: true,
} as const;

interface RuntimeResult {
  readonly result: CompileResult;
  readonly value: number;
}

interface RuntimeEvalResult extends RuntimeResult {
  readonly imports: readonly string[];
}

function compileFailure(result: CompileResult): string {
  return result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n");
}

function actualImportNames(result: CompileResult): readonly string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .map(({ module, name }) => `${module}.${name}`)
    .sort();
}

const STANDALONE_PROBE = `
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const module = new WebAssembly.Module(Buffer.concat(chunks));
  const imports = WebAssembly.Module.imports(module)
    .map(({ module, name }) => module + "." + name)
    .sort();
  const instance = await WebAssembly.instantiate(module, {});
  const name = process.env.JS2WASM_4755_RUN_EXPORT;
  let value;
  if (name) {
    if (typeof instance.exports.__module_init === "function") instance.exports.__module_init();
    value = instance.exports[name]();
  }
  process.stdout.write(JSON.stringify({ imports, value }));
`;

const STANDALONE_RUNTIME_EVAL_PROBE = `
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const providerModule = new WebAssembly.Module(Buffer.from(payload.provider, "base64"));
  const provider = new WebAssembly.Instance(providerModule, {});
  const namespace = {
    __runtime_new_function: provider.exports.__runtime_new_function,
    __runtime_indirect_eval: provider.exports.__runtime_indirect_eval,
    __runtime_direct_eval: provider.exports.__runtime_direct_eval,
    __runtime_apply_interpreted: provider.exports.__runtime_apply_interpreted,
  };
  const userModule = new WebAssembly.Module(Buffer.from(payload.user, "base64"));
  const imports = WebAssembly.Module.imports(userModule)
    .map(({ module, name }) => module + "." + name)
    .sort();
  const user = new WebAssembly.Instance(userModule, { "js2wasm:runtime-eval": namespace });
  if (typeof user.exports.__module_init === "function") user.exports.__module_init();
  const value = user.exports.run();
  process.stdout.write(JSON.stringify({ imports, value }));
`;

function probeStandalone(
  result: CompileResult,
  runExport?: string,
): { readonly imports: string[]; readonly value?: number } {
  const child = spawnSync(
    process.execPath,
    ["--experimental-wasm-exnref", "--input-type=module", "--eval", STANDALONE_PROBE],
    {
      input: result.binary,
      encoding: "utf8",
      env: { ...process.env, JS2WASM_4755_RUN_EXPORT: runExport ?? "" },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  expect(child.status, child.stderr || child.error?.message).toBe(0);
  return JSON.parse(child.stdout) as { readonly imports: string[]; readonly value?: number };
}

function expectStandaloneHostFree(result: CompileResult): void {
  expect(probeStandalone(result).imports, "standalone Wasm import section").toEqual([]);
  expect(result.imports, "standalone compiler import descriptors").toEqual([]);
  expect(result.hostImportSummary?.total ?? 0, "standalone host-import inventory").toBe(0);
}

async function compileDirect(source: string, fileName: string, target: Target): Promise<CompileResult> {
  const result = await compile(source, {
    ...DIRECT_OPTIONS,
    fileName,
    target,
    hostBridge: target === "gc" ? "always" : "off",
  });
  expect(result.success, compileFailure(result)).toBe(true);
  if (target === "standalone") expectStandaloneHostFree(result);
  else expect(WebAssembly.validate(result.binary)).toBe(true);
  return result;
}

async function compileMultiDirect(
  sources: Record<string, string>,
  entryFile: string,
  target: Target,
): Promise<CompileResult> {
  const result = await compileMulti(sources, entryFile, {
    ...DIRECT_OPTIONS,
    target,
    hostBridge: target === "gc" ? "always" : "off",
  });
  expect(result.success, compileFailure(result)).toBe(true);
  if (target === "standalone") expectStandaloneHostFree(result);
  else expect(WebAssembly.validate(result.binary)).toBe(true);
  return result;
}

async function compileMultiAndRunDirect(
  sources: Record<string, string>,
  entryFile: string,
  target: Target,
  hostGlobals?: Record<string, unknown>,
): Promise<RuntimeResult> {
  const result = await compileMultiDirect(sources, entryFile, target);
  if (target === "standalone") {
    const { value } = probeStandalone(result, "run");
    expect(value).toBeTypeOf("number");
    return { result, value: value! };
  }
  const exports = await instantiateAndInitialize(result, hostGlobals);
  expect(exports.run, "numeric proof export").toBeTypeOf("function");
  const value = exports.run!();
  expect(value).toBeTypeOf("number");
  return { result, value };
}

async function instantiateAndInitialize(
  result: CompileResult,
  hostGlobals?: Record<string, unknown>,
): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, hostGlobals, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setInstance?.(instance);
  imports.setExports?.(exports);
  expect(exports.__module_init, "deferred module initializer").toBeTypeOf("function");
  exports.__module_init!();
  return exports;
}

async function compileAndRunDirect(source: string, fileName: string, target: Target): Promise<RuntimeResult> {
  const result = await compileDirect(source, fileName, target);
  if (target === "standalone") {
    const { value } = probeStandalone(result, "run");
    expect(value).toBeTypeOf("number");
    return { result, value: value! };
  }
  const exports = await instantiateAndInitialize(result);
  expect(exports.run, "numeric proof export").toBeTypeOf("function");
  const value = exports.run!();
  expect(value).toBeTypeOf("number");
  return { result, value };
}

let runtimeEvalProviderBinary: Uint8Array;

beforeAll(async () => {
  const provider = await compile(
    `
      interface Cell { value: any }
      function result(ok: boolean, value: any): any {
        const out: any[] = [ok, __runtime_eval_wrap_result(value)];
        return out;
      }
      function installTarget(state: any): void {
        const nameCell = state[0] as Cell;
        const valueCell = state[1] as Cell;
        const markerNameCell = state[2] as Cell;
        const markerValueCell = state[3] as Cell;
        nameCell.value = "target";
        valueCell.value = 5;
        markerNameCell.value = "\\0js2wasm:deletable-eval-binding";
        markerValueCell.value = undefined;
      }
      function refuse(): any { return result(false, new TypeError("unused #4755 provider entry")); }
      export function __runtime_direct_eval(
        source: any, globalObject: any, thisArg: any, activationState: any,
        activationSeedNames: any, activationSeedSlots: any, lexicalNames: any,
        lexicalSlots: any, outerNames: any, outerSlots: any,
        callerStrict: boolean, mappedParamNames: any
      ): any {
        if (source === "install-target") installTarget(activationState);
        return result(true, 0);
      }
      export function __runtime_indirect_eval(source: any, globalObject: any): any { return refuse(); }
      export function __runtime_new_function(params: any, body: any, globalObject: any): any { return refuse(); }
      export function __runtime_apply_interpreted(
        callable: any, receiver: any, argc: number,
        a0: any, a1: any, a2: any, a3: any, a4: any, a5: any, a6: any, a7: any
      ): any { return refuse(); }
    `,
    {
      experimentalIR: false,
      fileName: "issue-4755-runtime-eval-provider.ts",
      inferModuleStrictArguments: false,
      skipSemanticDiagnostics: true,
      target: "standalone",
    },
  );
  expect(provider.success, compileFailure(provider)).toBe(true);
  expect(provider.imports, "the bounded #4755 runtime-eval provider is host-free").toEqual([]);
  expect(provider.hostImportSummary?.total ?? 0).toBe(0);
  runtimeEvalProviderBinary = provider.binary;
});

async function compileAndRunRuntimeEvalDirect(source: string, fileName: string): Promise<RuntimeEvalResult> {
  const result = await compile(source, {
    ...DIRECT_OPTIONS,
    fileName,
    hostBridge: "off",
    inferModuleStrictArguments: false,
    target: "standalone",
  });
  expect(result.success, compileFailure(result)).toBe(true);
  const child = spawnSync(
    process.execPath,
    ["--experimental-wasm-exnref", "--input-type=module", "--eval", STANDALONE_RUNTIME_EVAL_PROBE],
    {
      input: JSON.stringify({
        provider: Buffer.from(runtimeEvalProviderBinary).toString("base64"),
        user: Buffer.from(result.binary).toString("base64"),
      }),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  expect(child.status, child.stderr || child.error?.message).toBe(0);
  const probe = JSON.parse(child.stdout) as { readonly imports: readonly string[]; readonly value: number };
  expect(probe.imports).toContain("js2wasm:runtime-eval.__runtime_direct_eval");
  expect(probe.imports.every((name) => name.startsWith("js2wasm:runtime-eval."))).toBe(true);
  return { result, imports: probe.imports, value: probe.value };
}

interface WatFunction {
  readonly name: string;
  readonly body: string;
}

function parseWatFunctions(wat: string): readonly WatFunction[] {
  const starts = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  return starts.map(({ name, index }, position) => ({
    name,
    body: wat.slice(index, starts[position + 1]?.index ?? wat.length),
  }));
}

function watFunction(result: CompileResult, name: string): WatFunction {
  const matches = parseWatFunctions(result.wat).filter((candidate) => candidate.name === name);
  expect(matches, `unique WAT function $${name}`).toHaveLength(1);
  return matches[0]!;
}

function watCallTargets(wat: string, body: string): readonly string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => {
    const target = names[Number(match[1])] ?? "<missing>";
    return target.endsWith("_import") ? target.slice(0, -"_import".length) : target;
  });
}

function referenceErrorCallCount(result: CompileResult, functionName?: string): number {
  const functions = functionName ? [watFunction(result, functionName)] : parseWatFunctions(result.wat);
  return functions
    .flatMap(({ body }) => watCallTargets(result.wat, body))
    .filter((target) => target === "__new_ReferenceError" || target === "__throw_reference_error").length;
}

function referenceErrorImports(result: CompileResult, target: Target): readonly string[] {
  const imports = target === "standalone" ? probeStandalone(result).imports : actualImportNames(result);
  return imports.filter((name) => name.endsWith(".__new_ReferenceError") || name.endsWith(".__throw_reference_error"));
}

const EXACT_CLASS_SETTER_SOURCE = `
  function trigger(): void {
    const C = class {
      set value(next) {
        target = next;
      }
    };
    new C().value = 42;
  }

  var verdict: number = 0;
  try {
    trigger();
  } catch (error) {
    verdict = error instanceof ReferenceError ? 1 : 2;
  }
  let target: any;

  export function run(): number {
    return verdict;
  }
`;

describe.each(TARGETS)("#4755 direct module-lexical assignment TDZ — %s", (target) => {
  it("runs the exact class-setter prerequisite and catches a real ReferenceError", async () => {
    const { value } = await compileAndRunDirect(
      EXACT_CLASS_SETTER_SOURCE,
      `issue-4755-exact-class-setter-${target}.ts`,
      target,
    );
    expect(value).toBe(1);
  });

  it("evaluates the setter RHS once before PutValue and stops at the TDZ throw", async () => {
    const { value } = await compileAndRunDirect(
      `
        var setterCalls: number = 0;
        var rhsCalls: number = 0;
        var afterAssignment: number = 0;
        var verdict: number = 0;

        function rhs(next: any): any {
          rhsCalls += 1;
          return next;
        }
        function trigger(): void {
          const C = class {
            set value(next) {
              setterCalls += 1;
              target = rhs(next);
              afterAssignment = 1;
            }
          };
          new C().value = 42;
        }

        try {
          trigger();
        } catch (error) {
          verdict = error instanceof ReferenceError ? 1 : 2;
        }
        let target: any;
        var storageClean: number = target === undefined ? 1 : 0;

        export function run(): number {
          var score: number = 0;
          if (verdict === 1) score += 1;
          if (setterCalls === 1) score += 2;
          if (rhsCalls === 1) score += 4;
          if (afterAssignment === 0) score += 8;
          if (storageClean === 1) score += 16;
          return score;
        }
      `,
      `issue-4755-rhs-order-${target}.ts`,
      target,
    );
    expect(value).toBe(31);
  });

  it("allows the same ambiguous setter write after the lexical is initialized", async () => {
    const { value } = await compileAndRunDirect(
      `
        var setterCalls: number = 0;
        var afterAssignment: number = 0;
        function trigger(): void {
          const C = class {
            set value(next) {
              setterCalls += 1;
              target = next;
              afterAssignment = 1;
            }
          };
          new C().value = 42;
        }

        let target: any;
        trigger();
        var stored: number = target === 42 ? 1 : 0;

        export function run(): number {
          var score: number = 0;
          if (setterCalls === 1) score += 1;
          if (stored === 1) score += 2;
          if (afterAssignment === 1) score += 4;
          return score;
        }
      `,
      `issue-4755-initialized-class-setter-${target}.ts`,
      target,
    );
    expect(value).toBe(7);
  });
});

function dynamicWithAssignmentSource(hasBinding: boolean): string {
  return `
    var rhsCalls: number = 0;
    var afterAssignment: number = 0;
    var verdict: number = 0;
    var scope: any = ${hasBinding ? "{ target: 5, marker: 7 }" : "{ marker: 7 }"};

    function rhs(): any {
      rhsCalls += 1;
      return 41;
    }
    function trigger(dynamicScope: any): void {
      with (dynamicScope) {
        target = rhs();
        afterAssignment = 1;
      }
    }

    try {
      trigger(scope);
    } catch (error) {
      verdict = error instanceof ReferenceError ? 1 : 2;
    }
    let target: any;
    var storageClean: number = target === undefined ? 1 : 0;

    export function run(): number {
      var score: number = 0;
      if (rhsCalls === 1) score += 1;
      if (verdict === ${hasBinding ? 0 : 1}) score += 2;
      if (${hasBinding ? "scope.target === 41" : '!("target" in scope)'}) score += 4;
      if (afterAssignment === ${hasBinding ? 1 : 0}) score += 8;
      if (storageClean === 1) score += 16;
      if (scope.marker === 7) score += 32;
      return score;
    }
  `;
}

describe.each(TARGETS)("#4755 dynamic-with precomputed writer routing — %s", (target) => {
  it("keeps a HasBinding hit on the object without consulting the uninitialized module lexical", async () => {
    const { value } = await compileAndRunDirect(
      dynamicWithAssignmentSource(true),
      `issue-4755-dynamic-with-hit-${target}.ts`,
      target,
    );
    expect(value).toBe(63);
  });

  it("evaluates the HasBinding miss RHS once before the guarded module-lexical throw", async () => {
    const { value } = await compileAndRunDirect(
      dynamicWithAssignmentSource(false),
      `issue-4755-dynamic-with-miss-${target}.ts`,
      target,
    );
    expect(value).toBe(63);
  });
});

function runtimeEvalAssignmentSource(hasBinding: boolean): string {
  return `
    var rhsCalls: number = 0;
    var afterAssignment: number = 0;
    var verdict: number = 0;
    var observed: any = 0;

    function join(parts: string[]): string {
      var out = "";
      for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
      return out;
    }
    function rhs(): any {
      rhsCalls += 1;
      return 41;
    }
    function trigger(): any {
      eval(join(["${hasBinding ? "install" : "leave"}-", "${hasBinding ? "target" : "empty"}"]));
      target = rhs();
      afterAssignment = 1;
      return target;
    }

    try {
      observed = trigger();
    } catch (error) {
      verdict = error instanceof ReferenceError ? 1 : 2;
    }
    let target: any;
    var storageClean: number = target === undefined ? 1 : 0;

    export function run(): number {
      var score: number = 0;
      if (rhsCalls === 1) score += 1;
      if (verdict === ${hasBinding ? 0 : 1}) score += 2;
      if (observed === ${hasBinding ? 41 : 0}) score += 4;
      if (afterAssignment === ${hasBinding ? 1 : 0}) score += 8;
      if (storageClean === 1) score += 16;
      return score;
    }
  `;
}

function runtimeEvalAmbientAssignmentSource(hasBinding: boolean): string {
  return `
    declare var target: any;
    var rhsCalls: number = 0;
    var afterAssignment: number = 0;
    var verdict: number = 0;
    var observed: any = 0;

    function join(parts: string[]): string {
      var out = "";
      for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
      return out;
    }
    function rhs(): any { rhsCalls += 1; return 41; }
    function trigger(): any {
      eval(join(["${hasBinding ? "install" : "leave"}", "-${hasBinding ? "target" : "empty"}"]));
      target = rhs();
      afterAssignment = 1;
      return target;
    }

    try { observed = trigger(); }
    catch (error) { verdict = error instanceof ReferenceError ? 1 : 2; }

    export function run(): number {
      var score: number = 0;
      if (rhsCalls === 1) score += 1;
      if (verdict === 0) score += 2;
      if (observed === 41) score += 4;
      if (afterAssignment === 1) score += 8;
      return score;
    }
  `;
}

describe("#4755 runtime-eval value-cell precomputed writer routing — standalone", () => {
  // `runtimeEvalStateMayShadowBinding` is deliberately a standalone/WASI
  // provider seam; GC direct eval keeps its static-splice/host route. These
  // rows therefore exercise the only lane in which a caller-owned value cell
  // can precede the module-lexical miss arm.
  it("keeps a present value-cell write off the uninitialized module lexical", async () => {
    const { value } = await compileAndRunRuntimeEvalDirect(
      runtimeEvalAssignmentSource(true),
      "issue-4755-runtime-eval-cell-hit-standalone.ts",
    );
    expect(value).toBe(31);
  });

  it("evaluates a value-cell miss RHS once before the guarded module-lexical throw", async () => {
    const { value } = await compileAndRunRuntimeEvalDirect(
      runtimeEvalAssignmentSource(false),
      "issue-4755-runtime-eval-cell-miss-standalone.ts",
    );
    expect(value).toBe(31);
  });

  it.each([true, false])("keeps an ambient binding behind the runtime-eval value-cell %s route", async (hasBinding) => {
    const { value } = await compileAndRunRuntimeEvalDirect(
      runtimeEvalAmbientAssignmentSource(hasBinding),
      `issue-4755-runtime-eval-ambient-${hasBinding ? "hit" : "miss"}-standalone.ts`,
    );
    expect(value).toBe(15);
  });
});

interface DestructuringCase {
  readonly label: string;
  readonly expectedDefaultCalls: 0 | 1;
  readonly fixture: string;
  readonly assignment: string;
}

function destructuringSource(row: DestructuringCase): string {
  return `
    var rhsCalls: number = 0;
    var firstWork: number = 0;
    var laterReads: number = 0;
    var defaultCalls: number = 0;
    var later: any = 7;
    var afterAssignment: number = 0;
    var verdict: number = 0;

    function defaultValue(): any {
      defaultCalls += 1;
      return 41;
    }
    ${row.fixture}

    function trigger(): void {
      ${row.assignment}
      afterAssignment = 1;
    }

    try {
      trigger();
    } catch (error) {
      verdict = error instanceof ReferenceError ? 1 : 2;
    }
    let target: any;
    var storageClean: number = target === undefined ? 1 : 0;

    export function run(): number {
      var score: number = 0;
      if (verdict === 1) score += 1;
      if (rhsCalls === 1) score += 2;
      if (firstWork === 1) score += 4;
      if (defaultCalls === ${row.expectedDefaultCalls}) score += 8;
      if (laterReads === 0) score += 16;
      if (later === 7) score += 32;
      if (afterAssignment === 0) score += 64;
      if (storageClean === 1) score += 128;
      return score;
    }
  `;
}

const DESTRUCTURING_CASES: readonly DestructuringCase[] = [
  {
    label: "typed object / plain identifier target",
    expectedDefaultCalls: 0,
    fixture: `
      function firstValue(): number {
        firstWork += 1;
        return 41;
      }
      function makeValue(): { first: number; second: number } {
        rhsCalls += 1;
        return { first: firstValue(), second: 99 };
      }
    `,
    assignment: `({ first: target, second: later } = makeValue());`,
  },
  {
    label: "typed object / defaulted identifier target",
    expectedDefaultCalls: 1,
    fixture: `
      function makeValue(): { first: any; second: number } {
        rhsCalls += 1;
        firstWork += 1;
        return { first: undefined, second: 99 };
      }
    `,
    assignment: `({ first: target = defaultValue(), second: later } = makeValue());`,
  },
  {
    label: "any externref object / plain identifier target",
    expectedDefaultCalls: 0,
    fixture: `
      function makeValue(): any {
        rhsCalls += 1;
        return {
          get first(): any { firstWork += 1; return 41; },
          get second(): any { laterReads += 1; return 99; }
        } as any;
      }
    `,
    assignment: `({ first: target, second: later } = makeValue());`,
  },
  {
    label: "any externref object / defaulted identifier target",
    expectedDefaultCalls: 1,
    fixture: `
      function makeValue(): any {
        rhsCalls += 1;
        return {
          get first(): any { firstWork += 1; return undefined; },
          get second(): any { laterReads += 1; return 99; }
        } as any;
      }
    `,
    assignment: `({ first: target = defaultValue(), second: later } = makeValue());`,
  },
  {
    label: "typed tuple array / plain identifier target",
    expectedDefaultCalls: 0,
    fixture: `
      function firstValue(): number {
        firstWork += 1;
        return 41;
      }
      function makeValue(): [number, number] {
        rhsCalls += 1;
        return [firstValue(), 99];
      }
    `,
    assignment: `[target, later] = makeValue();`,
  },
  {
    label: "typed tuple array / defaulted identifier target",
    expectedDefaultCalls: 1,
    fixture: `
      function makeValue(): [any, number] {
        rhsCalls += 1;
        firstWork += 1;
        return [undefined, 99];
      }
    `,
    assignment: `[target = defaultValue(), later] = makeValue();`,
  },
  {
    label: "any externref array / plain identifier target",
    expectedDefaultCalls: 0,
    fixture: `
      function firstValue(): number {
        firstWork += 1;
        return 41;
      }
      function makeValue(): any {
        rhsCalls += 1;
        return [firstValue(), 99] as any;
      }
    `,
    assignment: `[target, later] = makeValue();`,
  },
  {
    label: "any externref array / defaulted identifier target",
    expectedDefaultCalls: 1,
    fixture: `
      function makeValue(): any {
        rhsCalls += 1;
        firstWork += 1;
        return [undefined, 99] as any;
      }
    `,
    assignment: `[target = defaultValue(), later] = makeValue();`,
  },
] as const;

describe.each(TARGETS)("#4755 direct destructuring TDZ sink matrix — %s", (target) => {
  it.each(DESTRUCTURING_CASES)("$label", async (row) => {
    const slug = row.label.replaceAll(/[^a-z]+/g, "-");
    const { value } = await compileAndRunDirect(destructuringSource(row), `issue-4755-${slug}-${target}.ts`, target);
    expect(value).toBe(255);
  });

  it("drives an isolated Array.prototype[@@iterator] override before the first target guard", async () => {
    const source = `
        var rhsCalls: number = 0;
        var iteratorCalls: number = 0;
        var later: any = 7;
        var afterAssignment: number = 0;
        var verdict: number = 0;

        Array.prototype[Symbol.iterator] = function* () {
          iteratorCalls += 1;
          yield 41;
          yield 99;
        };

        function makeValue(): number[] {
          rhsCalls += 1;
          return [1, 2];
        }
        function trigger(): void {
          [target, later] = makeValue();
          afterAssignment = 1;
        }

        try {
          trigger();
        } catch (error) {
          verdict = error instanceof ReferenceError ? 1 : 2;
        }
        let target: any;
        var storageClean: number = target === undefined ? 1 : 0;

        export function run(): number {
          var score: number = 0;
          if (verdict === 1) score += 1;
          if (rhsCalls === 1) score += 2;
          if (iteratorCalls === 1) score += 4;
          if (later === 7) score += 16;
          if (afterAssignment === 0) score += 32;
          if (storageClean === 1) score += 64;
          return score;
        }
      `;
    const fileName = `issue-4755-array-iterator-override-${target}.ts`;
    if (target === "standalone") {
      // #1719 residual (carrier-contract evidence: #2038/#3164): standalone
      // CPR still traps in __iterator_next. Keep #4755's route/provider proof
      // non-vacuous without absorbing that iterator-runtime migration.
      const result = await compileDirect(source, fileName, target);
      const moduleInit = watFunction(result, "__module_init").body;
      expect(watCallTargets(result.wat, moduleInit)).toContain("__drive_proto_iterator");
      expect(result.wat).toContain("$__iterator_next");
      expect(referenceErrorCallCount(result)).toBeGreaterThan(0);
      return;
    }
    const { value } = await compileAndRunDirect(source, fileName, target);
    expect(value).toBe(119);
  });
});

describe.each(TARGETS)("#4755 direct assignment identity controls — %s", (target) => {
  it("keeps same-named parameter and local writes off the module lexical", async () => {
    const { value } = await compileAndRunDirect(
      `
        function writeParameter(target: any): any {
          target = 17;
          return target;
        }
        function writeLocal(): any {
          let target: any = 3;
          target = 23;
          return target;
        }

        var parameterResult: any = writeParameter(0);
        var localResult: any = writeLocal();
        let target: any;
        var moduleUntouched: number = target === undefined ? 1 : 0;

        export function run(): number {
          var score: number = 0;
          if (parameterResult === 17) score += 1;
          if (localResult === 23) score += 2;
          if (moduleUntouched === 1) score += 4;
          return score;
        }
      `,
      `issue-4755-shadow-controls-${target}.ts`,
      target,
    );
    expect(value).toBe(7);
  });

  it("does not attach a foreign lexical's guard to a same-spelled import binding", async () => {
    const result = await compileMultiDirect(
      {
        "./lexical.ts": `export let target: number;`,
        "./provider.ts": `export var providerValue: number = 3;`,
        "./entry.ts": `
          import "./lexical";
          import { providerValue as target } from "./provider";
          export function writeImported4755(): number {
            target = 9;
            return 1;
          }
        `,
      },
      "./entry.ts",
      target,
    );
    expect(referenceErrorCallCount(result, "writeImported4755")).toBe(0);
  });

  it("does not attach a lexical guard to a same-spelled var in another source", async () => {
    const result = await compileMultiDirect(
      {
        "./lexical.ts": `export let target: number;`,
        "./foreign.ts": `
          var target: number = 3;
          export function writeForeign4755(): number {
            target = 9;
            return 1;
          }
        `,
        "./entry.ts": `
          import "./lexical";
          export { writeForeign4755 } from "./foreign";
        `,
      },
      "./entry.ts",
      target,
    );
    expect(referenceErrorCallCount(result, "writeForeign4755")).toBe(0);
  });

  it("keeps a declaration-file ambient collision on its global-environment storage", async () => {
    // `entry.ts` sees only the declaration-file global. The runtime lexical is
    // deliberately a different module's initialized -7 sentinel; sharing its
    // spelling must neither select that storage nor attach its TDZ provider.
    const { result, value } = await compileMultiAndRunDirect(
      {
        "./ambient.d.ts": `
          export interface Ambient4755 { marker: number }
          declare global { let target: any; }
        `,
        "./lexical.ts": `
          export let target: number = -7;
          export function lexicalStorageClean4755(): number {
            return target === -7 ? 1 : 0;
          }
        `,
        "./entry.ts": `
          import type { Ambient4755 } from "./ambient";
          import { lexicalStorageClean4755 } from "./lexical";
          var marker: Ambient4755 = { marker: 7 };

          export function writeAmbient4755(): number {
            target = 9;
            var score: number = 0;
            if (target === 9) score += 1;
            if (lexicalStorageClean4755() === 1) score += 2;
            if (marker.marker === 7) score += 4;
            return score;
          }
          export function run(): number { return writeAmbient4755(); }
        `,
      },
      "./entry.ts",
      target,
      { target: 0 },
    );
    expect(value).toBe(7);
    // The current inliner proves the initialized foreign lexical read safe,
    // so neither it nor either ambient access may retain a ReferenceError
    // provider in this body.
    expect(referenceErrorCallCount(result, "writeAmbient4755")).toBe(0);
  });

  it("keeps a genuinely unresolvable collision on the strict GlobalEnvironmentRecord route", async () => {
    // `entry.ts` intentionally does not import the other module's lexical, so
    // the assignment Identifier has no checker declaration in this module.
    // Strict PutValue must evaluate rhs once, observe a missing global binding,
    // throw a real ReferenceError, and leave both the realm and -7 sentinel clean.
    const { result, value } = await compileMultiAndRunDirect(
      {
        "./lexical.ts": `
          export let genuinelyUnresolvable4755: number = -7;
          export function lexicalStorageClean4755(): number {
            return genuinelyUnresolvable4755 === -7 ? 1 : 0;
          }
        `,
        "./entry.ts": `
          import { lexicalStorageClean4755 } from "./lexical";
          var rhsCalls: number = 0;
          var afterAssignment: number = 0;

          function rhs(): any { rhsCalls += 1; return 41; }
          function trigger(): void {
            "use strict";
            genuinelyUnresolvable4755 = rhs();
            afterAssignment = 1;
          }

          export function run(): number {
            var verdict: number = 0;
            try { trigger(); }
            catch (error) { verdict = error instanceof ReferenceError ? 1 : 2; }
            var score: number = 0;
            if (verdict === 1) score += 1;
            if (rhsCalls === 1) score += 2;
            if (afterAssignment === 0) score += 4;
            if (lexicalStorageClean4755() === 1) score += 8;
            if (!("genuinelyUnresolvable4755" in globalThis)) score += 16;
            return score;
          }
        `,
      },
      "./entry.ts",
      target,
    );
    expect(value).toBe(31);
    expect(referenceErrorCallCount(result, "trigger")).toBeGreaterThan(0);
  });
});

describe.each(TARGETS)("#4755 direct TDZ provider and elision artifacts — %s", (target) => {
  it("re-resolves a shifted module-global index after emitting a real TDZ guard", async () => {
    const { value } = await compileAndRunDirect(
      `
        let preceding: number = 9;
        let target: number = 0;
        function updateInFinally(): number {
          try { return 1; }
          finally { target = target * 10 + 3; }
        }
        export function run(): number {
          return updateInFinally() * 1000 + target;
        }
      `,
      `issue-4755-post-tdz-index-${target}.ts`,
      target,
    );
    expect(value).toBe(1003);
  });

  it("keeps the live provider but makes initialized-let and var writes ReferenceError-neutral", async () => {
    const preInitialization = await compileAndRunDirect(
      `
        var rhsCalls: number = 0;
        var verdict: number = 0;
        function rhs(): number { rhsCalls += 1; return 42; }
        try {
          target = rhs();
        } catch (error) {
          verdict = error instanceof ReferenceError ? 1 : 2;
        }
        let target: number;
        export function run(): number { return verdict * 10 + rhsCalls; }
      `,
      `issue-4755-artifact-positive-${target}.ts`,
      target,
    );
    expect(preInitialization.value).toBe(11);
    expect(referenceErrorCallCount(preInitialization.result)).toBeGreaterThan(0);

    const initialized = await compileAndRunDirect(
      `
        var observed: number = 0;
        let target: number = 1;
        target = 42;
        observed = target;
        export function run(): number { return observed; }
      `,
      `issue-4755-artifact-initialized-${target}.ts`,
      target,
    );
    const varTwin = await compileAndRunDirect(
      `
        var observed: number = 0;
        var target: number = 1;
        target = 42;
        observed = target;
        export function run(): number { return observed; }
      `,
      `issue-4755-artifact-var-${target}.ts`,
      target,
    );

    expect(initialized.value).toBe(42);
    expect(varTwin.value).toBe(42);
    expect(referenceErrorCallCount(initialized.result)).toBe(0);
    expect(referenceErrorCallCount(varTwin.result)).toBe(0);
    expect(referenceErrorImports(initialized.result, target)).toEqual([]);
    expect(referenceErrorImports(varTwin.result, target)).toEqual([]);
    expect(initialized.result.linkedModules ?? []).toEqual([]);
    expect(varTwin.result.linkedModules ?? []).toEqual([]);

    if (target === "standalone") {
      expect(referenceErrorImports(preInitialization.result, target)).toEqual([]);
      expect(
        parseWatFunctions(preInitialization.result.wat).map(({ name }) => name),
        "standalone live in-module ReferenceError constructor",
      ).toContain("__new_ReferenceError");
    } else {
      expect(referenceErrorImports(preInitialization.result, target)).toEqual(["env.__throw_reference_error"]);
    }
  });
});
