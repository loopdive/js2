// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { buildBuiltinClosureValueInstrs } from "../src/runtime/wasmgc/values/closure-layouts.js";

describe("builtin closure value layout", () => {
  it("builds the closure value with its function, arity, empty captures and realm-state slot", () => {
    expect(buildBuiltinClosureValueInstrs(37, 19, 4, true)).toEqual([
      { op: "ref.func", funcIdx: 19 },
      { op: "i32.const", value: 4 },
      { op: "ref.null.extern" },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 37 },
      { op: "struct.new", typeIdx: 37 },
    ]);
  });
});
