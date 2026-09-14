// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export type CompilerSourceProducer =
  | "timer-shim"
  | "node-path-prelude"
  | "node-path-binding"
  | "import-wrapper"
  | "eval-super-rewrite"
  | "process-stdin-prelude"
  | "iterator-statics-prelude";

export interface CompilerSourceOrigin {
  readonly producer: CompilerSourceProducer;
  /** Producer-owned semantic role, independent of a parsed display name. */
  readonly role: string;
}

/** Half-open span relative to one edit's generated output text. */
export interface CompilerSourceOriginSpan {
  readonly start: number;
  readonly end: number;
  readonly origin: CompilerSourceOrigin;
}
