// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4235) Path parity for the fnctor pipeline.
 *
 * `generateMultiModule` never assigned `ctx.fnctorEscapeGate`, so on every
 * multi-file compile (`compileProject` / `compileMulti` — the path most of the
 * npm-compat corpus goes through) the escape gate, the presence-bit/hot-cold
 * split and the per-type layout analysis were ALL inert, with no error and no
 * fallback telemetry. The failure was a **silent empty**: a zero from that path
 * was indistinguishable from "this package contains no fnctors", which is
 * exactly how the 2026-08-08 corpus census came to be run entirely through the
 * single-file path without anyone noticing the other one was dark.
 *
 * These tests pin the property that makes that impossible to regress to:
 * **the same source analysed through `compile()` and through `compileMulti()`
 * yields the same fnctor verdicts** — and where the multi path declines, it
 * declines out loud, into a counted ledger.
 *
 * The analysis is exercised directly rather than through the compilers so a
 * verdict mismatch fails HERE, on the verdict, instead of surfacing later as a
 * byte-count difference nobody can attribute.
 */
import { describe, it, expect, afterEach } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeFnctorEscapeGate } from "../src/codegen/fnctor-escape-gate.js";
import { compile, compileMulti } from "../src/index.js";

/**
 * The TWO_SITE fixture from the issue: one fnctor, two factories that give its
 * instances two DIFFERENT shapes. The single-file path proves `split` on this;
 * anything less from the multi path is the bug.
 */
const TWO_SITE = `
function Node(pos: any) {
  this.type = "";
  this.start = pos;
  this.end = 0;
}
Node.prototype.finish = function (t: any, end: any) {
  this.type = t;
  this.end = end;
  return this;
};
function makeA(p: any) { const n = new Node(p); n.extraA = 1; return n; }
function makeB(p: any) { const n = new Node(p); n.extraB = 2; n.extraC = 3; return n; }
export function test(): number {
  const a: any = makeA(1);
  const b: any = makeB(2);
  a.finish("A", 5);
  b.finish("B", 6);
  return (a.end as number) + (b.end as number) === 11 ? 1 : 0;
}
`;

/** Build an in-memory program over `files` and return its checker + sources. */
function programOf(files: Record<string, string>): {
  checker: ts.TypeChecker;
  sourceFiles: ts.SourceFile[];
} {
  const sources = new Map<string, ts.SourceFile>();
  for (const [name, text] of Object.entries(files)) {
    sources.set(name, ts.createSourceFile(name, text, ts.ScriptTarget.ES2020, true));
  }
  const host: ts.CompilerHost = {
    getSourceFile: (name) => sources.get(name),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => sources.has(name),
    readFile: (name) => files[name],
  };
  const program = ts.createProgram([...sources.keys()], { allowJs: true, noLib: true }, host);
  return {
    checker: program.getTypeChecker(),
    sourceFiles: [...sources.keys()].map((k) => sources.get(k)!),
  };
}

/** The verdict surface the two paths must agree on. */
function verdicts(files: Record<string, string>, path: "single" | "multi") {
  const { checker, sourceFiles } = programOf(files);
  const r = analyzeFnctorEscapeGate(checker, sourceFiles, true, path);
  const byClass = { reconstruct: 0, "keep-typed": 0, "keep-static": 0 };
  for (const c of r.sites.values()) byClass[c]++;
  return {
    byClass,
    approvedNames: [...r.approvedNames].sort(),
    ctorNames: [...r.ctorDeclByName.keys()].sort(),
    receiverStructEntries: r.receiverStruct.size,
    writeOncePoisoned: [...r.protoMethodWriteOnce.poisoned].sort(),
    provenance: r.provenance,
  };
}

describe("#4235 — the fnctor pipeline runs on the multi-file compile path", () => {
  it("gives the SAME verdicts for the TWO_SITE fixture on both paths", () => {
    const files = { "main.ts": TWO_SITE };
    const single = verdicts(files, "single");
    const multi = verdicts(files, "multi");

    // A vacuous pass is the whole hazard here: if the fixture produced no
    // fnctor sites at all, "single === multi" would hold trivially and this
    // test would defend nothing. Floor the counts first.
    expect(single.byClass.reconstruct).toBeGreaterThan(0);
    expect(single.approvedNames).toContain("Node");

    expect(multi.byClass).toEqual(single.byClass);
    expect(multi.approvedNames).toEqual(single.approvedNames);
    expect(multi.ctorNames).toEqual(single.ctorNames);
    expect(multi.receiverStructEntries).toBe(single.receiverStructEntries);
    expect(multi.writeOncePoisoned).toEqual(single.writeOncePoisoned);
  });

  it("labels every result with the compile path that produced it", () => {
    const files = { "main.ts": TWO_SITE };
    expect(verdicts(files, "single").provenance.compilePath).toBe("single");
    expect(verdicts(files, "multi").provenance.compilePath).toBe("multi");
  });

  it("reports the source-file count, so an empty result is never anonymous", () => {
    // The regression that motivated this: an empty result from a 146-file graph
    // and an empty result from one file are DIFFERENT claims, and before #4235
    // both were rendered as the same silence.
    const one = verdicts({ "main.ts": TWO_SITE }, "multi");
    expect(one.provenance.sourceFileCount).toBe(1);

    const { checker, sourceFiles } = programOf({
      "a.ts": "export function f(): number { return 1; }",
      "b.ts": "export function g(): number { return 2; }",
    });
    // No fnctor `new` sites at all — the empty result STILL carries provenance.
    const empty = analyzeFnctorEscapeGate(checker, sourceFiles, true, "multi");
    expect(empty.approvedNames.size).toBe(0);
    expect(empty.provenance.compilePath).toBe("multi");
    expect(empty.provenance.sourceFileCount).toBe(2);
  });

  it("sees a fnctor whose allocation and consumption live in DIFFERENT modules", () => {
    // The escape a single-module analysis never faced. `p` is allocated in a.ts
    // and consumed dynamically in b.ts; the whole-program walk plus the
    // import-alias symbol resolution is what lets the uses in b.ts reach the
    // binding declared in a.ts.
    const files = {
      "a.ts": `
        export function P(x: any) { this.v = x; }
        P.prototype.m = function () { return this.v; };
        export const p: any = new P(1);
      `,
      "b.ts": `
        import { p } from "./a";
        export function test(): number { p.m(); return 1; }
      `,
    };
    const { checker, sourceFiles } = programOf(files);
    const graph = analyzeFnctorEscapeGate(checker, sourceFiles, true, "multi");
    expect(graph.provenance.sourceFileCount).toBe(2);
    // The `new P(1)` site is found and classified — not silently absent.
    expect(graph.sites.size).toBeGreaterThan(0);
    expect(graph.ctorDeclByName.has("P")).toBe(true);

    // Positive control for the cross-module claim: analysing a.ts ALONE cannot
    // see b.ts's dynamic `p.m()`, so it must classify strictly less
    // aggressively. If this ever stops differing, the fixture stopped testing
    // cross-module visibility and the assertion above is vacuous.
    const aOnly = analyzeFnctorEscapeGate(checker, [sourceFiles[0]!], true, "single");
    expect(aOnly.approvedNames.has("P")).toBe(false);
    expect(graph.approvedNames.has("P")).toBe(true);
  });

  it("REFUSES a fnctor name declared in two modules, and COUNTS the refusal", () => {
    // Everything downstream is keyed by bare NAME (`__fnctor_<Name>` struct
    // key, `approvedNames`, the write-once ledger). A single source made that
    // safe by construction; a module graph does not — #4133 measured 55
    // colliding top-level names across the 146-file ESLint graph. Reserving one
    // module's constructor shape and applying it to another module's
    // same-named, differently-shaped fnctor is a wrong field set, not a missed
    // optimization. The refusal must be visible, which is what `refusals` is.
    const files = {
      "a.ts": `
        export function Dup(x: any) { this.a = x; }
        export function useA(): any { const d: any = new Dup(1); d.dyn = 1; return d; }
      `,
      "b.ts": `
        export function Dup(y: any) { this.b = y; this.c = y; }
        export function useB(): any { const d: any = new Dup(2); d.dyn = 2; return d; }
      `,
    };
    const { checker, sourceFiles } = programOf(files);
    const r = analyzeFnctorEscapeGate(checker, sourceFiles, true, "multi");

    expect(r.approvedNames.has("Dup")).toBe(false);
    expect(r.ctorDeclByName.has("Dup")).toBe(false);
    expect(r.provenance.refusedNames).toContain("Dup");
    expect(r.provenance.refusals.get("multi-module-name-collision")).toBe(1);

    // And the refusal is SPECIFIC, not a blanket bail: a non-colliding fnctor
    // in the same graph is still analysed. Without this the test would pass on
    // an implementation that simply gave up on every multi-module graph.
    const withOk = {
      ...files,
      "c.ts": `
        export function Solo(z: any) { this.z = z; }
        export function useC(): any { const s: any = new Solo(3); s.dyn = 3; return s; }
      `,
    };
    const g2 = programOf(withOk);
    const r2 = analyzeFnctorEscapeGate(g2.checker, g2.sourceFiles, true, "multi");
    expect(r2.provenance.refusedNames).toContain("Dup");
    expect(r2.ctorDeclByName.has("Solo")).toBe(true);
  });

  it("keeps write-once admission closed over the WHOLE graph", () => {
    // The sharpest cross-module hazard: `analyzeProtoMethodWriteOnce` admits a
    // method precisely BECAUSE it saw no second write. Run over one file of a
    // graph it admits a slot that another module overwrites — a typed twin for
    // a mutable slot, i.e. a real miscompile rather than a missed
    // optimization. The graph-wide walk is what makes the second write visible.
    const files = {
      "a.ts": `
        export function W(x: any) { this.v = x; }
        W.prototype.m = function () { return 1; };
        export const w: any = new W(1);
      `,
      "b.ts": `
        import { w } from "./a";
        export function test(): number { w.m(); return 1; }
      `,
    };
    const aOnly = programOf(files);
    const admittedFromAAlone = analyzeFnctorEscapeGate(
      aOnly.checker,
      [aOnly.sourceFiles[0]!],
      true,
      "single",
    ).protoMethodWriteOnce.methods.get("W");
    // Control: with only a.ts in view, `m` IS admitted as write-once.
    expect(admittedFromAAlone?.has("m")).toBe(true);

    // Now the same a.ts inside a graph whose OTHER module rewrites the slot.
    const overwritten = {
      ...files,
      "b.ts": `
        import { w } from "./a";
        import { W } from "./a";
        W.prototype.m = function () { return 2; };
        export function test(): number { w.m(); return 1; }
      `,
    };
    const g = programOf(overwritten);
    const graphVerdict = analyzeFnctorEscapeGate(g.checker, g.sourceFiles, true, "multi").protoMethodWriteOnce;
    // The second write must retract the admission — either by demoting the
    // method or by poisoning the owner. Both are correct; silence is not.
    const stillAdmitted = graphVerdict.methods.get("W")?.has("m") === true && !graphVerdict.poisoned.has("W");
    expect(stillAdmitted).toBe(false);
  });
});

/**
 * The tests above exercise the ANALYSIS. They would all still pass if someone
 * deleted the one line in `generateMultiModule` that assigns
 * `ctx.fnctorEscapeGate` — which is the exact defect #4235 is about. These pin
 * the WIRING, by driving the real compilers and observing that the pipeline
 * actually ran, and under which path.
 */
describe("#4235 — the wiring, observed end-to-end through the compilers", () => {
  const ORIGINAL_WRITE = process.stderr.write.bind(process.stderr);
  const ORIGINAL_LAYOUTS = process.env.JS2WASM_FNCTOR_LAYOUTS;
  const ORIGINAL_DIAG = process.env.JS2WASM_FNCTOR_LAYOUT_DIAG;

  afterEach(() => {
    process.stderr.write = ORIGINAL_WRITE;
    process.env.JS2WASM_FNCTOR_LAYOUTS = ORIGINAL_LAYOUTS;
    process.env.JS2WASM_FNCTOR_LAYOUT_DIAG = ORIGINAL_DIAG;
  });

  /** Run `fn` with the layout diagnostic on, returning everything it wrote. */
  async function captureDiag(fn: () => Promise<unknown>): Promise<string> {
    process.env.JS2WASM_FNCTOR_LAYOUTS = "1";
    process.env.JS2WASM_FNCTOR_LAYOUT_DIAG = "1";
    let buf = "";
    process.stderr.write = ((chunk: unknown) => {
      buf += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await fn();
    } finally {
      process.stderr.write = ORIGINAL_WRITE;
    }
    return buf;
  }

  it("runs the layout analysis on BOTH paths and stamps each with its path", async () => {
    const single = await captureDiag(() => compile(TWO_SITE, { fileName: "main.ts", target: "standalone" } as never));
    const multi = await captureDiag(() =>
      compileMulti({ "main.ts": TWO_SITE }, "main.ts", { target: "standalone" } as never),
    );

    // Positive control FIRST: the single path must actually produce the plan we
    // are about to demand from the multi path. If the fixture ever stops
    // proving `split`, every assertion below becomes vacuous and this line is
    // what says so.
    expect(single).toMatch(/\[alloc-labels\] path=single files=1/);
    expect(single).toMatch(/\[alloc-labels\] Node: verdict=split/);

    // The bug: before #4235 this produced NOTHING at all.
    expect(multi).toMatch(/\[alloc-labels\] path=multi files=1/);
    expect(multi).toMatch(/\[alloc-labels\] Node: verdict=split/);

    // Parity on the verdict line itself (labels/layouts/union/width all match).
    const verdictLine = (s: string) => /\[alloc-labels\] Node: (.*)/.exec(s)?.[1];
    expect(verdictLine(multi)).toBe(verdictLine(single));
  });

  it("stamps the path even when the graph has nothing to report", async () => {
    // A zero must never again be readable without its provenance — the header
    // prints whether or not any family carries labels.
    const out = await captureDiag(() =>
      compileMulti({ "m.ts": "export function f(): number { return 1; }" }, "m.ts", {
        target: "standalone",
      } as never),
    );
    expect(out).toMatch(/\[alloc-labels\] path=multi files=1 families=\d+ with-labels=\d+/);
  });
});
