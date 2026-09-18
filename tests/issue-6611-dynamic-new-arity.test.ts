// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6611 (#5383 S24) — `new <runtime ctor VALUE>(…)` with MORE than eight
// arguments, under `--target standalone`.
//
// WHY THIS REDUCTION EXISTS. The dispatched bucket was nine test262 rows
// reporting `TypeError: expected a string, not null`. That message is the
// `@js-temporal/polyfill`'s OWN guard, several frames downstream: with ten
// arguments `new Temporal.Duration(…)` evaluated to `null`, and the polyfill
// carried the null into `ToTemporalDuration`, whose string branch calls
// `RequireString(null)`. `Temporal.Duration` takes TEN parameters and
// `Temporal.PlainDateTime` takes nine, so the corpus's most ordinary spelling
// sat one argument past a ceiling.
//
// `tryCompileNativeConstructFromValue` declined above
// `MAX_NATIVE_CONSTRUCT_ARITY` (8). That constant is not a property of the
// construct driver — it is the range over which `closure-exports.ts` emits the
// `__call_fn_method_<N>` family, used only by the driver's ordinary
// module-local-closure tail. Declining is not a graceful fallback: for a callee
// the compiling module does not OWN there are no candidate classes for
// `emitDynamicNewFallback` to tag-dispatch on, so the site lands on the
// pre-existing `ref.null.extern` no-match base — which is emitted INSTEAD of
// the argument evaluation, so the arguments are dropped too.
//
// WHICH ARM HAS TEETH, and the two asymmetries that matter.
//
//   1. OWNERSHIP. The defect needs a callee the module does not own, so it is
//      the LINKED-pair `it` that fails on base. In a SINGLE module every class
//      is a candidate for the tag-dispatch fallback, so the same call site was
//      already correct at any arity — that is exactly why no single-module
//      probe ever found this, and why the single-module `it`s below are
//      CONTROLS rather than witnesses. They are asserted anyway: the change
//      widens an admission ceiling those sites also pass through, so "the
//      single-module answer did not move" is a real claim.
//
//   2. SPELLING — and this one is a trap worth stating, because the obvious
//      reduction does NOT reproduce. Across the link only the MEMBER-ACCESS
//      callee `new NS.wide(…)` is this defect. Binding the class first
//      (`const C = NS.wide; new C(…)`) answers null on BOTH trees — and it
//      answers null at arity EIGHT too (`.tmp/s24/probe6489.mts`), so it is
//      arity-independent and therefore a different, pre-existing mechanism, not
//      this one. It is pinned below rather than left out, because a reduction
//      that fails identically before and after would otherwise read as this
//      defect surviving. `new Temporal.Duration(…)` — the real corpus spelling —
//      is the member form.
//
// Every expectation below was measured on BOTH trees on this branch, by
// file-copy revert of `src/codegen/native-construct.ts` and
// `src/codegen/expressions/new-super.ts` (`.tmp/s24base/` vs `.tmp/s24/*.new.ts`).
// The base-tree answers are recorded inline.
//
// Host-free: `hostBridge: "off"` plus an EMPTY import object, so a leaked host
// import fails the test instead of being papered over. The linked probes answer
// NUMBERS — a standalone module's string is a WasmGC array the host cannot
// decode, so every string comparison happens INSIDE the module.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

const SINGLE = {
  ...STANDALONE,
  fileName: "/p.ts",
  allowJs: true,
  skipSemanticDiagnostics: true,
};

/**
 * Compile `expression` standalone, instantiate with an EMPTY import object, and
 * read back the string it produced one char code at a time.
 */
async function runStandaloneString(expression: string): Promise<string> {
  const source = `let __s = "";
    export function prepare() { try { __s = "" + (${expression}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
    export function at(i) { return __s.charCodeAt(i); }`;
  const result = await compile(source, SINGLE);
  if (!result.success) throw new Error(`compile failed: ${result.errors?.[0]?.message}`);
  const module = await WebAssembly.compile(result.binary as Uint8Array);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

/**
 * The provider half. `Wide` has the ten-slot shape `Temporal.Duration` has;
 * `Narrow` is the arity-8 control, the ceiling that did NOT move.
 */
const PROVIDER = `
  export class Wide {
    constructor(a, b, c, d, e, f, g, h, i, j) {
      this.sum = a + b + c + d + e + f + g + h + i + j;
      this.first = a;
      this.last = j;
    }
  }
  export class Narrow {
    constructor(a, b, c, d, e, f, g, h) { this.sum = a + b + c + d + e + f + g + h; }
  }
  export const NS = Object.freeze({
    __proto__: null,
    wide: Wide,
    narrow: Narrow,
  });`;

async function linkedPair(provider: string, consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6611-"));
  const packageRoot = join(root, "node_modules", "ns6489");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6489", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6489";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6489")!;
  const field = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]: `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n${consumer}`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

const CONSUMER = `
  // -1 = threw. -2 = the \`new\` produced null, which is the base-tree answer
  // for every above-eight arity: the site emitted \`ref.null.extern\`.
  export function wideTenArgs() {
    try {
      const o = new NS.wide(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
      return o === null ? -2 : o.sum;
    } catch (e) { return -1; }
  }
  export function wideNineArgs() {
    try {
      const o = new NS.wide(1, 2, 3, 4, 5, 6, 7, 8, 9);
      return o === null ? -2 : o.first;
    } catch (e) { return -1; }
  }
  // The clause no reading of the downstream symptom would predict: the
  // no-match base was emitted INSTEAD of the argument evaluation, so the
  // argument expressions never ran at all. Counts how many of the ten did.
  export function evaluatesItsArguments() {
    try {
      let marks = 0;
      const t = function (v) { marks = marks + 1; return v; };
      new NS.wide(t(1), t(2), t(3), t(4), t(5), t(6), t(7), t(8), t(9), t(10));
      return marks;
    } catch (e) { return -1; }
  }
  // …and in order, left to right. Encodes the order as a base-11 fingerprint
  // so a permutation cannot read as a pass.
  export function evaluatesLeftToRight() {
    try {
      let seen = 0;
      const t = function (v) { seen = seen * 11 + v; return v; };
      new NS.wide(t(1), t(2), t(3), t(4), t(5), t(6), t(7), t(8), t(9), t(10));
      return seen;
    } catch (e) { return -1; }
  }
  // CONTROL: arity 8 is the ceiling that did NOT move. A driver at or below
  // \`MAX_NATIVE_CONSTRUCT_ARITY\` keeps the \`__call_fn_method_<N>\` tail.
  export function narrowEightArgs() {
    try {
      const o = new NS.narrow(1, 2, 3, 4, 5, 6, 7, 8);
      return o === null ? -2 : o.sum;
    } catch (e) { return -1; }
  }
  // PINNED RESIDUAL: the class bound to a local FIRST. Answers null on both
  // trees, and at arity 8 as well, so it is not this defect.
  export function boundIdentifierTenArgs() {
    try {
      const C = NS.wide;
      const o = new C(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
      return o === null ? -2 : o.sum;
    } catch (e) { return -1; }
  }
  export function boundIdentifierEightArgs() {
    try {
      const C = NS.narrow;
      const o = new C(1, 2, 3, 4, 5, 6, 7, 8);
      return o === null ? -2 : o.sum;
    } catch (e) { return -1; }
  }
  // …and it DOES evaluate its arguments, which is how we know it is a
  // different mechanism from this one rather than the same null.
  export function boundIdentifierEvaluatesArguments() {
    try {
      const C = NS.wide;
      let marks = 0;
      const t = function (v) { marks = marks + 1; return v; };
      new C(t(1), t(2), t(3), t(4), t(5), t(6), t(7), t(8), t(9), t(10));
      return marks;
    } catch (e) { return -1; }
  }
  // PINNED RESIDUAL: a CALL-expression callee (#6607's arm) whose class is
  // foreign. Null on both trees.
  export function callCalleeTenArgs() {
    try {
      const g = function () { return NS.wide; };
      const o = new (g())(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
      return o === null ? -2 : o.sum;
    } catch (e) { return -1; }
  }
`;

describe("#6611 — `new <ctor value>(…)` above eight arguments, standalone", () => {
  it(
    "constructs across the link at nine and ten arguments, and evaluates them in order",
    { timeout: 600_000 },
    async () => {
      const ex = await linkedPair(PROVIDER, CONSUMER);
      // TEETH. Base tree: -2 for both — the `new` evaluated to null, because a
      // provider-owned class is not a candidate for the consumer's tag-dispatch
      // fallback, so the declined site fell to `ref.null.extern`.
      expect(ex.wideTenArgs()).toBe(55);
      expect(ex.wideNineArgs()).toBe(1);
      // TEETH, and the clause most likely to be reintroduced by a refactor that
      // "simplifies" the decline back into an early return. Base tree: 0 — not
      // one of the ten argument expressions ran.
      expect(ex.evaluatesItsArguments()).toBe(10);
      // Base tree: 0, same cause. 1,2,…,10 read as base-11 digits.
      expect(ex.evaluatesLeftToRight()).toBe(2_853_116_705);
      // CONTROL — measured identical on base and branch (36). The arity-8 tail
      // is deliberately untouched so every module that compiled before stays
      // byte-identical; a change here means the gate on
      // `arity > MAX_NATIVE_CONSTRUCT_ARITY` has been widened by accident.
      expect(ex.narrowEightArgs()).toBe(36);
      // PINNED RESIDUALS — all four identical on base and branch, and recorded
      // so that fixing one fails this file loudly instead of leaving a stale
      // expectation. The first two are the load-bearing pair: the SAME null at
      // arity 10 and at arity 8 is what proves the bound-identifier spelling is
      // a different mechanism, and the third shows it reaching the argument
      // evaluation this defect skipped.
      expect(ex.boundIdentifierTenArgs()).toBe(-2);
      expect(ex.boundIdentifierEightArgs()).toBe(-2);
      expect(ex.boundIdentifierEvaluatesArguments()).toBe(10);
      expect(ex.callCalleeTenArgs()).toBe(-2);
    },
  );

  it("CONTROL: a module-local class was already correct at ten arguments", async () => {
    // Base tree: "55/1/10" — identical. This is the asymmetry that hid the
    // defect for so long. A single module owns its classes, so the declined
    // site still found a tag-dispatch candidate and constructed correctly; only
    // a callee from ANOTHER module had no candidate and fell to null. Asserted
    // as a control: the widened ceiling must not change this answer.
    await expect(
      runStandaloneString(`(() => {
        class W {
          constructor(a, b, c, d, e, f, g, h, i, j) { this.sum = a+b+c+d+e+f+g+h+i+j; this.first = a; }
        }
        const reg = {}; reg["%W%"] = W;
        const C = reg["%W%"];
        let marks = 0;
        const t = (v) => { marks = marks + 1; return v; };
        const o = new C(t(1), t(2), t(3), t(4), t(5), t(6), t(7), t(8), t(9), t(10));
        return o.sum + "/" + o.first + "/" + marks; })()`),
    ).resolves.toBe("55/1/10");
  });

  it("CONTROL: the admission ceiling still has a top", async () => {
    // `MAX_DYNAMIC_CONSTRUCT_ARITY` is 16, so a call site above it still
    // declines — the point of the constant is to bound how large a function one
    // pathological call site can mint, not to remove the bound. A module-local
    // class keeps the tag-dispatch fallback either way, which is what makes
    // this observable without a second linked fixture. Base tree: "17/136".
    await expect(
      runStandaloneString(`(() => {
        class W { constructor() { this.n = arguments.length; } }
        const reg = {}; reg["%W%"] = W;
        const C = reg["%W%"];
        const a = new C(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16);
        const b = new C(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17);
        return (a === null ? "null" : "16") + "/" + (b === null ? "null" : "17"); })()`),
    ).resolves.toBe("16/17");
  });
});
