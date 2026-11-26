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
 * The early errors are walked under the Script goal (as the test262 runner states it) and the Module goal, whatever
 * the options state. Each walk misses errors the other finds: `import.meta` is reported only under the Script goal;
 * `await 0` in a plain function only under the Module goal, because the Script walk tolerates one function level
 * for the runner's synthetic test wrapper, yet node rejects it in a Script too. Pinning an error the program's
 * real goal does not have only keeps a dead binding, so the union is the fail-closed choice.
 */
const GOAL_WALKS: readonly Partial<CompileOptions>[] = [
  { scriptGoal: true, inferModuleStrictArguments: false },
  { scriptGoal: false, inferModuleStrictArguments: true },
];

/**
 * Where the unelided source carries a frontend error: its TypeScript diagnostics (syntactic and, unless skipped,
 * semantic) and its ES early errors (`GOAL_WALKS`). Pinning more than the gate rejects only keeps a dead binding.
 * Undefined when an error in the source has no position, so no statement can be shown free of one.
 */
function frontendErrorOffsets(
  source: ts.SourceFile,
  scriptKind: ts.ScriptKind,
  analysis: Analysis,
  options: CompileOptions,
): number[] | undefined {
  const offsets: number[] = [];
  for (const diagnostic of [...analysis.syntacticDiagnostics, ...analysis.diagnostics]) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error || diagnostic.file !== source) continue;
    if (diagnostic.start === undefined) return undefined;
    offsets.push(diagnostic.start);
  }
  for (const goal of GOAL_WALKS) {
    // Each walk parses the text afresh and discards the parse. The detector memoizes per node (strict mode, the
    // Module-goal mark); a walk under another goal than the real gate's, on the real gate's SourceFile, left
    // answers the gate then read (review round 4: `var l = 010` passed under the Module goal).
    const parse = ts.createSourceFile(source.fileName, source.text, ts.ScriptTarget.Latest, true, scriptKind);
    for (const error of sourceEarlyErrors(parse, { ...options, ...goal }))
      offsets.push(parse.getPositionOfLineAndCharacter(error.line - 1, error.column - 1));
  }
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
  const file = names[0]!;
  const scriptKind = multiFileScriptKind(normalizeMultiFileName(file));
  const pinned = frontendErrorOffsets(source, scriptKind, analysis, options);
  if (!pinned) return files;
  const elided = elideDeadTopLevelBindings(files[file]!, scriptKind, pinned);
  return elided.elided.length === 0 ? files : { [file]: elided.source };
}
