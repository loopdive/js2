// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5317 r4 step 2 — `end` is absent only when it is `undefined`.
 *
 * `__ta_dyn_fill` and `__ta_dyn_copywithin` decided "the `end` argument is
 * absent, use len" with `__nullish_to_null` followed by `ref.is_null`, which
 * answers TRUE for `null` as well. §23.2.3.8 step 5 / §23.2.3.6 step 8 only
 * treat `undefined` that way; `null` is ToIntegerOrInfinity'd to 0, so
 * `ta.fill(1, 0, null)` must fill NOTHING and `ta.copyWithin(0, 2, null)` must
 * copy nothing. Measured on base: both wrote as if `end` were `len`.
 *
 * The pins keep the other side of the rule too — an EXPLICIT `undefined` end,
 * and an omitted end, still mean `len`, which is what `__nullish_to_null` was
 * added for in the first place.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262_ROOT = join(REPO_ROOT, "test262");
const CORPUS_TIMEOUT = 180_000;
const RUNNER_TIMEOUT = 120_000;

const EXACT_ROWS = ["built-ins/TypedArray/prototype/fill/coerced-indexes.js"] as const;

const HAVE_TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));

async function runStandalone(source: string, fileName: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
    target: "standalone" as const,
  });
  expect(
    result.success,
    `compile failed:\n${result.errors?.map((error) => `L${error.line}: ${error.message}`).join("\n") ?? ""}`,
  ).toBe(true);
  if (!result.success) return -1;
  const module = await WebAssembly.compile(result.binary);
  expect(
    WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`),
    "standalone controls must emit zero imports",
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

const FILL_SOURCE = `
  function identity(v: any): any { return v; }

  export function test(): number {
    // §23.2.3.8: null start/end coerce to 0; undefined start is 0, undefined end is len.
    const a: any = new Float64Array(identity([0, 0]));
    a.fill(1, 0, identity(null));
    if (a[0] !== 0 || a[1] !== 0) return 1;

    const b: any = new Float64Array(identity([0, 0]));
    b.fill(1, identity(null));
    if (b[0] !== 1 || b[1] !== 1) return 2;

    const c: any = new Float64Array(identity([0, 0]));
    c.fill(1, 0, identity(undefined));
    if (c[0] !== 1 || c[1] !== 1) return 3;

    const d: any = new Float64Array(identity([0, 0]));
    d.fill(1, identity(undefined));
    if (d[0] !== 1 || d[1] !== 1) return 4;

    const e: any = new Float64Array(identity([0, 0]));
    e.fill(1, identity(true));
    if (e[0] !== 0 || e[1] !== 1) return 5;

    const f: any = new Float64Array(identity([0, 0]));
    f.fill(1, 0, identity(true));
    if (f[0] !== 1 || f[1] !== 0) return 6;

    const g: any = new Float64Array(identity([0, 0]));
    g.fill(1, identity(NaN));
    if (g[0] !== 1 || g[1] !== 1) return 7;

    // The observable coercion order is value -> start -> end.
    const log: any = identity([]);
    const v: any = { valueOf: function(): number { log.push("value"); return 1; } };
    const s: any = { valueOf: function(): number { log.push("start"); return 0; } };
    const t: any = { valueOf: function(): number { log.push("end"); return 2; } };
    const h: any = new Float64Array(identity([0, 0]));
    h.fill(v, s, t);
    if (log.join(",") !== "value,start,end") return 8;
    if (h[0] !== 1 || h[1] !== 1) return 9;
    return 0;
  }
`;

const COPYWITHIN_SOURCE = `
  function identity(v: any): any { return v; }

  export function test(): number {
    const a: any = new Float64Array(identity([1, 2, 3, 4]));
    a.copyWithin(0, 2, identity(null));
    if (a[0] !== 1 || a[1] !== 2 || a[2] !== 3 || a[3] !== 4) return 1;

    const b: any = new Float64Array(identity([1, 2, 3, 4]));
    b.copyWithin(0, 2, identity(undefined));
    if (b[0] !== 3 || b[1] !== 4 || b[2] !== 3 || b[3] !== 4) return 2;

    const c: any = new Float64Array(identity([1, 2, 3, 4]));
    c.copyWithin(0, 2);
    if (c[0] !== 3 || c[1] !== 4 || c[2] !== 3 || c[3] !== 4) return 3;

    // The observable coercion order is target -> start -> end.
    const log: any = identity([]);
    const t: any = { valueOf: function(): number { log.push("t"); return 0; } };
    const s: any = { valueOf: function(): number { log.push("s"); return 2; } };
    const e: any = { valueOf: function(): number { log.push("e"); return 4; } };
    const d: any = new Float64Array(identity([1, 2, 3, 4]));
    d.copyWithin(t, s, e);
    if (log.join(",") !== "t,s,e") return 4;
    if (d[0] !== 3 || d[1] !== 4) return 5;
    return 0;
  }
`;

/**
 * Review round 1 (2026-09-05), F3 — the STATIC lane.
 *
 * The two controls above go through the DYN-view helpers (`__ta_dyn_fill` /
 * `__ta_dyn_copywithin`), which see the raw `externref` end and can therefore
 * ask the runtime's §7.1 "is undefined" predicate. A receiver the compiler
 * types concretely — `const a = new Uint8Array([…])`, or a plain array literal
 * — takes a DIFFERENT lane (`compileArrayFill` / `compileArrayCopyWithin`,
 * src/codegen/array-methods.ts ~L9199 and ~L9790), which coerces the end
 * argument straight to `f64` and therefore recognises "absent" only
 * SYNTACTICALLY: the literal identifier `undefined`, or a `void` expression.
 * Its own comment says so ("once coerced to f64 we cannot distinguish them
 * from `NaN`").
 *
 * Measured 2026-09-05 on this tree AND on the git-archive base f9bf876899 —
 * byte-identical modules, so everything below is pre-existing and untouched by
 * the r4 step-2 fix. Signature is the four element values after the call;
 * `9999` = filled, `1234` = untouched (node's answers in brackets):
 *
 *   correct   typed receiver, LITERAL end      undefined 9999 · null 1234 ·
 *             omitted 9999 · NaN 1234 · 2 · -0 · "2" · {valueOf} — and the
 *             `Array.prototype` and `copyWithin` twins
 *   WRONG     typed receiver, DYNAMIC end      `const e: any = undefined;
 *             a.fill(9,0,e)` ⇒ 1234 [node 9999]. The f64 coercion cannot tell
 *             `undefined` from `NaN`, so it takes the NaN arm (⇒ 0).
 *   WRONG     `any`-typed receiver             `const a: any = new
 *             Uint8Array([…]); a.fill(9,0,undefined)` ⇒ 1234 [9999], and even
 *             the two-argument `a.fill(9,0)` ⇒ 1234 [9999] — a third lane
 *             again, and one where an OMITTED end is lost too.
 *
 * Only the CORRECT rows are pinned here — pinning a divergence would entrench
 * it. The two divergences are recorded in the issue's r4 section instead;
 * both need a re-shape (test the argument before the f64 coercion / carry the
 * real argc through the dynamic dispatch), which is a different mechanism from
 * the one-line dyn-helper predicate swap and out of scope for this round.
 *
 * Standalone only: on wasi, reading a typed-array element inside an
 * `any`-typed helper reads back `NaN` — a separate pre-existing wasi defect
 * that would make these pins fail for an unrelated reason.
 */
const STATIC_LANE_SOURCE = `
  export function test(): number {
    const a = new Uint8Array([1, 2, 3, 4]);
    a.fill(9, 0, undefined);
    if (a[0] !== 9 || a[3] !== 9) return 1;

    const b = new Uint8Array([1, 2, 3, 4]);
    b.fill(9, 0, null as any);
    if (b[0] !== 1 || b[3] !== 4) return 2;

    const c = new Uint8Array([1, 2, 3, 4]);
    c.fill(9, 0);
    if (c[0] !== 9 || c[3] !== 9) return 3;

    const d = new Uint8Array([1, 2, 3, 4]);
    d.fill(9, 0, 2);
    if (d[0] !== 9 || d[1] !== 9 || d[2] !== 3 || d[3] !== 4) return 4;

    const e = new Uint8Array([1, 2, 3, 4]);
    e.fill(9, 0, NaN);
    if (e[0] !== 1 || e[3] !== 4) return 5;

    const f = [1, 2, 3, 4];
    f.fill(9, 0, undefined);
    if (f[0] !== 9 || f[3] !== 9) return 6;

    const g = [1, 2, 3, 4];
    g.fill(9, 0, null as any);
    if (g[0] !== 1 || g[3] !== 4) return 7;

    const h = new Uint8Array([1, 2, 3, 4, 5, 6]);
    h.copyWithin(0, 3, undefined);
    if (h[0] !== 4 || h[1] !== 5 || h[2] !== 6) return 8;

    const i = new Uint8Array([1, 2, 3, 4, 5, 6]);
    i.copyWithin(0, 3, null as any);
    if (i[0] !== 1 || i[1] !== 2) return 9;

    const j = new Uint8Array([1, 2, 3, 4, 5, 6]);
    j.copyWithin(0, 3);
    if (j[0] !== 4 || j[1] !== 5 || j[2] !== 6) return 10;

    const k = [1, 2, 3, 4, 5, 6];
    k.copyWithin(0, 3, undefined);
    if (k[0] !== 4 || k[1] !== 5 || k[2] !== 6) return 11;
    return 0;
  }
`;

describe("#5317 r4 — TypedArray fill/copyWithin treat only `undefined` as an absent end", () => {
  it("standalone control: fill", { timeout: CORPUS_TIMEOUT }, async () => {
    expect(await runStandalone(FILL_SOURCE, "issue-5317-r4-fill.ts")).toBe(0);
  });

  it("standalone control: static fill/copyWithin lane", { timeout: CORPUS_TIMEOUT }, async () => {
    expect(await runStandalone(STATIC_LANE_SOURCE, "issue-5317-r4-static-end.ts")).toBe(0);
  });

  it("standalone control: copyWithin", { timeout: CORPUS_TIMEOUT }, async () => {
    expect(await runStandalone(COPYWITHIN_SOURCE, "issue-5317-r4-copywithin.ts")).toBe(0);
  });

  for (const relativePath of EXACT_ROWS) {
    const filePath = join(TEST262_ROOT, "test", relativePath);
    const exactIt = HAVE_TEST262 && existsSync(filePath) ? it : it.skip;

    exactIt(`standalone exact Test262 row: ${relativePath}`, { timeout: CORPUS_TIMEOUT }, async () => {
      try {
        const result = await runTest262File(filePath, "issue-5317-standalone", RUNNER_TIMEOUT, "standalone");
        expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
      } finally {
        restoreHostBuiltins();
      }
    });
  }
});
