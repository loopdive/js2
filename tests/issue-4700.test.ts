// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4700 — bounded synchronous for-of lexical-head TDZ.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TDZ_ROWS = [
  "language/statements/for-of/head-const-bound-names-fordecl-tdz.js",
  "language/statements/for-of/head-let-bound-names-fordecl-tdz.js",
] as const;

const CONTROLS = [
  "language/statements/for-of/head-const-bound-names-in-stmt.js",
  "language/statements/for-of/head-let-bound-names-in-stmt.js",
  "language/statements/for-of/head-const-init.js",
  "language/statements/for-of/head-let-init.js",
  "language/statements/for-of/scope-body-lex-boundary.js",
] as const;

async function run(file: string) {
  return runTest262File(join("test262/test", file), "for-of", 60_000);
}

describe("#4700 — bounded for-of lexical-head TDZ", () => {
  it.each(TDZ_ROWS)("passes the exact TDZ row %s", async (file) => {
    const result = await run(file);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(CONTROLS)("keeps the control row %s green", async (file) => {
    const result = await run(file);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
