// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 (#6972 integration census) — a RegExp literal lowers through
// `extern.regex` → `env.RegExp_new`, which only the host-RegExp lane
// registers. The selector admitted every literal, so a claimable body holding
// one (`function f() { /1/g; … }`, or test262's
// `language/statementList/block-with-statment-regexp-literal-flags.js` once
// `<module-init>` became claimable) failed the compile with "unknown exact
// function import env.RegExp_new" — on gc, standalone and WASI alike. The
// literal now refuses where `host-regexp-constructor` is off, the predicate
// `new RegExp(…)` and the RegExp methods already share.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function build(source: string, target: "gc" | "standalone", experimentalIR = true) {
  return compile(source, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    deferTopLevelInit: true,
    ...(target === "standalone" ? { target: "standalone" } : {}),
    ...(experimentalIR ? {} : { experimentalIR: false }),
  } as Parameters<typeof compile>[1]);
}

async function run(result: Awaited<ReturnType<typeof build>>): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  (result.importObject as { setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.setInstance?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.run as () => number)();
}

describe("#7106 — a RegExp literal refuses before claiming off the host-RegExp lane", () => {
  const inFunction = `function f() { /1/g; return 1; }
export function run() { return f(); }`;
  const atTopLevel = `var x = { length: 3000 };
{ x.length }
/1/g;
export function run() { return x.length === 3000 ? 1 : 0; }`;

  for (const target of ["standalone", "gc"] as const) {
    it(`compiles a literal in a function body without a claim (${target})`, async () => {
      const result = await build(inFunction, target);
      const row = (result.irOutcomes ?? []).find((entry) => entry.displayName === "f");
      expect(row?.irBodyEmitted).toBe(false);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(await run(result)).toBe(1);
    }, 60_000);
  }

  it("leaves the module initializer with a literal to legacy, with no post-claim error (standalone)", async () => {
    const result = await build(atTopLevel, "standalone");
    const init = (result.irOutcomes ?? []).find((entry) => entry.displayName === "<module-init>");
    expect(init?.irBodyEmitted).toBe(false);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(await run(result)).toBe(await run(await build(atTopLevel, "standalone", false)));
  }, 60_000);

  it("keeps gc output byte-identical to the legacy build for the refused function", async () => {
    const ir = await build(inFunction, "gc");
    const legacy = await build(inFunction, "gc", false);
    expect(ir.success && legacy.success).toBe(true);
    expect(Buffer.from(ir.binary).equals(Buffer.from(legacy.binary))).toBe(true);
  }, 60_000);
});
