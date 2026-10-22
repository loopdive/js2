// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7122 — an empty array literal whose stores are all `.push` of proven
// strings (`const buf = []; buf.push(s); buf.join(" ")`, the shape of the
// test262 harness helper `printStringCodePoints`) is inferred as a vec of the
// backend string carrier, so `push` / `join` / `indexOf` / `includes` lower
// through the IR. Every case runs under node, under an IR compile and under a
// legacy-only compile, on the host-free standalone lane and the WasmGC host
// lane, and all three must agree.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

type Target = "standalone" | "gc";
const TARGETS: readonly Target[] = ["standalone", "gc"];

async function compileFor(source: string, target: Target, ir: boolean, strict = true) {
  const result = await compile(source, {
    target,
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    fileName: "issue-7122.js",
    allowJs: true,
    experimentalIR: ir,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (strict) expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

/** Evaluate every exported zero-argument function under node. */
function nodeExports(source: string): Record<string, () => unknown> {
  const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exportsObject: Record<string, () => unknown> = {};
  new Function("exports", js)(exportsObject);
  return exportsObject;
}

async function run(result: Awaited<ReturnType<typeof compile>>, target: Target) {
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    target === "standalone" ? {} : (result.importObject as WebAssembly.Imports),
  );
  return instance.exports as Record<string, () => unknown>;
}

async function expectIrLegacyAndNodeAgree(source: string, target: Target, irUnits: readonly string[], strict = true) {
  const irResult = await compileFor(source, target, true, strict);
  for (const unit of irUnits) {
    expect(irResult.irCompiledFuncs ?? [], `${unit} should be IR-emitted on ${target}`).toContain(unit);
  }
  const legacyResult = await compileFor(source, target, false);
  expect(legacyResult.irCompiledFuncs ?? []).toEqual([]);
  const irExports = await run(irResult, target);
  const legacyExports = await run(legacyResult, target);
  for (const [name, fn] of Object.entries(nodeExports(source))) {
    const expected = fn();
    expect(irExports[name]!(), `${name} (IR) on ${target}`).toBe(expected);
    expect(legacyExports[name]!(), `${name} (legacy) on ${target}`).toBe(expected);
  }
}

const PRINT_CODE_POINTS = `
/** @param {number} n */
function label(n) { return \`U+\${n}\`; }
function render(n) {
  const buf = [];
  for (let i = 0; i < n; i++) {
    let formatted = label(i * 3);
    buf.push(formatted);
  }
  return buf.join(" ");
}
export function printLike() {
  let r = 0;
  if (render(3) === "U+0 U+3 U+6") r += 1;
  if (render(1) === "U+0") r += 2;
  if (render(0) === "") r += 4;
  return r;
}
`;

const JOIN_SHAPES = `
function defaultSep() {
  const buf = [];
  buf.push("x");
  buf.push("");
  buf.push("y,z");
  return buf.join();
}
function emptySep() {
  const buf = [];
  buf.push("ab");
  buf.push("c");
  return buf.join("");
}
function selfJoin() {
  const buf = [];
  buf.push("a");
  buf.push(buf.join("+"));
  buf.push(buf.join("+"));
  return buf.join("/");
}
export function joins() {
  let r = 0;
  if (defaultSep() === "x,,y,z") r += 1;
  if (emptySep() === "abc") r += 2;
  if (selfJoin() === "a/a/a+a") r += 4;
  return r;
}
`;

const SEARCH_AND_LENGTH = `
function search() {
  const buf = [];
  buf.push("p");
  buf.push("q");
  buf.push("p");
  let r = 0;
  if (buf.indexOf("p") === 0) r += 1;
  if (buf.indexOf("q") === 1) r += 2;
  if (buf.indexOf("r") === -1) r += 4;
  if (buf.includes("q")) r += 8;
  if (!buf.includes("")) r += 16;
  return r;
}
function pushResult() {
  const buf = [];
  const first = buf.push("a");
  const second = buf.push("bb");
  return first * 10 + second + buf.length * 100;
}
export function searches() {
  return search() * 1000 + pushResult();
}
`;

// Element reads of the inferred vec are not in this slice (an out-of-range
// read adds `undefined` evidence; an in-range one needs a bounds proof):
// whichever path compiles them, the answer must still be node's.
const READS = `
function reads() {
  const buf = [];
  buf.push("ab");
  buf.push("c");
  let r = 0;
  if (buf[0] === "ab") r += 1;
  if (buf[1] + buf[0] === "cab") r += 2;
  if (buf[2] === undefined) r += 4;
  return r;
}
export function readAll() { return reads(); }
`;

describe("#7122 — IR push / join / search on an empty literal inferred as string[]", () => {
  for (const target of TARGETS) {
    it(`the printStringCodePoints shape matches legacy and node (${target})`, async () => {
      await expectIrLegacyAndNodeAgree(PRINT_CODE_POINTS, target, ["render", "printLike"]);
    });

    it(`join separators and a push of the vec's own join match (${target})`, async () => {
      await expectIrLegacyAndNodeAgree(JOIN_SHAPES, target, ["defaultSep", "emptySep", "selfJoin"]);
    });

    it(`indexOf / includes / push result / length match (${target})`, async () => {
      await expectIrLegacyAndNodeAgree(SEARCH_AND_LENGTH, target, ["search", "pushResult"]);
    });
  }

  for (const target of TARGETS) {
    it(`element reads keep node semantics on whichever path compiles them (${target})`, async () => {
      await expectIrLegacyAndNodeAgree(READS, target, [], false);
    });
  }

  it("refuses groups the inference cannot close as string[]", async () => {
    const result = await compileFor(
      `
      function mixed() { const buf = []; buf.push("a"); buf.push(1); return buf.join(); }
      function escapes(sink) { const buf = []; buf.push("a"); sink(buf); return buf.join(); }
      function unknownPush(v) { const buf = []; buf.push(v); return buf.join(); }
      export function run() { return mixed().length + escapes(() => 0).length + unknownPush("q").length; }
      `,
      "standalone",
      true,
    );
    for (const name of ["mixed", "escapes", "unknownPush"]) {
      expect(result.irCompiledFuncs ?? [], name).not.toContain(name);
    }
  });
});
