// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Shared by the ambient-intrinsic IR tests (#7118, #7189, #7350): compile a
// script and run its `<module-init>`, or a TypeScript module and call one
// exported function, and report whether the IR claimed that unit (with no
// post-claim error); and ask the admission predicate directly, against a real
// checker with the lib loaded.

import { expect } from "vitest";

import { compile, type CompileOptions } from "../../src/index.js";
import { makeIrAmbientBindingPredicate } from "../../src/ir/module-bindings.js";
import { builtinGlobalValueAdmitted } from "../../src/ir/builtin-globals.js";
import { buildImports } from "../../src/runtime.js";
import { ts } from "../../src/ts-api.js";

/** `standalone` is the IR's lane; `undefined` is the default gc lane. */
export const TARGETS = ["standalone", undefined] as const;
export type Target = (typeof TARGETS)[number];
export const lane = (target: Target): string => target ?? "gc";

/** Compile with IR outcomes tracked, check that no claim was withdrawn, and instantiate. */
async function instantiateTracked(target: Target, source: string, options: CompileOptions) {
  const result = await compile(source, { ...options, trackIrOutcomes: true, ...(target ? { target } : {}) });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  // A claim is never withdrawn after the fact (#7189: claim-then-demote is a selector bug).
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const claimed = (unit: string): boolean =>
    (result.irOutcomes ?? []).find((outcome) => outcome.displayName === unit)?.irBodyEmitted === true;
  return { exports: instance.exports, claimed };
}

export interface ModuleInitRun {
  readonly claimed: boolean;
  readonly threw: boolean;
}

export async function runModuleInit(
  target: Target,
  source: string,
  { fileName, experimentalIR = true }: { readonly fileName: string; readonly experimentalIR?: boolean },
): Promise<ModuleInitRun> {
  const { exports, claimed } = await instantiateTracked(target, source, {
    fileName,
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal: true,
    deferTopLevelInit: true,
    experimentalIR,
  });
  let threw = false;
  try {
    (exports.__module_init as (() => void) | undefined)?.();
  } catch {
    threw = true;
  }
  return { claimed: claimed("<module-init>"), threw };
}

export interface ExportedUnitRun {
  readonly claimed: boolean;
  readonly answer: unknown;
}

/** A TypeScript module's exported function `unit`: whether the IR claimed it, and what calling it answers. */
export async function runExportedUnit(
  target: Target,
  source: string,
  { fileName, unit }: { readonly fileName: string; readonly unit: string },
): Promise<ExportedUnitRun> {
  const { exports, claimed } = await instantiateTracked(target, source, { fileName, skipSemanticDiagnostics: true });
  return { claimed: claimed(unit), answer: (exports[unit] as () => unknown)() };
}

/** `builtinGlobalValueAdmitted` for every value occurrence of `name` in `source`, in order. */
export function intrinsicUseVerdicts(source: string, name: string): boolean[] {
  const fileName = "/ambient-intrinsic-predicate.js";
  const options: ts.CompilerOptions = { allowJs: true, target: ts.ScriptTarget.ES2022, noResolve: true };
  const sourceFile = ts.createSourceFile(fileName, source, options.target!, true, ts.ScriptKind.JS);
  const host = ts.createCompilerHost(options, true);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (file) => file === fileName || fileExists.call(host, file);
  host.readFile = (file) => (file === fileName ? source : readFile.call(host, file));
  host.getSourceFile = (file, ...rest) => (file === fileName ? sourceFile : getSourceFile.call(host, file, ...rest));
  host.writeFile = () => {};
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  const libOnly = makeIrAmbientBindingPredicate(checker, "every");
  const verdicts: boolean[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && !ts.isFunctionDeclaration(node.parent)) {
      verdicts.push(builtinGlobalValueAdmitted(node, { isLibOnlyBinding: libOnly }));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return verdicts;
}
