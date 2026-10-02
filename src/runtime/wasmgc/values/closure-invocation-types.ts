// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Read-only physical layouts supplied by the owning caller, never a compiler context. */
export interface ClosureInvocationLayout {
  readonly rootTypeIdx?: number;
  readonly types: readonly ({ readonly kind: string; readonly superTypeIdx?: number } | undefined)[];
}

export interface ClosureInvocationArityEntry {
  readonly funcTypeIdx: number;
  readonly selfTypeIdx: number;
  readonly closureArity: number;
}
