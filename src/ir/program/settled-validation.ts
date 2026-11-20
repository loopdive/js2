// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7415) The Prepared consumer, physical planner and native invocation validated the same prepared program in full
// several times per compile (8 on the #7365 prelude-shaped program). `assertPreparedIrProgram` reads only the
// program, so a program that can no longer change keeps its verdict (#7354 Perf settled verdict); a program that can
// still change is validated in full at every use, as before.
import type { PreparedIrProgram } from "./prepared-contracts.js";
import { PreparedIrSettledChecks } from "./settled-verdict.js";
import { assertPreparedIrProgram } from "./validation.js";

const programs = new PreparedIrSettledChecks<PreparedIrProgram>();

/** `assertPreparedIrProgram(program)`, run in full until `program` can no longer change, then once. */
export function assertSettledPreparedIrProgram(program: PreparedIrProgram): void {
  programs.check(program, () => assertPreparedIrProgram(program));
}
