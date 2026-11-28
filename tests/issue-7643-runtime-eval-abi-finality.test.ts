// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7643 — both sides of the runtime-eval seam exchange the runtime value types (`RUNTIME_RECGROUP_TYPE_NAMES`): the
// result envelope is a `$__vec_externref`, and strings cross as `$AnyString` and its subtypes. WasmGC treats a final
// and a non-final type as different types, so the two sides must agree on every member's finality. Each side used to
// decide it from its own content (`finalizeLeafStructTypes` closes a leaf nobody subtypes). A consumer without a
// direct-eval site then closed `$__vec_externref`, could not read the provider's envelope, and every indirect eval or
// `new Function` with a dynamic source threw `undefined`. Both sides now keep every member open.
import { describe, expect, it } from "vitest";
import { RUNTIME_RECGROUP_TYPE_NAMES } from "../src/emit/canonical-recgroup.js";
import { compile } from "../src/index.js";

const CONSUMER = `function dyn(s: string): string { return s; }
export function run(): number { return (0, eval)(dyn("1 + 1")) as number; }`;

/**
 * The provider ABI's shape, as the boundary plan recognises it: top-level `__runtime_*` entries. Like the real
 * provider, it subtypes `$__vec_externref` (`arguments` registers `$__arguments_vec_externref`), which is what kept
 * the provider's copy open while a consumer closed its own.
 */
const PROVIDER = `function result(ok: boolean, value: any): any { const out: any[] = [ok, value]; return out; }
export function firstArgument(x: any): any { return arguments[0]; }
export function __runtime_indirect_eval(source: any, globalObject: any): any { return result(true, source); }
export function __runtime_new_function(params: any, body: any, globalObject: any): any { return result(true, body); }`;

const NEITHER = `export function run(): number { const xs: number[] = [1, 2]; return xs.length; }`;

/**
 * Each struct member's finality as declared in the WAT: without `(sub …)`, or with `(sub final …)`, it is final. The
 * array members are final on every side by construction (leaf finalization only touches structs), so they are skipped.
 */
async function memberFinality(source: string, target?: "standalone"): Promise<Record<string, boolean>> {
  const result = await compile(source, {
    fileName: "m.ts",
    skipSemanticDiagnostics: true,
    emitWat: true,
    ...(target ? { target } : {}),
  });
  expect(result.errors.filter((e) => e.severity === "error")).toEqual([]);
  const finality: Record<string, boolean> = {};
  for (const line of (result.wat ?? "").split("\n")) {
    const match = /^\s*\(type \$([^\s()]+) (.*)$/.exec(line);
    if (!match || !RUNTIME_RECGROUP_TYPE_NAMES.includes(match[1]!) || !match[2]!.includes("(struct")) continue;
    finality[match[1]!] = !match[2]!.startsWith("(sub ") || match[2]!.startsWith("(sub final ");
  }
  return finality;
}

const LANES = [
  ["gc", undefined],
  ["standalone", "standalone"],
] as const;

describe("#7643 runtime-eval value-ABI finality", () => {
  it.each(LANES)("keeps every group member open in a consumer without a direct-eval site (%s)", async (_, target) => {
    const finality = await memberFinality(CONSUMER, target);
    expect(Object.keys(finality)).toContain("__vec_externref");
    expect(Object.entries(finality).filter(([, closed]) => closed)).toEqual([]);
  });

  it.each(LANES)("keeps every group member open in a provider-shaped build (%s)", async (_, target) => {
    const finality = await memberFinality(PROVIDER, target);
    expect(Object.keys(finality)).toContain("__vec_externref");
    expect(Object.entries(finality).filter(([, closed]) => closed)).toEqual([]);
  });

  it.each(LANES)("gives both sides of the seam the same finality for every member (%s)", async (_, target) => {
    const consumer = await memberFinality(CONSUMER, target);
    const provider = await memberFinality(PROVIDER, target);
    for (const name of Object.keys(consumer).filter((name) => name in provider)) {
      expect({ name, final: consumer[name] }).toEqual({ name, final: provider[name] });
    }
  });

  it.each(LANES)("leaves a module outside the seam alone (%s)", async (_, target) => {
    const finality = await memberFinality(NEITHER, target);
    expect(finality.__vec_f64).toBe(true);
  });
});
