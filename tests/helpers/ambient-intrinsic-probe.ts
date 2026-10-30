// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Shared by the ambient-intrinsic IR tests (#7118, #7189): compile a script,
// run its `<module-init>` and report whether the IR claimed it (with no
// post-claim error); and ask the admission predicate directly, against a real
// checker with the lib loaded.

import { expect } from "vitest";

import { compile } from "../../src/index.js";
import { makeIrAmbientBindingPredicate } from "../../src/ir/module-bindings.js";
import { isAmbientIntrinsicValueUse } from "../../src/shared/ambient-intrinsics.js";
import { buildImports } from "../../src/runtime.js";
import { ts } from "../../src/ts-api.js";

/** `standalone` is the IR's lane; `undefined` is the default gc lane. */
export const TARGETS = ["standalone", undefined] as const;
export type Target = (typeof TARGETS)[number];
export const lane = (target: Target): string => target ?? "gc";

export interface ModuleInitRun {
  readonly claimed: boolean;
  readonly threw: boolean;
}

export async function runModuleInit(
  target: Target,
  source: string,
  { fileName, experimentalIR = true }: { readonly fileName: string; readonly experimentalIR?: boolean },
): Promise<ModuleInitRun> {
  const result = await compile(source, {
    fileName,
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal: true,
    deferTopLevelInit: true,
    trackIrOutcomes: true,
    experimentalIR,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  // A claim is never withdrawn after the fact (#7189: claim-then-demote is a selector bug).
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  let threw = false;
  try {
    (instance.exports.__module_init as (() => void) | undefined)?.();
  } catch {
    threw = true;
  }
  const init = (result.irOutcomes ?? []).find((o) => o.displayName === "<module-init>");
  return { claimed: init?.irBodyEmitted === true, threw };
}

/** `isAmbientIntrinsicValueUse` for every value occurrence of `name` in `source`, in order. */
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
      verdicts.push(isAmbientIntrinsicValueUse(node, libOnly));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return verdicts;
}
