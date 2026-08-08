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
import type { CodegenContext } from "../src/codegen/context/types.js";
import {
  COLD_TAIL_DEFAULT_HOT_FIELDS,
  COLD_TAIL_FIELD,
  coldTailHotFieldLimit,
  coldTailStructName,
  findColdStructsForField,
  selectColdFieldNames,
} from "../src/codegen/fnctor-cold-tail.js";

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

async function buildSha(
  hotFields: string | undefined,
  target: "standalone" | "js-host" = "standalone",
): Promise<string> {
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
      target,
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
  it("a malformed flag value falls back to the DEFAULT, never half-enabling the split", async () => {
    const byDefault = await buildSha(undefined);
    expect(await buildSha(undefined)).toBe(byDefault);
    expect(await buildSha(String(COLD_TAIL_DEFAULT_HOT_FIELDS))).toBe(byDefault);
    // A non-integer, a negative and an empty value must all read as the
    // default — NOT as `NaN`/`0` slipping through into a `slice()` that
    // silently moves EVERY eligible field to the tail. `Number("")` is `0`.
    for (const bad of ["", "abc", "-1", "2.5"]) {
      expect(await buildSha(bad)).toBe(byDefault);
    }
    // `off` is the one value that disables it, and it must differ from the
    // default — otherwise the default flip did not take.
    expect(await buildSha("off")).not.toBe(byDefault);
  });

  it("reads a well-formed limit, including the meaningful zero and `off`", () => {
    const saved = process.env.JS2WASM_FNCTOR_HOT_FIELDS;
    try {
      process.env.JS2WASM_FNCTOR_HOT_FIELDS = "0";
      expect(coldTailHotFieldLimit()).toBe(0);
      process.env.JS2WASM_FNCTOR_HOT_FIELDS = "24";
      expect(coldTailHotFieldLimit()).toBe(24);
      process.env.JS2WASM_FNCTOR_HOT_FIELDS = "off";
      expect(coldTailHotFieldLimit()).toBeUndefined();
      process.env.JS2WASM_FNCTOR_HOT_FIELDS = "OFF";
      expect(coldTailHotFieldLimit()).toBeUndefined();
      // biome-ignore lint/performance/noDelete: env vars need delete to unset
      delete process.env.JS2WASM_FNCTOR_HOT_FIELDS;
      expect(coldTailHotFieldLimit()).toBe(COLD_TAIL_DEFAULT_HOT_FIELDS);
    } finally {
      // biome-ignore lint/performance/noDelete: see above — env vars need delete
      if (saved === undefined) delete process.env.JS2WASM_FNCTOR_HOT_FIELDS;
      else process.env.JS2WASM_FNCTOR_HOT_FIELDS = saved;
    }
  });

  /**
   * The split is standalone-only. Before the default flip that held only by
   * an argument about another pass ("flow-grown fields only happen in
   * standalone"), checked nowhere; a shipped default needs the gate itself.
   */
  it("never splits a JS-host build, whatever the flag says", async () => {
    const hostOff = await buildSha("off", "js-host");
    for (const on of [undefined, "0", "20"]) {
      expect(await buildSha(on, "js-host")).toBe(hostOff);
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

  /**
   * (2026-08-07) Regression guard for the §4 `generator` defect.
   *
   * `findAlternateStructsForField` deliberately hides `$…__cold` tails from
   * every consumer that keys arms on `ref.test`. One consumer does not want
   * arms — the Phase-3 (#1269) consumer-side narrowing in
   * `finalizeStructAndDynamicMemberGet` wants to know whether EVERY carrier of
   * the property is the same scalar kind, so it can strip the boxing off an
   * `any`-receiver read. Hiding the tail from THAT question made the narrowing
   * fire on a property whose only visible carrier was a boolean-branded `i32`
   * (`TokContext.generator`), and the correct boxed value the dispatcher
   * returned was then dragged through `__unbox_number` — every
   * `node.generator` read on acorn's AST answered a constant `false`.
   *
   * The narrowing therefore consults `findColdStructsForField`. What this pins
   * is the property that makes that veto SUFFICIENT: a tail location is
   * reported, and it reports its slot as `externref`, which can never form a
   * scalar-kind singleton with a visible scalar candidate.
   */
  it("reports cold-tail locations, as externref, so the read narrowing can veto on them", () => {
    const ctx = {
      structFields: new Map([
        [
          "__fnctor_Node",
          [
            { name: "type", type: { kind: "externref" }, mutable: true },
            { name: COLD_TAIL_FIELD, type: { kind: "ref_null", typeIdx: 21 }, mutable: true },
          ],
        ],
        ["__fnctor_Node__cold", [{ name: "generator", type: { kind: "externref" }, mutable: true }]],
        ["__fnctor_TokContext", [{ name: "generator", type: { kind: "i32", boolean: true }, mutable: true }]],
      ]),
      structMap: new Map([
        ["__fnctor_Node", 20],
        ["__fnctor_Node__cold", 21],
        ["__fnctor_TokContext", 22],
      ]),
      typeIdxToStructName: new Map([
        [20, "__fnctor_Node"],
        [21, "__fnctor_Node__cold"],
        [22, "__fnctor_TokContext"],
      ]),
      fnctorColdTailStructName: new Map([["__fnctor_Node", "__fnctor_Node__cold"]]),
    } as unknown as CodegenContext;

    const locs = findColdStructsForField(ctx, "generator");
    expect(locs).toHaveLength(1);
    expect(locs[0]!.mainStructTypeIdx).toBe(20);
    expect(locs[0]!.coldStructTypeIdx).toBe(21);
    // The load-bearing bit: an `externref` here can never collapse into a
    // scalar-kind singleton alongside `TokContext`'s branded `i32`.
    expect(locs[0]!.fieldType.kind).toBe("externref");

    // And with nothing split (the default), the veto is a strict no-op.
    const unsplit = { ...ctx, fnctorColdTailStructName: undefined } as unknown as CodegenContext;
    expect(findColdStructsForField(unsplit, "generator")).toEqual([]);
  });
});
