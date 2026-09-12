// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5361 — `a.splice(start, deleteCount, ...items)` must insert every ELEMENT of
// the spread source, not the source itself.
//
// The lowering counted `callExpr.arguments.length - 2`, so a spread counted as
// one item and the source array landed in a single slot. The nesting is
// invisible to a default `join()` — `["x","y"]` stringifies to `x,y`, which
// reads the same inside a comma-joined result — so every assertion here pins
// BOTH the resulting `length` and a join with a NON-comma separator. That is
// what made hono's `expandIPv6` fail: `sections[i].padStart` ran on an array.
//
// Both receiver lanes are covered, because they are different code paths:
//   - a HOST receiver (`text.split(":")` in another module, an externref) goes
//     out through the generic `__extern_method_call` argument array;
//   - a NATIVE vec receiver goes through `compileArraySplice`'s rebuild.
// Untyped `.js` sources in a two-file project, matching the dogfood lane the
// defect was found in.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileProject, type CompileResult } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const LIB_SOURCE = `
export function spliceHostReceiver(text, tail) {
  const sections = text.split(":");
  sections.splice(-1, 1, ...tail.split(":"));
  return sections;
}

export function spliceVecReceiver(tail) {
  const sections = ["a", "b", "c"];
  sections.splice(-1, 1, ...tail.split(":"));
  return sections;
}

export function spliceArrayLiteralSpread() {
  const sections = ["a", "b", "c"];
  sections.splice(-1, 1, ...["x", "y"]);
  return sections;
}

export function spliceNoSpread() {
  const sections = ["a", "b", "c"];
  sections.splice(1, 1, "x", "y");
  return sections;
}

export function spliceMixedSpread(tail) {
  const sections = ["a", "b", "c"];
  sections.splice(1, 1, "p", ...tail.split(":"), "q");
  return sections;
}

export function toSplicedSpread(tail) {
  const sections = ["a", "b", "c"];
  return sections.toSpliced(-1, 1, ...tail.split(":"));
}

export function pushArrayLiteralSpread() {
  const out = ["a"];
  out.push(...["x", "y"]);
  return out;
}

export function maxArrayLiteralSpread() {
  return Math.max(...[1, 5, 3]);
}
`;

const ENTRY_SOURCE = `
import {
  spliceHostReceiver,
  spliceVecReceiver,
  spliceArrayLiteralSpread,
  spliceNoSpread,
  spliceMixedSpread,
  toSplicedSpread,
  pushArrayLiteralSpread,
  maxArrayLiteralSpread,
} from "./lib.js";

export function hostJoin() { return spliceHostReceiver("a:b:c", "x:y").join(":"); }
export function hostLength() { return spliceHostReceiver("a:b:c", "x:y").length; }
export function vecJoin() { return spliceVecReceiver("x:y").join(":"); }
export function vecLength() { return spliceVecReceiver("x:y").length; }
export function literalJoin() { return spliceArrayLiteralSpread().join(":"); }
export function literalLength() { return spliceArrayLiteralSpread().length; }
export function controlJoin() { return spliceNoSpread().join(":"); }
export function controlLength() { return spliceNoSpread().length; }
export function mixedJoin() { return spliceMixedSpread("m:n").join(":"); }
export function mixedLength() { return spliceMixedSpread("m:n").length; }
export function toSplicedJoin() { return toSplicedSpread("x:y").join(":"); }
export function toSplicedLength() { return toSplicedSpread("x:y").length; }
export function pushJoin() { return pushArrayLiteralSpread().join(":"); }
export function pushLength() { return pushArrayLiteralSpread().length; }
export function maxSpread() { return maxArrayLiteralSpread(); }

// The hono shape the issue was filed from: every section is read back as a
// string, so a nested array is a hard "padStart is not a function".
export function ipv6Shape() {
  const sections = "1:2:127.0.0.1".split(":");
  sections.splice(-1, 1, ..."7f00:0001".split(":"));
  let out = "";
  for (let i = 0; i < sections.length; i++) {
    out = out + (i === 0 ? "" : ":") + sections[i].padStart(4, "0");
  }
  return out;
}
`;

let dir: string;
let exports: Record<string, () => unknown>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "js2-issue-5361-"));
  writeFileSync(join(dir, "lib.js"), LIB_SOURCE);
  const entry = join(dir, "entry.js");
  writeFileSync(entry, ENTRY_SOURCE);

  const result: CompileResult = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
  });
  expect(
    result.success,
    `compile failed:\n${(result.errors ?? []).map((e) => `${e.severity}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const instance = await instantiateWithRuntime(result);
  exports = instance.exports as unknown as Record<string, () => unknown>;
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("#5361 — splice inserts spread ELEMENTS, not the spread source", () => {
  it("expands a spread on a HOST (externref) receiver", () => {
    expect(exports.hostLength!()).toBe(4);
    expect(String(exports.hostJoin!())).toBe("a:b:x:y");
  });

  it("expands a spread on a NATIVE vec receiver", () => {
    expect(exports.vecLength!()).toBe(4);
    expect(String(exports.vecJoin!())).toBe("a:b:x:y");
  });

  it("expands a spread of an inline ARRAY LITERAL", () => {
    expect(exports.literalLength!()).toBe(4);
    expect(String(exports.literalJoin!())).toBe("a:b:x:y");
  });

  it("keeps the no-spread control exact", () => {
    expect(exports.controlLength!()).toBe(4);
    expect(String(exports.controlJoin!())).toBe("a:x:y:c");
  });

  it("interleaves positional items and a spread in argument order", () => {
    expect(exports.mixedLength!()).toBe(6);
    expect(String(exports.mixedJoin!())).toBe("a:p:m:n:q:c");
  });

  it("expands a spread in the non-mutating toSpliced twin", () => {
    expect(exports.toSplicedLength!()).toBe(4);
    expect(String(exports.toSplicedJoin!())).toBe("a:b:x:y");
  });

  it("reads every spliced-in section back as a string (the hono expandIPv6 shape)", () => {
    expect(String(exports.ipv6Shape!())).toBe("0001:0002:7f00:0001");
  });

  it("expands an array-literal spread in push and Math.max too", () => {
    expect(exports.pushLength!()).toBe(3);
    expect(String(exports.pushJoin!())).toBe("a:x:y");
    expect(exports.maxSpread!()).toBe(5);
  });
});
