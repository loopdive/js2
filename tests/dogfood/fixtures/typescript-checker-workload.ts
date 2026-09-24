// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Tracked checker entry for the pinned TypeScript upstream-source checkout.
import { createTypeChecker } from "../.npm-upstream-suites/typescript/src/compiler/checker.js";
import { createSourceFile } from "../.npm-upstream-suites/typescript/src/compiler/parser.js";
import {
  ModuleKind,
  ScriptKind,
  ScriptTarget,
  type CompilerOptions,
  type SourceFile,
  type TypeCheckerHost,
} from "../.npm-upstream-suites/typescript/src/compiler/types.js";

function createHost(source: SourceFile, options: CompilerOptions): TypeCheckerHost {
  const files: readonly SourceFile[] = [source];
  const host = {
    getCompilerOptions: () => options,
    getSourceFiles: () => files,
    getSourceFile: (fileName: string) => (fileName === source.fileName ? source : undefined),
    getProjectReferenceRedirect: () => undefined,
    isSourceOfProjectReferenceRedirect: () => false,
    getResolvedModule: () => undefined,
    getResolvedTypeReferenceDirective: () => undefined,
    getRedirectFromSourceFile: () => undefined,
    redirectTargetsMap: new Map(),
    typesPackageExists: () => false,
    packageBundlesTypes: () => false,
    isEmittedFile: () => false,
    getCurrentDirectory: () => "/",
    getCommonSourceDirectory: () => "/",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (fileName: string) => fileName,
    fileExists: (fileName: string) => fileName === source.fileName,
    getEmitModuleFormatOfFile: () => ModuleKind.ESNext,
    getImpliedNodeFormatForEmit: () => ModuleKind.ESNext,
    getDefaultResolutionModeForFile: () => ModuleKind.ESNext,
    getModeForUsageLocation: () => ModuleKind.ESNext,
  };
  return host as unknown as TypeCheckerHost;
}

export function runCase(sourceText: string): number {
  const source = createSourceFile("/input.ts", sourceText, ScriptTarget.Latest, true, ScriptKind.TS);
  if (source.parseDiagnostics.length !== 0) return -source.parseDiagnostics.length;
  // Program.collectExternalModuleReferences normally fills these. The oracle
  // inputs have no imports or augmentations.
  source.imports = [];
  source.moduleAugmentations = [];
  source.ambientModuleNames = [];
  const options: CompilerOptions = { target: ScriptTarget.Latest, noLib: true, strict: true };
  const checker = createTypeChecker(createHost(source, options));
  const diagnostics = checker.getDiagnostics(source);
  if (diagnostics.length >= 256) throw new Error("Checker smoke oracle packing overflow");
  // Count in the high bits, first diagnostic code in the low 16 bits:
  // `const x: number = "str"` must report exactly one TS2322.
  const firstCode = diagnostics.length === 0 ? 0 : diagnostics[0].code;
  return diagnostics.length * 65_536 + firstCode;
}
