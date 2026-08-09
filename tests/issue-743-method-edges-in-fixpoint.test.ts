// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #743 — call-graph COMPLETENESS: prototype/static-method call edges and
// `new this(…)` edges in the fnctor graph fixpoint
// (src/ir/fnctor-method-edges.ts).
//
// Two measured nulls (#4117 single-hop, #4131 fixpoint `new`-edges + `.d.ts`
// seeds) both died at the same wall on acorn: the chain from every typed
// entrypoint into `Parser`'s constructor crosses a PROPERTY call
// (`Parser.parse(input, options)`, a write-once static method) followed by
// `new this(options, input)` — and the constructor itself is a function
// EXPRESSION (`var Parser = function Parser(…)`), outside the propagation
// population. These tests pin exactly the acorn shape end-to-end, plus the
// soundness rules (name-based widening, value-escape poisoning, write-once
// discipline) that keep a narrowed fact honest.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { fnctorFieldProvenanceRecords, resetFnctorFieldProvenance } from "../src/codegen/fnctor-field-provenance.js";
import { computeFnctorGraphCtorParamFacts } from "../src/ir/fnctor-method-edges.js";
import { ts } from "../src/ts-api.js";

function fixture(source: string): { checker: ts.TypeChecker; file: ts.SourceFile } {
  const files = new Map([
    ["/repo/a.ts", source],
    ["/repo/lib.d.ts", "declare var undefined: undefined;"],
  ]);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noImplicitAny: false,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = files.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(["/repo/a.ts"], options, host);
  return { checker: program.getTypeChecker(), file: program.getSourceFile("/repo/a.ts")! };
}

function facts(source: string): ReadonlyMap<string, readonly { kind: string }[]> {
  const { checker, file } = fixture(source);
  return computeFnctorGraphCtorParamFacts(file, { checker });
}

// The acorn shape, minimized: an entrypoint fn decl feeds a write-once STATIC
// method through a property call, whose body constructs the fn-EXPRESSION
// constructor via `new this(…)`. Neither hop is an identifier call.
const ACORN_SHAPE = `
  export {};
  var P = function P(options, input, startPos) {
    this.pos = startPos;
    this.src = input;
  };
  P.parse = function parse(input, startPos) {
    return new this({ deep: 1 }, input, startPos);
  };
  function top() {
    return P.parse("code", 42);
  }
`;

describe("#743 — method-call and new-this edges (fnctor graph fixpoint)", () => {
  it("narrows a fn-expr ctor param through a static-method call + new this(…) — two hops", () => {
    const map = facts(ACORN_SHAPE);
    const p = map.get("P")!;
    expect(p).toBeDefined();
    // input: "code" (string literal) → static parse.input → new this arg 1.
    expect(p[1]).toEqual({ kind: "string" });
    // startPos: 42 (f64 literal) → static parse.startPos → new this arg 2.
    expect(p[2]).toEqual({ kind: "f64" });
  });

  it("relays through a write-once PROTOTYPE method installed via a prototype alias", () => {
    const map = facts(`
      export {};
      var Q = function Q(n) { this.n = n; };
      var qq = Q.prototype;
      qq.mk = function (k) { return new Q(k); };
      function go(q) { return q.mk(7); }
    `);
    // 7 → (name-based edge) qq.mk.k → identifier `new Q(k)` edge → Q.n.
    expect(map.get("Q")?.[0]).toEqual({ kind: "f64" });
  });

  it("name-based edges widen on a conflicting same-name site instead of guessing", () => {
    const map = facts(`
      export {};
      var Q = function Q(n) { this.n = n; };
      var qq = Q.prototype;
      qq.mk = function (k) { return new Q(k); };
      function go(q) { return q.mk(7); }
      function go2(other) { return other.mk("s"); }
    `);
    // The "s" site might dispatch to qq.mk — k must widen, so Q.n is not f64.
    expect(map.get("Q")?.[0]).not.toEqual({ kind: "f64" });
  });

  it("a method whose value is read outside a call publishes no edges (escape)", () => {
    const map = facts(`
      export {};
      var Q = function Q(n) { this.n = n; };
      var qq = Q.prototype;
      qq.mk = function (k) { return new Q(k); };
      function go(q) { return q.mk(7); }
      var grabbed = qq.mk;
    `);
    // mk's params fall DYNAMIC (unseen dispatch through `grabbed`), so the
    // relayed `new Q(k)` widens Q.n.
    expect(map.get("Q")?.[0]).not.toEqual({ kind: "f64" });
  });

  it("a ctor whose value escapes is poisoned — an alias could construct it unseen", () => {
    const map = facts(`
      export {};
      var P = function P(x) { this.x = x; };
      function mk() { return new P(1); }
      var alias = P;
    `);
    expect(map.get("P")?.[0]?.kind ?? "absent").not.toBe("f64");
  });

  it("the API-mirror literal (Parser.acorn shape) is boundary-only, not an escape", () => {
    const map = facts(`
      export {};
      var P = function P(options, input, startPos) { this.pos = startPos; };
      P.parse = function parse(input, startPos) { return new this({}, input, startPos); };
      P.acorn = { P: P, version: "1" };
      function top() { return P.parse("code", 42); }
    `);
    expect(map.get("P")?.[2]).toEqual({ kind: "f64" });
  });

  it("a mirror whose holding property is read elsewhere is a REAL escape", () => {
    const map = facts(`
      export {};
      var P = function P(options, input, startPos) { this.pos = startPos; };
      P.parse = function parse(input, startPos) { return new this({}, input, startPos); };
      P.acorn = { P: P };
      function top() { return P.parse("code", 42); }
      function other(x) { return x.acorn; }
    `);
    expect(map.get("P")?.[2]).not.toEqual({ kind: "f64" });
  });

  it("a dynamic-key call on an UNTRACKED base (acorn's plugins[i](cls)) does not drop methods", () => {
    const map = facts(`
      export {};
      var P = function P(options, input, startPos) { this.pos = startPos; };
      P.parse = function parse(input, startPos) { return new this({}, input, startPos); };
      function ext(plugins) { for (var i = 0; i < plugins.length; i++) { plugins[i](1); } }
      function top() { return P.parse("code", 42); }
    `);
    expect(map.get("P")?.[2]).toEqual({ kind: "f64" });
  });

  it("a dynamic-key access on a TRACKED base drops that owner's methods", () => {
    const map = facts(`
      export {};
      var Q = function Q(n) { this.n = n; };
      var qq = Q.prototype;
      qq.mk = function (k) { return new Q(k); };
      function go(q) { return q.mk(7); }
      function peek(k) { return qq[k]; }
    `);
    expect(map.get("Q")?.[0]).not.toEqual({ kind: "f64" });
  });

  it("a method assigned twice is not write-once and relays nothing", () => {
    const map = facts(`
      export {};
      var Q = function Q(n) { this.n = n; };
      Q.mk = function (k) { return new this(k); };
      Q.mk = function (k) { return new this(k + 1); };
      function go() { return Q.mk(7); }
    `);
    expect(map.get("Q")?.[0]).not.toEqual({ kind: "f64" });
  });

  it("new this(…) inside a plain function drops every ctor fact (this is rebindable)", () => {
    const map = facts(`
      export {};
      var P = function P(x) { this.x = x; };
      function sneaky() { return new this("s"); }
      function mk() { return new P(1); }
    `);
    expect(map.size).toBe(0);
  });

  it("export-clause references are the accepted boundary, not an escape", () => {
    const map = facts(`
      var P = function P(options, input, startPos) { this.pos = startPos; };
      P.parse = function parse(input, startPos) { return new this({}, input, startPos); };
      function top() { return P.parse("code", 42); }
      export { P, top };
    `);
    expect(map.get("P")?.[2]).toEqual({ kind: "f64" });
  });
});

// ── End-to-end: the fact reaches the emitted fnctor FIELD slot ──────────────

const E2E_SRC = `
var P = function P(options, input, startPos) {
  this.pos = startPos;
};
P.parse = function parse(input, startPos) {
  return new this({ deep: 1 }, input, startPos).run();
};
var pp = P.prototype;
pp.run = function () { return this.pos; };
export function top() { return P.parse("code", 42); }
`;

describe("#743 — graph fact reaches the fnctor field slot (flagged compile)", () => {
  const savedCtor = process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES;
  const savedProv = process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
  beforeEach(() => {
    resetFnctorFieldProvenance();
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "1";
    process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE = "1";
    // (#743 defaults flip) The field-SLOT consumer is opt-in — see
    // src/derivation-flags.ts. These pins are about it, so they ask for it.
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS = "1";
  });
  afterEach(() => {
    resetFnctorFieldProvenance();
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (savedCtor === undefined) delete process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES;
    else process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = savedCtor;
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (savedProv === undefined) delete process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
    else process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE = savedProv;
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    delete process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS;
  });

  it("emits an f64 slot for a ctor-param field fed only through new this(…)", async () => {
    const r = await compile(E2E_SRC, {
      fileName: "t.mjs",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
    const pos = fnctorFieldProvenanceRecords().find((x) => x.owner === "P" && x.field === "pos");
    expect(pos, "expected a provenance row for P.pos").toBeDefined();
    expect(pos!.slot).toBe("f64");
    // Runtime: the narrowing must not CHANGE behaviour. On this minimal shape
    // the static-method dispatch path returns null in standalone with the flag
    // OFF as well (pre-existing, unrelated to slot typing — verified on
    // untouched origin/main), so the honest pin is flag-on ≡ flag-off, not an
    // absolute value.
    const run = async (binary: Uint8Array): Promise<unknown> => {
      const module = await WebAssembly.compile(binary);
      if (WebAssembly.Module.imports(module).length > 0) return "has-imports";
      const { exports } = await WebAssembly.instantiate(module, {});
      return (exports as { top(): unknown }).top();
    };
    const onResult = await run(r.binary as Uint8Array);
    // (#743 defaults flip, 2026-08-08) OFF is a SPELLING now — unset is ON, so
    // deleting the variable here would silently test the flag-ON path.
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "0";
    const off = await compile(E2E_SRC, {
      fileName: "t.mjs",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(off.success).toBe(true);
    expect(onResult).toEqual(await run(off.binary as Uint8Array));
  });

  it("flag off: the graph satellite is invisible and the slot stays boxed", async () => {
    // (#743 defaults flip, 2026-08-08) OFF is a SPELLING now — unset is ON, so
    // deleting the variable here would silently test the flag-ON path.
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "0";
    const r = await compile(E2E_SRC, {
      fileName: "t.mjs",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
    const pos = fnctorFieldProvenanceRecords().find((x) => x.owner === "P" && x.field === "pos");
    expect(pos?.slot).toBe("externref");
  });
});
