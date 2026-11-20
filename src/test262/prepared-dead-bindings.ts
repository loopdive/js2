// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CompileOptions } from "../index.js";
import type { analyzeMultiSource } from "../checker/index.js";
import { multiFileScriptKind, normalizeMultiFileName } from "../checker/multi-file-paths.js";
import { sourceEarlyErrors } from "../compiler/prepared-pipeline-boundary.js";
import { deadBindingElisionApplies, elideDeadTopLevelBindings } from "../deadcode-elide.js";
import type { CompileTargetProfile } from "../target-profile.js";
import { ts } from "../ts-api.js";

type Analysis = ReturnType<typeof analyzeMultiSource>;

/**
 * The options' own goal, and each goal stated explicitly: a caller that leaves the goal unstated gets the
 * goal-dependent errors of both (`import.meta` in a Script, duplicate top-level functions in a Module) pinned.
 */
const GOALS: readonly Partial<CompileOptions>[] = [{}, { scriptGoal: true }, { inferModuleStrictArguments: true }];

/**
 * Where the unelided source carries a frontend error: its TypeScript diagnostics (syntactic and, unless skipped,
 * semantic) and its ES early errors under every goal (`GOALS`). Pinning more than the gate rejects only keeps a
 * dead binding. Undefined when an error in the source has no position, so no statement can be shown free of one.
 */
function frontendErrorOffsets(source: ts.SourceFile, analysis: Analysis, options: CompileOptions): number[] | undefined {
  const offsets: number[] = [];
  for (const diagnostic of [...analysis.syntacticDiagnostics, ...analysis.diagnostics]) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error || diagnostic.file !== source) continue;
    if (diagnostic.start === undefined) return undefined;
    offsets.push(diagnostic.start);
  }
  for (const goal of GOALS)
    for (const error of sourceEarlyErrors(source, { ...options, ...goal }))
      offsets.push(source.getPositionOfLineAndCharacter(error.line - 1, error.column - 1));
  return offsets;
}

/**
 * #7354 F0 — the ordinary compile's #3418 dead-binding elision on the strict Prepared front door, so a test262
 * runtime-shim binding a test never names (`print`, `$262`) does not have to lower. It decides on the analysis of
 * the UNELIDED graph and keeps every statement that holds a frontend error there: dropping one would drop the only
 * evidence of a SyntaxError (`var g = function () { l: l: ; };`). Only a one-source graph: a Script `var` of one
 * source can be read by another, which this per-text pass cannot see. Blanking is same-length, so positions,
 * origins and diagnostics stay the supplied source's. Returns `files` itself when nothing is dropped.
 */
export function elideDeadBindings(
  files: Record<string, string>,
  analysis: Analysis,
  profile: CompileTargetProfile,
  options: CompileOptions,
): Record<string, string> {
  const names = Object.keys(files);
  const source = analysis.entryFile;
  if (names.length !== 1 || !source || !deadBindingElisionApplies(profile, options.standaloneScriptVarBindings))
    return files;
  const pinned = frontendErrorOffsets(source, analysis, options);
  if (!pinned) return files;
  const file = names[0]!;
  const elided = elideDeadTopLevelBindings(files[file]!, multiFileScriptKind(normalizeMultiFileName(file)), pinned);
  return elided.elided.length === 0 ? files : { [file]: elided.source };
}
