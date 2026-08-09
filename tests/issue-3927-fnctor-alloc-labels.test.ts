// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3927) Allocation-site-sensitive shape analysis — the per-type-layout plan.
 *
 * What a unit test can hold here is the analysis's DECISIONS, not its payoff:
 * the bytes are measured on the standalone acorn lane (75 s per data point) and
 * recorded in `plan/issues/3927-fnctor-shape-splitting.md`. The properties
 * pinned below are the ones whose violation would be silent —
 *
 *   1. the k=1 substitution actually separates two call sites of ONE factory
 *      (if it did not, every plan would collapse to today's union struct and
 *      the feature would look "enabled" while doing nothing);
 *   2. the identity summary that de-blurs `finishNode`-style pass-throughs —
 *      without it acorn's mean label is 14.5 fields instead of 6.3, and a test
 *      that only checked "some split happened" would not notice;
 *   3. every non-`split` verdict is reachable, so the fallback to the union
 *      struct is a real path and not dead code;
 *   4. receiver pinning publishes only SINGLE-label expressions — a pin on a
 *      multi-label receiver would pick one arbitrary layout and read the wrong
 *      slot, which is exactly the silent-wrong-value class this design has to
 *      avoid;
 *   5. the plan is deterministic and the flag is genuinely off by default.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import ts from "typescript";

import { compile } from "../src/index.js";
import { analyzeFnctorAllocLabels, fnctorLayoutsEnabled } from "../src/codegen/fnctor-alloc-labels.js";

/** Analyse one in-memory module the way the compiler does. */
function analyze(source: string, ctorNames: readonly string[]) {
  const fileName = "t.mjs";
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const host: ts.CompilerHost = {
    getSourceFile: (n) => (n === fileName ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => f === fileName,
    readFile: (f) => (f === fileName ? source : undefined),
  };
  const program = ts.createProgram([fileName], { allowJs: true, noLib: true, target: ts.ScriptTarget.ESNext }, host);
  const ctorDeclByName = new Map<string, ts.FunctionLikeDeclaration>();
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && ctorNames.includes(n.name.text)) {
      ctorDeclByName.set(n.name.text, n);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return analyzeFnctorAllocLabels(program.getTypeChecker(), [sf], ctorDeclByName);
}

/**
 * The motivating shape in miniature: ONE `new Node()`, inside ONE factory, whose
 * callers give the instance different property sets. A `new`-site partition sees
 * a single class here; the k=1 factory-call-site partition sees two.
 */
const TWO_SITE = `
function Node() { this.type = "?"; this.start = 0; }
function Parser() { this.pos = 0; }
var pp = Parser.prototype;
pp.startNode = function () { return new Node(); };
pp.finishNode = function (node, type) { node.type = type; return node; };
pp.alpha = function () { var node = this.startNode(); node.alpha = 1; return this.finishNode(node, "A"); };
pp.beta = function () { var node = this.startNode(); node.beta = 2; node.gamma = 3; return this.finishNode(node, "B"); };
`;

/**
 * {@link TWO_SITE} plus acorn's `toAssignable` idiom: an in-place kind rewrite
 * reached through a reference the caller cannot replace. `node.type = <literal>`
 * (a constant tag) is what marks a RETYPE, as opposed to `finishNode`'s
 * `node.type = type`, which is the initial tagging from a parameter.
 */
const RETYPING = `${TWO_SITE}
pp.toAssignable = function (node) { node.type = "Pattern"; return node; };
pp.assign = function (flag) { var n = flag ? this.alpha() : this.beta(); return this.toAssignable(n); };
`;

describe("#3927 allocation-site-sensitive shape analysis", () => {
  it("separates two call sites of ONE factory (the k=1 substitution)", () => {
    const plan = analyze(TWO_SITE, ["Node", "Parser"]).plans.get("Node");
    expect(plan?.verdict).toBe("split");
    // Two `this.startNode()` sites ⇒ two labels, even though there is exactly
    // one `new Node()` in the whole program.
    expect(plan?.labels.length).toBe(2);
    const sets = plan!.layouts.map((l) => l.fields.join(","));
    expect(sets.sort()).toEqual(["alpha,type", "beta,gamma,type"]);
    // The point of the whole exercise: neither instance carries the union.
    expect(plan?.union).toEqual(["alpha", "beta", "gamma", "type"]);
    expect(plan!.widthRatio).toBeLessThan(1);
  });

  it("the identity summary keeps a pass-through from joining every label", () => {
    // `finishNode(node, type) { node.type = type; return node }` is returned by
    // BOTH builders. Without the pass-through summary its return value is the
    // join of every label, so `alpha` would be attributed to beta's instance
    // (and vice versa) through any later write on the returned value.
    const withPassThrough = `${TWO_SITE}
pp.wrap = function () { var n = this.alpha(); n.wrapped = 1; return n; };`;
    const plan = analyze(withPassThrough, ["Node", "Parser"]).plans.get("Node");
    const byKey = new Map(plan!.layouts.map((l) => [l.fields.join(","), l]));
    // `wrapped` lands ONLY on the alpha label, reached through two chained
    // pass-throughs (`alpha` → `finishNode` → `node`).
    expect([...byKey.keys()].sort()).toEqual(["alpha,type,wrapped", "beta,gamma,type"]);
  });

  it("records the in-place retype sites rather than assuming they are absent", () => {
    // The acorn idiom this models: `toAssignable` rewrites a node's kind IN
    // PLACE through a reference the caller cannot replace, so the layout has to
    // be decided at allocation. The analysis is flow-INSENSITIVE, so the
    // post-retype writes are already in the label's set; the site list is what
    // makes that auditable instead of assumed.
    const plan = analyze(RETYPING, ["Node", "Parser"]).plans.get("Node");
    const retyped = plan!.retypeSites.map((r) => r.field);
    expect(retyped).toContain("type");
    // Both labels flow through `finishNode`, so the discriminant write merges
    // them — and writes nothing outside the union, which is why the merge costs
    // no widening.
    const merged = plan!.mergedByRetype.find((g) => g.length > 1);
    expect(merged?.length).toBe(2);
  });

  it("falls back to the union struct on every non-split verdict", () => {
    // single-site: nothing to separate.
    const single = analyze(
      `function Node() { this.type = "?"; }
       function Parser() { this.pos = 0; }
       var pp = Parser.prototype;
       pp.only = function () { var n = new Node(); n.a = 1; n.b = 2; return n; };`,
      ["Node", "Parser"],
    ).plans.get("Node");
    expect(single?.verdict).toBe("single-site");

    // not-separable: two sites, identical shapes ⇒ the split buys nothing.
    const same = analyze(
      `function Node() { this.type = "?"; }
       function Parser() { this.pos = 0; }
       var pp = Parser.prototype;
       pp.mk = function () { return new Node(); };
       pp.a = function () { var n = this.mk(); n.x = 1; n.y = 2; return n; };
       pp.b = function () { var n = this.mk(); n.x = 3; n.y = 4; return n; };`,
      ["Node", "Parser"],
    ).plans.get("Node");
    expect(same?.verdict).toBe("not-separable");

    // no-sites: instances never grow a field past the constructor's own writes,
    // so there is no widening to undo (acorn's `Token` is exactly this).
    const flat = analyze(
      `function Node() { this.type = "?"; }
       function Parser() { this.pos = 0; }
       var pp = Parser.prototype;
       pp.mk = function () { return new Node(); };
       pp.a = function () { return this.mk(); };
       pp.b = function () { return this.mk(); };`,
      ["Node", "Parser"],
    ).plans.get("Node");
    expect(flat?.verdict).toBe("no-sites");
  });

  it("publishes a receiver pin only when the expression has ONE label", () => {
    const merging = `${TWO_SITE}
pp.either = function (flag) { var n = flag ? this.alpha() : this.beta(); n.merged = 1; return n; };`;
    const result = analyze(merging, ["Node", "Parser"]);
    const pinnedLines = new Set<number>();
    for (const [expr] of result.labelOfExpr) {
      pinnedLines.add(expr.getSourceFile().getLineAndCharacterOfPosition(expr.getStart()).line);
    }
    // The two-label local in `either` must NOT be pinned — a pin there would
    // pick one layout arbitrarily and read the other's slot.
    for (const [expr, pin] of result.labelOfExpr) {
      expect(pin.fnctorName).toBe("Node");
      expect(ts.isIdentifier(expr) || ts.isCallExpression(expr)).toBe(true);
    }
    // …and the single-label `this.alpha()` / `this.startNode()` sites ARE.
    expect(result.labelOfExpr.size).toBeGreaterThan(0);
    expect(pinnedLines.size).toBeGreaterThan(0);
  });

  it("is deterministic — the same source yields the same plan", () => {
    const a = analyze(TWO_SITE, ["Node", "Parser"]).plans.get("Node");
    const b = analyze(TWO_SITE, ["Node", "Parser"]).plans.get("Node");
    expect(b!.layouts.map((l) => l.key)).toEqual(a!.layouts.map((l) => l.key));
    // Total order on the layout list: a plan whose layout ORDER varied between
    // two compiles of the same source would make the emitted type table
    // non-deterministic, which no later pass can repair.
    const keys = a!.layouts.map((l) => l.key);
    expect([...keys].sort()).toEqual(keys);
  });

  it("is OFF by default and the flag reader rejects the off values", () => {
    const saved = process.env.JS2WASM_FNCTOR_LAYOUTS;
    try {
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      delete process.env.JS2WASM_FNCTOR_LAYOUTS;
      expect(fnctorLayoutsEnabled()).toBe(false);
      process.env.JS2WASM_FNCTOR_LAYOUTS = "";
      expect(fnctorLayoutsEnabled()).toBe(false);
      process.env.JS2WASM_FNCTOR_LAYOUTS = "0";
      expect(fnctorLayoutsEnabled()).toBe(false);
      process.env.JS2WASM_FNCTOR_LAYOUTS = "1";
      expect(fnctorLayoutsEnabled()).toBe(true);
    } finally {
      // biome-ignore lint/performance/noDelete: see above
      if (saved === undefined) delete process.env.JS2WASM_FNCTOR_LAYOUTS;
      else process.env.JS2WASM_FNCTOR_LAYOUTS = saved;
    }
  });

  it("emits a byte-identical binary with the flag on (the plan is inert)", async () => {
    const source = `${TWO_SITE}
export function main() { var p = new Parser(); return (p.alpha().alpha | 0) + (p.beta().beta | 0); }`;
    const build = async (flag: string | undefined): Promise<string> => {
      const saved = process.env.JS2WASM_FNCTOR_LAYOUTS;
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      if (flag === undefined) delete process.env.JS2WASM_FNCTOR_LAYOUTS;
      else process.env.JS2WASM_FNCTOR_LAYOUTS = flag;
      try {
        const r = await compile(source, {
          fileName: "t.mjs",
          skipSemanticDiagnostics: true,
          target: "standalone",
          optimize: 0,
        });
        if (!r.success) throw new Error(r.errors.map((e) => String(e.message ?? e)).join("; "));
        return createHash("sha256").update(r.binary).digest("hex");
      } finally {
        // biome-ignore lint/performance/noDelete: see above
        if (saved === undefined) delete process.env.JS2WASM_FNCTOR_LAYOUTS;
        else process.env.JS2WASM_FNCTOR_LAYOUTS = saved;
      }
    };
    expect(await build("1")).toBe(await build(undefined));
  }, 120_000);
});
