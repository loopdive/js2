// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 (#6972 merge-group census) — `isPhase1Expr` admitted `x = v` as a
// VALUE whenever `x` is a dynamic module binding, but no builder arm lowers a
// value-position assignment: `lowerExpr` reaches `lowerBinary`, whose
// capability table defers `=` ("internal capability violation"). With the
// harness `<module-init>` claimable on standalone, the for-head initializer of
// ES5 `language/statements/for/head-init-expr-check-empty-inc-empty-syntax.js`
// (`for (count = 0;;)`, a pass on main) took that path and failed to compile;
// so does any other value position, e.g. a call argument. Statement-position
// writes keep their own arms and stay on the IR.
import { describe, expect, it } from "vitest";

import { compileHarnessBody, moduleInit, runModuleInit } from "./helpers/harness-module-init.js";

describe("#7106 — a value-position write to a dynamic module binding stays legacy", () => {
  const shapes: Record<string, string> = {
    "a for-head initializer": `var supreme = 5;
var count;
for (count = 0; ; ) { if (count === supreme) break; else count++; }
assert.sameValue(count, 5);`,
    "a call argument": `var count;
assert.sameValue(count = 7, 7);
assert.sameValue(count, 7);`,
  };

  for (const [name, body] of Object.entries(shapes)) {
    it(`refuses <module-init> at selection for ${name} (standalone)`, async () => {
      const result = await compileHarnessBody(body);
      expect(moduleInit(result)).toMatchObject({ kind: "unsupported", stage: "select" });
      await runModuleInit(result);
    }, 60_000);
  }

  it("keeps a statement-position write on the IR (standalone)", async () => {
    const result = await compileHarnessBody(`var count;
count = 0;
while (count < 3) count = count + 1;
assert.sameValue(count, 3);`);
    expect(moduleInit(result)?.irBodyEmitted).toBe(true);
    await runModuleInit(result);
  }, 60_000);
});
