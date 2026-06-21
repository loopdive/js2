// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Shared context for the decomposed ES early-error detection rules (#1931).
// Every rule module receives an EarlyErrorContext instead of closing over the
// monolithic detectEarlyErrors scope. The context bundles the source file plus
// the three error-reporting primitives the rules need; behaviour is identical
// to the original closures.
import { ts } from "../../ts-api.js";
import type { CompileError } from "../../index.js";

export interface EarlyErrorContext {
  /** The source file being validated. */
  readonly sourceFile: ts.SourceFile;
  /** Accumulated errors (rules may push warnings/errors directly). */
  readonly errors: CompileError[];
  /** 1-based line/column for a node. */
  pos(node: ts.Node): { line: number; column: number };
  /** Push an error (severity "error") anchored at `node`. */
  addError(node: ts.Node, message: string): void;
}

/** Build an EarlyErrorContext for a source file, with a fresh error array. */
export function createEarlyErrorContext(sourceFile: ts.SourceFile): EarlyErrorContext {
  const errors: CompileError[] = [];
  const pos = (node: ts.Node): { line: number; column: number } => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return { line: line + 1, column: character + 1 };
  };
  const addError = (node: ts.Node, message: string): void => {
    const p = pos(node);
    errors.push({ message, line: p.line, column: p.column, severity: "error" });
  };
  return { sourceFile, errors, pos, addError };
}
