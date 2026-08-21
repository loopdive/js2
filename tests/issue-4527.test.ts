// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4527 — a class-method rest bridge must pass exactly `(receiver, vector)`.
 *
 * Class-method rest metadata is indexed in the Wasm signature (the receiver is
 * slot zero), while the vector is the first user argument. The generic dynamic
 * bridge used to count that vector as a fixed argument and emitted an invalid
 * call. Two same-named methods keep the reduction on the multi-struct dispatch
 * path that exposed the Axios modules.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

describe("#4527 — class rest dispatch bridge", () => {
  it("validates a dynamic call shared by two differently shaped classes", async () => {
    const source = `
      class A {
        private a = 1;
        concat(...xs: any[]) { return this.a + xs.length; }
      }
      class B {
        private b = 10;
        concat(...xs: any[]) { return this.b + xs.length; }
      }
      export function test(x: any, xs: any[]) { return x.concat(...xs); }
    `;
    const result = await compile(source, {
      fileName: "issue-4527.ts",
      skipSemanticDiagnostics: true,
      target: "gc",
      emitWat: true,
    });
    expect(result.errors ?? []).toEqual([]);
    expect(result.wat).toContain("__class_call_concat_vararg");
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });
});
