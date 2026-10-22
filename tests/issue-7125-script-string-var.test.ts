// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7125 — a string-typed SCRIPT `var` whose legacy `__mod_<name>` slot is the
// native-string carrier `(ref null $AnyString)` binds as a `string` module
// binding, so `<module-init>` claims it (before: the resolver refused it as
// `vardecl-module-storage-unrepresentable`, because the #7105/#7106 script arm
// admitted only number/boolean slots and the externref dynamic home). Each case
// is compared three ways: IR, a legacy-only compile, and node.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const OPTIONS = {
  fileName: "issue-7125-script-string-var.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
  scriptGoal: true,
  deferTopLevelInit: true,
  trackIrOutcomes: true,
} as const;

const CASES: Record<string, string> = {
  readByFunction: `var s = "a"; function f() { return s; } if (f() !== "a") { throw "#1"; } s = "b"; if (f() !== "b") { throw "#2"; }`,
  redeclared: `var s = "a"; var s = "bb"; var s; function f() { return s; } if (f() !== "bb") { throw "#3"; }`,
  writtenByFunction: `var s = "a"; function f() { return s; } function w() { s = "q"; } w(); if (f() !== "q") { throw "#4"; }`,
  failingCheck: `var s = "a"; function f() { return s; } if (f() !== "zz") { throw "#5"; }`,
};

type Lane = "standalone" | "gc";

async function run(lane: Lane, source: string, experimentalIR: boolean) {
  const result = await compile(source, {
    ...OPTIONS,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
    experimentalIR,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = lane === "standalone" ? {} : buildImports(result.imports, {}, result.stringPool);
  let threw = false;
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    (instance.exports.__module_init as (() => void) | undefined)?.();
  } catch {
    threw = true;
  }
  const init = (result.irOutcomes ?? []).find((o) => o.displayName === "<module-init>");
  return { threw, claimed: init?.irBodyEmitted === true };
}

function nodeThrows(source: string): boolean {
  try {
    new Function(source)();
    return false;
  } catch {
    return true;
  }
}

describe("#7125 — string script `var` in <module-init>", () => {
  for (const lane of ["standalone", "gc"] as const) {
    for (const [name, source] of Object.entries(CASES)) {
      it(`${name}: IR claims <module-init> and agrees with legacy and node (${lane})`, async () => {
        const ir = await run(lane, source, true);
        const legacy = await run(lane, source, false);
        expect(ir.claimed).toBe(true);
        expect(ir.threw).toBe(nodeThrows(source));
        expect(legacy.threw).toBe(ir.threw);
      });
    }
  }

  it("keeps a string var that is later written a number off the string arm", async () => {
    const source = `var s = "a"; s = 1; if (s !== 1) { throw "#6"; }`;
    const ir = await run("standalone", source, true);
    expect(ir.threw).toBe(false);
  });
});
