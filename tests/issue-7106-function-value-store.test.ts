// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 census arm 3 — a top-level function used as a bare VALUE stored on a
// function object (`assert._toString = formatSimpleValue;`), and a member write
// through the function object's own member (`Test262Error.prototype.x = v`).
// Both keep the function object a dynamic receiver: the stored function is the
// canonical function object boxed into the dynamic carrier (the same identity
// legacy reads back), `F.p` is a dynamic member get on the boxed `F`, and the
// write is the existing function-object member write. Every case is compared
// with node on the host-free and the host lane.
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

type Target = "standalone" | "gc";

async function compileJs(source: string, target: Target): Promise<CompileResult> {
  const result = await compile(source, {
    target,
    allowJs: true,
    fileName: "issue-7106-function-value-store.js",
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

function nodeRun(source: string): unknown {
  const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exportsObject: { run?: () => unknown } = {};
  new Function("exports", js)(exportsObject);
  return exportsObject.run!();
}

async function wasmRun(result: CompileResult, target: Target): Promise<unknown> {
  const imports = (target === "standalone" ? {} : result.importObject) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (result.importObject as { setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.setInstance?.(instance);
  return (instance.exports.run as () => unknown)();
}

function irEmitted(result: CompileResult, name: string): boolean {
  return (result.irOutcomes ?? []).some((outcome) => outcome.displayName === name && outcome.irBodyEmitted === true);
}

const MODULE_INIT_STORE = `
function fmt(value) { return "<" + String(value) + ">"; }
function holder(x) { return x; }
holder.show = fmt;
holder.alias = fmt;
function useIt(v) { return holder.show(v) + holder.alias(v); }
/** @returns {number} */
export function run() {
  var r = 0;
  if (useIt(5) === "<5><5>") r += 1;
  if (holder.show === fmt) r += 2;
  return r;
}
`;

const PROTOTYPE_CHAIN = `
function Ctor(x) { this.x = x; }
function show(v) { return "[" + String(v) + "]"; }
function holder(x) { return x; }
Ctor.prototype.tag = 7;
function setup(v) {
  Ctor.prototype.val = v;
  Ctor.prototype.show = show;
  holder.show = show;
  holder.prototype.kind = "h";
}
/** @returns {number} */
export function run() {
  setup(42);
  var c = new Ctor(1);
  var r = 0;
  if (c.tag === 7) r += 1;
  if (c.val === 42) r += 2;
  if (c.show(3) === "[3]") r += 4;
  if (holder.show(4) === "[4]") r += 8;
  if (new holder(1).kind === "h") r += 16;
  if (Ctor.prototype.show === show) r += 32;
  return r;
}
`;

describe("#7106 census arm 3 — function values stored on function objects", () => {
  for (const target of ["standalone", "gc"] as const) {
    it(`claims \`F.x = G\` in <module-init> and keeps G's identity (${target})`, async () => {
      const result = await compileJs(MODULE_INIT_STORE, target);
      expect(irEmitted(result, "<module-init>")).toBe(true);
      expect(await wasmRun(result, target)).toBe(nodeRun(MODULE_INIT_STORE));
      expect(nodeRun(MODULE_INIT_STORE)).toBe(3);
    });

    it(`claims \`F.prototype.x = v\` writes and the stored function value (${target})`, async () => {
      const result = await compileJs(PROTOTYPE_CHAIN, target);
      expect(irEmitted(result, "setup")).toBe(true);
      expect(irEmitted(result, "<module-init>")).toBe(true);
      expect(await wasmRun(result, target)).toBe(nodeRun(PROTOTYPE_CHAIN));
      expect(nodeRun(PROTOTYPE_CHAIN)).toBe(63);
    });
  }
});
