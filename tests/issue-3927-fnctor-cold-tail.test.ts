// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3927) Hot/cold split of the widened fnctor struct.
 *
 * The properties pinned here are the ones whose violation would be SILENT.
 * The split's payoff (bytes per parse) and its correctness on a real program
 * are both measured against the standalone acorn lane — 90 s of compile per
 * data point, far outside a unit test — and recorded in
 * `plan/issues/3927-fnctor-shape-splitting.md`. What a test can hold is the
 * boundary: that the feature is genuinely OFF by default, that a malformed
 * flag value cannot half-enable it, and that the field ranking is a total
 * order (a ranking that reshuffles between two compiles of the same source
 * would make the emitted layout non-deterministic, which is the one failure
 * this design cannot tolerate — the `$cold` slot's type index is baked into
 * the main struct in an earlier pass than the split itself).
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { compile } from "../src/index.js";
import { coldTailHotFieldLimit, coldTailStructName, selectColdFieldNames } from "../src/codegen/fnctor-cold-tail.js";

const FIXTURE = `
function Node() { this.type = "?"; this.start = 0; }
function Parser() { this.pos = 0; }
var pp = Parser.prototype;
pp.startNode = function () { return new Node(); };
pp.alpha = function () { var node = this.startNode(); node.alpha = 1; return node; };
pp.beta = function () { var node = this.startNode(); node.beta = 2; return node; };
export function main() {
  var p = new Parser();
  return (p.alpha().alpha | 0) + (p.beta().beta | 0);
}`;

async function buildSha(hotFields: string | undefined): Promise<string> {
  const saved = process.env.JS2WASM_FNCTOR_HOT_FIELDS;
  // `= undefined` coerces to the STRING "undefined", which the flag reader
  // would parse as NaN — only `delete` truly unsets an env var.
  // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
  if (hotFields === undefined) delete process.env.JS2WASM_FNCTOR_HOT_FIELDS;
  else process.env.JS2WASM_FNCTOR_HOT_FIELDS = hotFields;
  try {
    const result = await compile(FIXTURE, {
      fileName: "t.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
      optimize: 0,
    });
    if (!result.success) throw new Error(result.errors.map((e) => String(e.message ?? e)).join("; "));
    return createHash("sha256").update(result.binary).digest("hex");
  } finally {
    // biome-ignore lint/performance/noDelete: see above — env vars need delete
    if (saved === undefined) delete process.env.JS2WASM_FNCTOR_HOT_FIELDS;
    else process.env.JS2WASM_FNCTOR_HOT_FIELDS = saved;
  }
}

describe("#3927 — fnctor hot/cold tail split", () => {
  it("is OFF by default, and a malformed flag value cannot half-enable it", async () => {
    const off = await buildSha(undefined);
    expect(await buildSha(undefined)).toBe(off);
    // A non-integer, a negative, and an empty value must all read as OFF —
    // NOT as `NaN` slipping through into a `slice(NaN)` that silently moves
    // EVERY eligible field to the tail.
    for (const bad of ["", "abc", "-1", "2.5"]) {
      expect(await buildSha(bad)).toBe(off);
    }
  });

  it("reads a well-formed limit, including the meaningful zero", () => {
    const saved = process.env.JS2WASM_FNCTOR_HOT_FIELDS;
    try {
      process.env.JS2WASM_FNCTOR_HOT_FIELDS = "0";
      expect(coldTailHotFieldLimit()).toBe(0);
      process.env.JS2WASM_FNCTOR_HOT_FIELDS = "24";
      expect(coldTailHotFieldLimit()).toBe(24);
    } finally {
      // biome-ignore lint/performance/noDelete: see above — env vars need delete
      if (saved === undefined) delete process.env.JS2WASM_FNCTOR_HOT_FIELDS;
      else process.env.JS2WASM_FNCTOR_HOT_FIELDS = saved;
    }
  });

  it("ranks fields by a TOTAL order — equal write-site counts break by name", () => {
    const counts = new Map([
      ["body", 40],
      ["left", 3],
      ["right", 3],
      ["tail", 1],
      ["regex", 1],
    ]);
    // Input permutation must not change the outcome: the tie-break is the name,
    // not the enumeration order of the eligible list.
    const a = selectColdFieldNames(["body", "left", "right", "tail", "regex"], counts, 2);
    const b = selectColdFieldNames(["regex", "tail", "right", "left", "body"], counts, 2);
    expect([...a].sort()).toEqual([...b].sort());
    expect([...a].sort()).toEqual(["regex", "right", "tail"]);
  });

  it("derives the tail struct name from the owner, so the two never collide", () => {
    expect(coldTailStructName("__fnctor_Node")).toBe("__fnctor_Node__cold");
  });
});
