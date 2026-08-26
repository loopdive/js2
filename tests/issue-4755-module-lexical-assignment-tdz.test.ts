// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4755 — the transitional direct frontend must perform PutValue's module-
 * lexical TDZ check after evaluating the assignment value, including the
 * already-live object/array destructuring sinks. Every runtime row deliberately
 * pins `experimentalIR: false` in both WasmGC lanes so an IR-owned body cannot
 * hide a legacy-body failure.
 */
import { describe, expect, it } from "vitest";
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

async function instantiateAndInitialize(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
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

interface WatFunction {
  readonly name: string;
  readonly body: string;
}

function parseWatFunctions(wat: string): readonly WatFunction[] {
  const starts = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  const names = starts.map(({ name }) => name);
  expect(new Set(names).size, "WAT function names must be unique for provider attribution").toBe(names.length);
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
});

describe.each(TARGETS)("#4755 direct TDZ provider and elision artifacts — %s", (target) => {
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
