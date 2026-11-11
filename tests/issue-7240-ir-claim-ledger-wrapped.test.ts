// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7240 — `scripts/ir-claim-ledger.mts --wrapped` compiles a test262 file as
 * the standalone runner does (original harness assembly + the runner's compile
 * options), so the harness's `assert` is in scope; raw mode does not.
 */
import { beforeAll, describe, expect, it } from "vitest";

type Ledger = typeof import("../scripts/ir-claim-ledger.mts");
let ledger: Ledger;

// The compiler reads JS2WASM_IR_SHAPE_DIAG once, at module load: set it before
// the (dynamic) import so `unsupported` rows carry their first-refusal detail.
beforeAll(async () => {
  process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  ledger = await import("../scripts/ir-claim-ledger.mts");
}, 120_000);

const PATH = "test262/test/issue-7240-probe.js";
const SOURCE = `/*---
description: issue 7240 probe
---*/
function f() { return 1; }
assert.sameValue(f(), 1);
`;
const ASSERT_NOT_IN_SCOPE = "expr-ident-not-in-scope:Identifier «assert»";

describe("#7240 ir-claim-ledger wrapped mode", () => {
  it("raw mode refuses `assert` as not in scope", async () => {
    const raw = await ledger.measureSource(PATH, SOURCE, "standalone");
    expect(raw.unsupportedDetails?.[ASSERT_NOT_IN_SCOPE]).toBe(1);
    expect(raw.byOrigin).toBeUndefined();
  }, 120_000);

  it("wrapped mode has no such refusal and splits harness from test units", async () => {
    const wrapped = await ledger.measureSource(PATH, SOURCE, "standalone", await ledger.loadWrappedCompiler());
    expect(wrapped.compileOk).toBe(1);
    expect(wrapped.unsupportedDetails?.[ASSERT_NOT_IN_SCOPE]).toBeUndefined();
    expect(Object.keys(wrapped.unsupportedDetails ?? {}).some((detail) => detail.includes("«assert»"))).toBe(false);
    const { harness, test } = wrapped.byOrigin!;
    expect(harness.units).toBeGreaterThan(0);
    // The test body's own `f` and the per-file `<module-init>` are test units.
    expect(test.byUnitKind).toEqual({ function: 1, "module-init": 1 });
    expect(harness.units + test.units).toBe(wrapped.units);
  }, 120_000);
});
