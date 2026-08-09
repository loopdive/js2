// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#2929 direct-eval async exception bridge", () => {
  it("rejects with the native SyntaxError thrown by a parameter-default eval", async () => {
    const exports = await compileToWasm(`
      async function f(p: any = eval("var arguments")): Promise<void> {}
      export function run(): any { return f(); }
    `);

    await expect(exports.run!()).rejects.toBeInstanceOf(SyntaxError);
  });
});
