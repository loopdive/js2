// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Shared context for the decomposed ES early-error detection rules (#1931).
// Every rule module receives an EarlyErrorContext instead of closing over the
// monolithic detectEarlyErrors scope. The context bundles the source file plus
// the three error-reporting primitives the rules need; behaviour is identical
// to the original closures.
import { ts } from "../../ts-api.js";
import type { CompileError } from "../../index.js";
import { markModuleGoalSourceFile } from "./predicates.js";

export interface EarlyErrorContext {
  /** The source file being validated. */
  readonly sourceFile: ts.SourceFile;
  /**
   * #3419 — the compilation unit is explicitly MODULE-goal (ES Module top-level
   * semantics) even without a syntactic import/export indicator. Set by the
   * test262 runner for `flags: [module]` tests; product compiles rely on the
   * real `ts.isExternalModule` indicator instead. Affects rules where Script
   * and Module top level genuinely differ (e.g. duplicate top-level function
   * declarations: legal in Scripts §16.1.1, SyntaxError in Modules §16.2.1.1).
   */
  readonly moduleGoal: boolean;
  /**
   * (#6491 r3) The unit is explicitly SCRIPT goal. Distinct from `!moduleGoal`,
   * which is also the state of every product compile — see `scriptGoal` in
   * `CompileOptions`. Gates the three rules where a ModuleItem is a SyntaxError
   * because there is no module to put it in.
   */
  readonly scriptGoal: boolean;
  /** Accumulated errors (rules may push warnings/errors directly). */
  readonly errors: CompileError[];
  /** 1-based line/column for a node. */
  pos(node: ts.Node): { line: number; column: number };
  /** Push an error (severity "error") anchored at `node`. */
  addError(node: ts.Node, message: string): void;
}

/** Build an EarlyErrorContext for a source file, with a fresh error array. */
export function createEarlyErrorContext(
  sourceFile: ts.SourceFile,
  opts?: { moduleGoal?: boolean; scriptGoal?: boolean },
): EarlyErrorContext {
  const errors: CompileError[] = [];
  // (#6491 r2) Module code is strict (§11.2.2). Registered BEFORE any rule
  // runs, so `isStrictMode`'s memo cannot hold a pre-mark answer for this file.
  if (opts?.moduleGoal === true) markModuleGoalSourceFile(sourceFile);
  const pos = (node: ts.Node): { line: number; column: number } => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return { line: line + 1, column: character + 1 };
  };
  const addError = (node: ts.Node, message: string): void => {
    const p = pos(node);
    errors.push({ message, line: p.line, column: p.column, severity: "error" });
  };
  return {
    sourceFile,
    moduleGoal: opts?.moduleGoal === true,
    scriptGoal: opts?.scriptGoal === true,
    errors,
    pos,
    addError,
  };
}
