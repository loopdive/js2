// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 (#6972 merge-group census) — once the harness `<module-init>` claims on
// standalone, its function expressions (`print`, `assert.sameValue`, …) lift
// into fresh slots that hold the allocation placeholder type until the
// module-init patch installs. A test body calling a declaration whose claim is
// withdrawn on a typeIdx parity mismatch cascade-withdraws `<module-init>`, and
// those slots were left untyped: the final ABI planner then rejected the module
// with "retained function <module-init>__closure_0 references non-function or
// missing type 0" (test262 `language/expressions/await/await-in-function.js`,
// a pass on main). An orphaned slot now takes a real signature.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

const BODY = `/*---
description: a declaration whose IR claim withdraws post-claim, called at top level
---*/
function foo(a) { return a; }
assert.sameValue(foo(1), 1);
`;

describe("#7106 — a cascade-withdrawn <module-init> leaves no untyped closure slot", () => {
  it("compiles and runs the harness test on standalone", async () => {
    const source = assembleOriginalHarness(BODY, parseMeta(BODY) as never).primary.source;
    const result = await compile(source, {
      fileName: "test.js",
      allowJs: true,
      target: "standalone",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((result.irPostClaimErrors ?? []).map((error) => error.func)).toContain("<module-init>");
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect(() => (instance.exports.__module_init as () => void)()).not.toThrow();
  }, 60_000);
});
