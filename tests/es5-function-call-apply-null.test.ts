// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5 Function.prototype.call/apply constructor-expression pins.
//
// The A8_T6/A7_T6 rows evaluate `.apply()` / `.call()` first and then use the
// returned function as the `new` target. The adjacent A8_T3..T5/A7_T3..T5 rows
// are receiver controls: they construct the reflective `.apply` / `.call`
// method itself and must keep throwing TypeError. Running the upstream files
// through the authoritative runner keeps these pins tied to their real harness
// and assertions instead of duplicating a weakened approximation here.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runTest262File } from "./test262-runner.js";

const ROWS = [
  // Positive constructor-expression rows owned by this fix.
  "built-ins/Function/prototype/apply/S15.3.4.3_A8_T6.js",
  "built-ins/Function/prototype/call/S15.3.4.4_A7_T6.js",
  // Neighboring receiver controls: constructing the reflective method itself
  // remains a TypeError and must not be captured by the dynamic-call arm.
  "built-ins/Function/prototype/apply/S15.3.4.3_A8_T3.js",
  "built-ins/Function/prototype/apply/S15.3.4.3_A8_T4.js",
  "built-ins/Function/prototype/apply/S15.3.4.3_A8_T5.js",
  "built-ins/Function/prototype/call/S15.3.4.4_A7_T3.js",
  "built-ins/Function/prototype/call/S15.3.4.4_A7_T4.js",
  "built-ins/Function/prototype/call/S15.3.4.4_A7_T5.js",
] as const;

describe("ES5 Function.call/apply constructor-expression semantics", () => {
  it.each(ROWS)("passes the exact Test262 row %s", async (relativePath) => {
    const result = await runTest262File(resolve("test262/test", relativePath), "es5-function-call-apply-null");
    expect(result.status, result.error ?? result.reason ?? "Test262 row did not pass").toBe("pass");
  });
});
