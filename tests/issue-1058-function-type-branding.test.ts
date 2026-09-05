// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import type { CodegenContext } from "../src/codegen/context/types.js";
import { addFuncType } from "../src/codegen/registry/types.js";

function registryContext(): CodegenContext {
  return {
    funcTypeCache: new Map(),
    mod: { types: [] },
  } as unknown as CodegenContext;
}

describe("#1058 function type semantic brands", () => {
  it("keeps undefined-sentinel f64 parameters and results out of plain f64 cache entries", () => {
    const ctx = registryContext();
    const plainParam = addFuncType(ctx, [{ kind: "f64" }], []);
    const sentinelParam = addFuncType(ctx, [{ kind: "f64", undefSentinel: true }], []);
    const sentinelParamAgain = addFuncType(ctx, [{ kind: "f64", undefSentinel: true }], []);
    const plainResult = addFuncType(ctx, [], [{ kind: "f64" }]);
    const sentinelResult = addFuncType(ctx, [], [{ kind: "f64", undefSentinel: true }]);
    const sentinelResultAgain = addFuncType(ctx, [], [{ kind: "f64", undefSentinel: true }]);

    expect(sentinelParam).not.toBe(plainParam);
    expect(sentinelParamAgain).toBe(sentinelParam);
    expect(sentinelResult).not.toBe(plainResult);
    expect(sentinelResultAgain).toBe(sentinelResult);
  });
});
