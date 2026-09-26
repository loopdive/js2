// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import * as combinators from "../src/codegen/promise-combinators.js";
import * as scheduler from "../src/codegen/async-scheduler.js";
import { emitObservableStandalonePromiseCombinatorLiteral } from "../src/codegen/promise-observable-combinators.js";
import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";

it("reports cached unavailable support instead of dereferencing null", () => {
  // Fault injection: setup already failed in the other observable entry point.
  // No allocator/runtime behavior is inferred from this diagnostic-only test.
  const combinatorSpy = vi.spyOn(combinators, "ensureCombinatorFunctions").mockReturnValueOnce(undefined as never);
  const schedulerSpy = vi.spyOn(scheduler, "ensureAsyncDriveRuntime").mockReturnValueOnce(undefined as never);
  try {
    const ctx = { __promiseObservableCombinators: null } as unknown as CodegenContext;
    expect(() => emitObservableStandalonePromiseCombinatorLiteral(ctx, {} as FunctionContext, "all", [])).toThrow(
      "observable Promise combinator pipeline requires closure invocation, property reads, and TypeError runtime support",
    );
  } finally {
    combinatorSpy.mockRestore();
    schedulerSpy.mockRestore();
  }
});
