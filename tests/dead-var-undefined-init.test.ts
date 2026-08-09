// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { VarInitElisionAnalysis } from "../src/checker/var-init-elision.js";
import { compile, type CompileResult } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { setupClsx } from "./dogfood/setup-clsx.mjs";

const ELISION_FLAG = "JS2WASM_ELIDE_DEAD_VAR_UNDEFINED";
const PRIVATE_ARGUMENTS_FLAG = "JS2WASM_ELIDE_PRIVATE_ARGUMENTS_REGISTRATION";

const POSITIVE_SOURCE = `
export function sequential() { var x; x = "ok"; return x; }
export function ifElse(flag) { var x; if (flag) x = "yes"; else x = "no"; return x; }
export function logicalAnd(flag) { var x; return (flag && (x = "ok") && x) || "miss"; }
export function logicalOr(flag) { var x; return flag || (x = "") || (x === "" ? "assigned" : "bad"); }
export function logicalNot(flag) { var x; return !(flag && (x = "ok")) || x; }
export function conditional(flag) { var x; flag ? (x = "yes") : (x = "no"); return x; }
export function doOnce() { var x; do { x = "ok"; } while (false); return x; }
export function forInitializer() { var x; for (x = "ok"; false;) {} return x; }
export function unused() { var x; return "ok"; }
`;

const NEGATIVE_SOURCE = `
export function readBeforeWrite() { var x; return x; }
export function incomplete(flag) { var x; if (flag) x = "ok"; return x; }
export function selfInit() { var x = x || "fallback"; return x; }
export function compound() { var x; x *= 2; return typeof x; }
export function update() { var x; x++; return typeof x; }
export function loopExit(flag) { var x; while (flag) { x = "ok"; flag = false; } return x; }
`;

type RuntimeImports = WebAssembly.Imports & {
  env?: Record<string, WebAssembly.ImportValue>;
  __setInstance?: (instance: WebAssembly.Instance) => void;
  __setExports?: (exports: WebAssembly.Exports) => void;
};

interface InstrumentedInstance {
  exports: Record<string, (...args: unknown[]) => unknown>;
  calls(): number;
  reset(): void;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

async function compileArm(
  source: string,
  optimize: 0 | 3,
  enabled: boolean | undefined,
  fileName: string,
): Promise<CompileResult> {
  const previousElision = process.env[ELISION_FLAG];
  const previousPrivateArguments = process.env[PRIVATE_ARGUMENTS_FLAG];
  if (enabled === undefined) Reflect.deleteProperty(process.env, ELISION_FLAG);
  else process.env[ELISION_FLAG] = enabled ? "1" : "0";
  process.env[PRIVATE_ARGUMENTS_FLAG] = "1";
  try {
    const result = await compile(source, {
      fileName,
      skipSemanticDiagnostics: true,
      experimentalIR: false,
      optimize,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    return result;
  } finally {
    restoreEnv(ELISION_FLAG, previousElision);
    restoreEnv(PRIVATE_ARGUMENTS_FLAG, previousPrivateArguments);
  }
}

async function instantiateInstrumented(result: CompileResult): Promise<InstrumentedInstance> {
  const imports = (result.importObject ?? {}) as RuntimeImports;
  const original = imports.env?.__get_undefined;
  let count = 0;
  if (typeof original === "function") {
    imports.env!.__get_undefined = (...args: unknown[]): unknown => {
      count++;
      return (original as (...callArgs: unknown[]) => unknown)(...args);
    };
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.__setInstance?.(instance);
  imports.__setExports?.(instance.exports);
  return {
    exports: wrapExports(instance.exports, { signatures: result.exportSignatures }) as Record<
      string,
      (...args: unknown[]) => unknown
    >,
    calls: () => count,
    reset: () => {
      count = 0;
    },
  };
}

async function expectInvocation(
  runtime: InstrumentedInstance,
  name: string,
  args: unknown[],
  expected: unknown,
  expectedCalls: number,
): Promise<void> {
  runtime.reset();
  const actual = runtime.exports[name]!(...args);
  expect(actual, name).toEqual(expected);
  expect(runtime.calls(), `${name} __get_undefined calls`).toBe(expectedCalls);
}

describe.each([0, 3] as const)("dead hoisted-var undefined initialization (optimize %i)", (optimize) => {
  it("elides only must-written entry values across sequential and boolean flow", async () => {
    const candidate = await compileArm(POSITIVE_SOURCE, optimize, undefined, `positive-${optimize}.mjs`);
    const control = await compileArm(POSITIVE_SOURCE, optimize, false, `positive-control-${optimize}.mjs`);
    const candidateRuntime = await instantiateInstrumented(candidate);
    const controlRuntime = await instantiateInstrumented(control);
    const invocations: Array<[string, unknown[], unknown]> = [
      ["sequential", [], "ok"],
      ["ifElse", [true], "yes"],
      ["ifElse", [false], "no"],
      ["logicalAnd", [true], "ok"],
      ["logicalAnd", [false], "miss"],
      ["logicalOr", [true], true],
      ["logicalOr", [false], "assigned"],
      ["logicalNot", [true], "ok"],
      ["logicalNot", [false], true],
      ["conditional", [true], "yes"],
      ["conditional", [false], "no"],
      ["doOnce", [], "ok"],
      ["forInitializer", [], "ok"],
      ["unused", [], "ok"],
    ];
    for (const [name, args, expected] of invocations) {
      await expectInvocation(candidateRuntime, name, args, expected, 0);
      await expectInvocation(controlRuntime, name, args, expected, 1);
    }
    expect(candidate.binary.length).toBeLessThan(control.binary.length);
  });

  it("retains undefined for reads-before-writes, partial branches, self-init, RMW, and loop exits", async () => {
    const result = await compileArm(NEGATIVE_SOURCE, optimize, undefined, `negative-${optimize}.mjs`);
    const runtime = await instantiateInstrumented(result);
    const invocations: Array<[string, unknown[], unknown]> = [
      ["readBeforeWrite", [], undefined], // positive control: `var x; return x`
      ["incomplete", [false], undefined],
      ["incomplete", [true], "ok"],
      ["selfInit", [], "fallback"],
      ["compound", [], "number"],
      ["update", [], "number"],
      ["loopExit", [false], undefined],
      ["loopExit", [true], "ok"],
    ];
    for (const [name, args, expected] of invocations) {
      await expectInvocation(runtime, name, args, expected, 1);
    }
  });
});

describe("checker-layer fail-closed surface", () => {
  it("declines redeclarations, shadows, captures, dynamic scope, and unsupported control flow", () => {
    const source = `
function redeclared() { var x; var x = "ok"; return x; }
function shadowed(flag) { var x; x = "ok"; if (flag) { let x = "inner"; return x; } return x; }
function captured() { var x; x = "ok"; function read() { return x; } return read(); }
function directEval() { var x; x = "ok"; return (eval as any)("x"); }
function tryFinally() { var x; try { x = "ok"; } finally {} return x; }
function switched(flag) { var x; x = "ok"; switch (flag) { case true: return x; } return x; }
function labeled() { var x; x = "ok"; outer: { break outer; } return x; }
function continued() { var x; x = "ok"; for (var i = 0; i < 1; i++) continue; return x; }
function destructured() { var x; x = "ok"; var { value } = { value: 1 }; return x; }
async function asynchronous() { var x; x = "ok"; return x; }
function* generator() { var x; x = "ok"; yield x; }
function resource() { var x; x = "ok"; using handle = null as any; return x; }
function dynamicScope() { var x; x = "ok"; with ({}) { x; } return x; }
function parameterDefault(value = "fallback") { var x; x = value; return x; }
function shorthandDefault(flag) { var holder, x; if (flag) holder = "ok"; return ({ holder = x }); }
function uncertainThis() { var x; this && (x = "ok"); this || x; }
function nullishFlow() { var x; x = "ok"; return x ?? "fallback"; }
function logicalAssignment() { var x; x = "ok"; x ||= "fallback"; return x; }
function optionalChain() { var x; x = "ok"; return ({ value: x } as any)?.value; }
function spreadElement() { var x; x = "ok"; return [...[x]]; }
function deleteExpression() { var x; x = "ok"; delete ({} as any).value; return x; }
`;
    const ast = analyzeSource(source, "fail-closed.ts", { skipSemanticDiagnostics: true });
    const analysis = new VarInitElisionAnalysis(ast.checker);
    const verdicts = new Map<string, boolean>();
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        let declaration: ts.VariableDeclaration | undefined;
        const findX = (child: ts.Node): void => {
          if (declaration !== undefined && child !== node) return;
          if (
            ts.isVariableDeclaration(child) &&
            ts.isIdentifier(child.name) &&
            child.name.text === "x" &&
            enclosingFunctionDeclaration(child) === node
          ) {
            declaration = child;
            return;
          }
          ts.forEachChild(child, findX);
        };
        ts.forEachChild(node.body, findX);
        if (declaration) verdicts.set(node.name.text, analysis.canElideUndefinedInit(declaration));
      }
      ts.forEachChild(node, visit);
    };
    visit(ast.sourceFile);
    expect([...verdicts.entries()]).toEqual([
      ["redeclared", false],
      ["shadowed", false],
      ["captured", false],
      ["directEval", false],
      ["tryFinally", false],
      ["switched", false],
      ["labeled", false],
      ["continued", false],
      ["destructured", false],
      ["asynchronous", false],
      ["generator", false],
      ["resource", false],
      ["dynamicScope", false],
      ["parameterDefault", false],
      ["shorthandDefault", false],
      ["uncertainThis", false],
      ["nullishFlow", false],
      ["logicalAssignment", false],
      ["optionalChain", false],
      ["spreadElement", false],
      ["deleteExpression", false],
    ]);
  });
});

function enclosingFunctionDeclaration(node: ts.Node): ts.FunctionDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current;
  }
  return undefined;
}

describe.each([0, 3] as const)("pinned clsx undefined-init A/B (optimize %i)", (optimize) => {
  it("removes all nine executed var-entry host calls without changing the native result", async () => {
    const { entryModulePath } = setupClsx();
    const source = `${readFileSync(entryModulePath, "utf8")}
export function op_two_strings(first, second) { return clsx(first, second); }
export function op_two_strings_many(iterations) {
  var checksum = 0;
  for (var index = 0; index < iterations; index++) checksum += clsx("foo", "bar").length;
  return checksum;
}
`;
    const candidate = await compileArm(source, optimize, undefined, `clsx-candidate-${optimize}.mjs`);
    const control = await compileArm(source, optimize, false, `clsx-control-${optimize}.mjs`);
    const candidateRuntime = await instantiateInstrumented(candidate);
    const controlRuntime = await instantiateInstrumented(control);
    const nativePath = entryModulePath.replace(/\/clsx\.mjs$/, "/clsx.js");
    const nativeClsx = createRequire(import.meta.url)(nativePath).clsx as (...values: unknown[]) => string;
    const expected = nativeClsx("foo", "bar");

    await expectInvocation(controlRuntime, "op_two_strings", ["foo", "bar"], expected, 9);
    await expectInvocation(candidateRuntime, "op_two_strings", ["foo", "bar"], expected, 0);
    await expectInvocation(controlRuntime, "op_two_strings_many", [1], expected.length, 9);
    await expectInvocation(candidateRuntime, "op_two_strings_many", [1], expected.length, 0);
    await expectInvocation(controlRuntime, "op_two_strings_many", [5], expected.length * 5, 45);
    await expectInvocation(candidateRuntime, "op_two_strings_many", [5], expected.length * 5, 0);
    expect(expected).toBe("foo bar");
    expect(candidate.binary.length).toBeLessThan(control.binary.length);
    // Do not assert import absence: indexed OOB fallback can legitimately keep
    // env.__get_undefined even though the measured operation executes it 0x.
  });
});
