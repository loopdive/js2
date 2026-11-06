// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7105 — a SCRIPT-goal unique top-level `var` scalar shares legacy's
// `__mod_<name>` slot with IR readers and writers, exactly as the #2949 module
// capability does. test262 is all scripts, so before this every top-level
// `var` read inside a test function was `expr-ident-not-in-scope`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const OPTIONS = {
  allowJs: true,
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  target: "standalone",
  trackIrOutcomes: true,
} as const;

async function compileScript(source: string, fileName: string) {
  const result = await compile(source, { ...OPTIONS, fileName });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

/** A script's top-level code runs at instantiation; a top-level `throw` rejects it. */
async function instantiates(binary: Uint8Array): Promise<boolean> {
  try {
    await WebAssembly.instantiate(binary, {});
    return true;
  } catch {
    return false;
  }
}

describe("#7105 — script-goal top-level var scalars share the legacy slot", () => {
  it("writes and reads the slot from an IR body; legacy top-level code observes it", async () => {
    // No `import`/`export` ⇒ script goal. `bump` is the IR unit; the top-level
    // check is legacy reading the same `__mod_called` / `__mod_flag` slots.
    const result = await compileScript(
      `
        var called = 0;
        var flag = false;
        function bump(by: number): number { called = called + by; flag = true; return called; }
        if (bump(2) !== 2) throw new Error("return");
        bump(3);
        if (called !== 5 || flag !== true) throw new Error("slot");
      `,
      "issue-7105-script-var-rw.ts",
    );
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("bump");
    expect(await instantiates(result.binary)).toBe(true);
  });

  it("the same program with a wrong expectation rejects, so the check above is live", async () => {
    const result = await compileScript(
      `
        var called = 0;
        function bump(by: number): number { called = called + by; return called; }
        bump(2);
        if (called !== 99) throw new Error("slot");
      `,
      "issue-7105-script-var-control.ts",
    );
    expect(result.irCompiledFuncs ?? []).toContain("bump");
    expect(await instantiates(result.binary)).toBe(false);
  });

  it("keeps the script var out of IR when the source is a runtime-eval consumer", async () => {
    // A direct `eval` makes legacy widen every script var to externref
    // (representation-neutral storage); the IR must not share that slot.
    const result = await compile(
      `
        var called = 0;
        function bump(): number { called = called + 1; return called; }
        eval("called");
      `,
      { ...OPTIONS, fileName: "issue-7105-script-var-eval.ts" },
    );
    expect(result.irCompiledFuncs ?? []).not.toContain("bump");
  });

  it("keeps a var that is also a global-object property write on the direct path", async () => {
    // `this.called = …` at top level turns bare `called` reads into
    // global-environment lookups in legacy, so the slot is not the sole home.
    const result = await compileScript(
      `
        var called = 0;
        this.called = 5;
        function peek(): number { return called; }
      `,
      "issue-7105-script-var-this.ts",
    );
    expect(result.irCompiledFuncs ?? []).not.toContain("peek");
  });

  it("still admits the module-goal var exactly as #2949 did", async () => {
    const result = await compileScript(
      `
        var called = 0;
        function bump(by: number): number { called = called + by; return called; }
        export function test(): number { return bump(3) + bump(4); }
      `,
      "issue-7105-module-var.ts",
    );
    expect(result.irCompiledFuncs ?? []).toContain("bump");
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(10);
  });
});
