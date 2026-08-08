// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #743 — field↔param MUTUAL fixpoint in the fnctor graph satellite
// (src/ir/fnctor-method-edges.ts).
//
// The previous slice (#4166, method-call + `new this` edges) closed the call
// graph and moved the acorn census 41 → 40, then measured that the dominant
// remainder — ~14 slots — is blocked on a different thing entirely: the
// arguments are FIELD READS of the receiver (`this.startNodeAt(this.start, …)`,
// `this.start = this.end = this.pos`, `new Token(this)` then `p.start`).
// `inferExpr` types those DYNAMIC, so narrowing them needs the field slots to
// be lattice VARIABLES solved together with the params rather than derived
// afterwards.
//
// These tests pin both directions of that cycle plus the soundness rules that
// make a field fact honest: the undefined-read (definiteness / ordering) guard,
// the full write taxonomy including compound assignment, name-based widening
// from untracked receivers, the poison set, and `.call` forwarding — without
// which acorn's `finishNodeAt` (reached ONLY as `finishNodeAt.call(this, …)`)
// would contribute lattice BOTTOM instead of widening.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { fnctorFieldProvenanceRecords, resetFnctorFieldProvenance } from "../src/codegen/fnctor-field-provenance.js";
import {
  computeFnctorGraphCtorParamFacts,
  computeFnctorGraphCtorThisReadFacts,
} from "../src/ir/fnctor-method-edges.js";
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

function params(source: string): ReadonlyMap<string, readonly { kind: string }[]> {
  const { checker, file } = fixture(source);
  return computeFnctorGraphCtorParamFacts(file, { checker });
}

/** `this.<name>` read facts keyed by the read's SOURCE TEXT, for readability. */
function reads(source: string): Map<string, string> {
  const { checker, file } = fixture(source);
  const out = new Map<string, string>();
  for (const [node, t] of computeFnctorGraphCtorThisReadFacts(file, { checker })) {
    out.set(node.getText(), t.kind);
  }
  return out;
}

// ── Edge (b): field reads feeding params ─────────────────────────────────────

describe("#743 — field slots are lattice variables (mutual fixpoint)", () => {
  it("closes a two-fnctor cycle: param → field → method arg → param → field", () => {
    const src = `
      export {};
      var P = function P(startPos) {
        this.pos = startPos;
        this.start = this.end = this.pos;
      };
      var pp = P.prototype;
      pp.mk = function () { return new N(this.start, this.pos - this.end); };
      var N = function N(a, b) { this.a = a; this.b = b; };
      function top() { return new P(42).mk(); }
    `;
    // `this.start` is a DIRECT read (field-fact path); `this.pos - this.end` is
    // a NESTED read, which only resolves through the per-owner instance atom.
    expect(params(src).get("N")).toEqual([{ kind: "f64" }, { kind: "f64" }]);
    expect(reads(src).get("this.pos")).toBe("f64");
  });

  it("bare `this` as an argument carries the instance shape (the Token pattern)", () => {
    const src = `
      export {};
      var P = function P(startPos) { this.pos = startPos; this.start = startPos; };
      var pp = P.prototype;
      pp.tok = function () { return new T(this); };
      var T = function T(p) { this.s = p.start; };
      function top() { return new P(42).tok(); }
    `;
    // `new T(this)` → T's param IS the instance atom → `p.start` resolves
    // through the EXISTING object-shape property-access rule, no new machinery.
    expect(params(src).get("T")?.[0]?.kind).toBe("object");
    // The `<param>.<y>` carrier is node-keyed alongside the `this.<y>` reads
    // (the consumer's Token.start path — it used to be absent here, which is
    // exactly the gap that left `this.s = p.start` unconsumable).
    expect(reads(src).get("p.start")).toBe("f64");
  });

  it("a conflicting method write WIDENS the slot instead of guessing", () => {
    const src = `
      export {};
      var P = function P(startPos) {
        this.pos = startPos;
        this.start = this.pos;
      };
      var pp = P.prototype;
      pp.bad = function () { this.pos = "s"; };
      pp.mk = function () { return new N(this.start); };
      var N = function N(a) { this.a = a; };
      function top() { return new P(42).mk(); }
    `;
    expect(reads(src).get("this.pos")).not.toBe("f64");
    expect(params(src).get("N")?.[0]).not.toEqual({ kind: "f64" });
  });

  it("a string-written field widens the downstream param it feeds", () => {
    const src = `
      export {};
      var P = function P(s) { this.label = s; };
      var pp = P.prototype;
      pp.mk = function () { return new N(this.label); };
      var N = function N(a) { this.a = a; };
      function top() { return new P("x").mk(); }
    `;
    expect(params(src).get("N")?.[0]).toEqual({ kind: "string" });
  });
});

// ── Edge (a): the write taxonomy ─────────────────────────────────────────────

describe("#743 — field write taxonomy", () => {
  it("`+=` and `++` are WRITES — acorn's `this.pos += n` is load-bearing", () => {
    const numeric = `
      export {};
      var P = function P(startPos) { this.pos = startPos; this.start = this.pos; };
      var pp = P.prototype;
      pp.adv = function (n) { this.pos += n; this.pos++; };
      function top() { return new P(1).adv(2); }
    `;
    expect(reads(numeric).get("this.pos")).toBe("f64");
    // The same shape with a STRING `+=` must widen: `1 + "s"` is a string, so
    // the slot holds f64-or-string and the f64-only consumer declines it.
    const stringy = `
      export {};
      var P = function P(startPos) { this.pos = startPos; this.start = this.pos; };
      var pp = P.prototype;
      pp.adv = function () { this.pos += "s"; };
      function top() { return new P(1).adv(); }
    `;
    expect(reads(stringy).get("this.pos")).toBe("union");
  });

  it("a `-=` on a string-seeded field still proves NUMBER (JS coerces)", () => {
    const src = `
      export {};
      var P = function P() { this.n = 0; this.copy = this.n; };
      var pp = P.prototype;
      pp.dec = function () { this.n -= 1; };
      function top() { return new P().dec(); }
    `;
    expect(reads(src).get("this.n")).toBe("f64");
  });

  it("an untracked-receiver write contributes its real type, it does not poison", () => {
    // `node.end = pos` (acorn's `finishNodeAt`) is attributed name-based to
    // EVERY owner. Keeping it a contribution rather than a poison is what keeps
    // `Parser.end` alive.
    const ok = `
      export {};
      var P = function P(startPos) { this.end = startPos; this.copy = this.end; };
      function stamp(node, pos) { node.end = pos; }
      function top() { stamp({}, 3); return new P(1); }
    `;
    expect(reads(ok).get("this.end")).toBe("f64");
    const widened = `
      export {};
      var P = function P(startPos) { this.end = startPos; this.copy = this.end; };
      function stamp(node) { node.end = "s"; }
      function top() { stamp({}); return new P(1); }
    `;
    expect(reads(widened).get("this.end")).not.toBe("f64");
  });
});

// ── The undefined-read guard ─────────────────────────────────────────────────

describe("#743 — definiteness and ordering", () => {
  it("a read BEFORE the write does not narrow (`this.a = this.b; this.b = 1`)", () => {
    const src = `
      export {};
      var P = function P() { this.a = this.b; this.b = 1; };
      function top() { return new P(); }
    `;
    expect(reads(src).get("this.b")).toBe("dynamic");
  });

  it("a conditionally-assigned field is not readable (undefined hazard)", () => {
    const src = `
      export {};
      var P = function P(c, n) { if (c) { this.b = n; } this.a = this.b; };
      function top() { return new P(true, 1); }
    `;
    expect(reads(src).get("this.b")).toBe("dynamic");
  });

  it("BOTH arms of an if/else make the field definite (acorn's pos/lineStart)", () => {
    const src = `
      export {};
      var P = function P(c, n) { if (c) { this.b = n; } else { this.b = 0; } this.a = this.b; };
      function top() { return new P(true, 1); }
    `;
    expect(reads(src).get("this.b")).toBe("f64");
  });

  it("a write inside an arrow in the ctor sees nothing (may run at any time)", () => {
    const src = `
      export {};
      var P = function P(n) { this.b = n; var f = () => { this.c = this.b; }; f(); };
      function top() { return new P(1); }
    `;
    // `this.c = this.b` is attributed to P but is NOT ctor-direct, so it
    // contributes no read fact at all.
    expect(reads(src).has("this.b")).toBe(false);
  });
});

// ── Poisons ──────────────────────────────────────────────────────────────────

describe("#743 — field poisons", () => {
  const base = (extra: string): string => `
      export {};
      var P = function P(n) { this.pos = n; this.start = this.pos; };
      var pp = P.prototype;
      ${extra}
      function top() { return new P(1); }
    `;

  it("`delete this.x` poisons the name", () => {
    expect(reads(base(`pp.drop = function () { delete this.pos; };`)).get("this.pos")).toBe("dynamic");
  });

  it("`this[k] = v` poisons every field of the owner", () => {
    expect(reads(base(`pp.set = function (k, v) { this[k] = v; };`)).get("this.pos")).toBe("dynamic");
  });

  it("a dynamic-key write on an UNTRACKED base is the documented gap, NOT a poison", () => {
    // acorn's `copyNode`: `for (var prop in node) { newNode[prop] = node[prop] }`.
    // Treating that as a global field poison is a whole-module kill switch —
    // measured: it zeroed every acorn field fact. The receiver is not `this`,
    // so it cannot be localized to an owner, and the f64-only consumer bounds
    // the damage exactly as it does for #4166's dynamic instance reads.
    const src = base(`function copy(a, b) { for (var k in b) { a[k] = b[k]; } }`);
    expect(reads(src).get("this.pos")).toBe("f64");
    // `this[k] = v` — where the owner IS localizable — still poisons.
    expect(reads(base(`pp.set = function (k, v) { this[k] = v; };`)).get("this.pos")).toBe("dynamic");
  });

  it("`Object.defineProperty(this, 'pos', …)` poisons that name", () => {
    const src = base(`pp.def = function () { Object.defineProperty(this, 'pos', { value: 1 }); };`);
    expect(reads(src).get("this.pos")).toBe("dynamic");
  });

  it("a destructuring assignment target poisons the name", () => {
    expect(reads(base(`function grab(o) { ({ pos: o.pos } = { pos: "s" }); }`)).get("this.pos")).toBe("dynamic");
  });

  it("a replaced prototype poisons the owner (an accessor could intercept)", () => {
    const src = `
      export {};
      var P = function P(n) { this.pos = n; this.start = this.pos; };
      P.prototype = {};
      function top() { return new P(1); }
    `;
    expect(reads(src).get("this.pos")).toBe("dynamic");
  });

  it("an ESCAPED constructor publishes no field facts at all", () => {
    const src = `
      export {};
      var P = function P(n) { this.pos = n; this.start = this.pos; };
      var alias = P;
      function top() { return new P(1); }
    `;
    // A poisoned owner is skipped outright — the consumer sees no entry, which
    // is the same "leave the checker's choice alone" answer as `dynamic`.
    expect(reads(src).has("this.pos")).toBe(false);
  });
});

// ── §7 call forwarding ───────────────────────────────────────────────────────

describe("#743 — call forwarding (F.call / F.apply / F.bind)", () => {
  const CALL_SHAPE = (arg: string): string => `
      export {};
      var P = function P(n) { this.pos = n; this.start = this.pos; };
      function stamp(node, pos) { node.pos = pos; }
      var pp = P.prototype;
      pp.go = function () { return stamp.call(this, {}, ${arg}); };
      function top() { return new P(1).go(); }
    `;

  it("`F.call(this, …)` is a real edge — a string argument widens the slot", () => {
    // Without the edge, `stamp`'s `pos` stays lattice BOTTOM forever and its
    // `node.pos = pos` write contributes NOTHING — optimism, not conservatism.
    expect(reads(CALL_SHAPE(`1`)).get("this.pos")).toBe("f64");
    expect(reads(CALL_SHAPE(`"s"`)).get("this.pos")).not.toBe("f64");
  });

  it("`F.apply(…)` drops F's facts (its argument list is a runtime array)", () => {
    const src = `
      export {};
      var P = function P(n) { this.pos = n; };
      function mk(a) { return new P(a); }
      function go(args) { return mk.apply(null, args); }
      function top() { return mk(1); }
    `;
    expect(params(src).get("P")?.[0]).not.toEqual({ kind: "f64" });
  });

  it("an extracted `F.bind` poisons F (an unseen invocation alias)", () => {
    const src = `
      export {};
      var P = function P(n) { this.pos = n; };
      function mk(a) { return new P(a); }
      var bound = mk.bind(null);
      function top() { return mk(1); }
    `;
    expect(params(src).get("P")?.[0]).not.toEqual({ kind: "f64" });
  });

  it("`x.constructor` in a non-comparison position drops every ctor fact", () => {
    const poisoned = `
      export {};
      var P = function P(n) { this.pos = n; };
      function mk(a) { return new P(a); }
      function clone(x) { return new x.constructor("s"); }
      function top() { return mk(1); }
    `;
    expect(params(poisoned).size).toBe(0);
    // The type-check idiom must stay safe — blanket-poisoning it would nuke
    // real corpora. (The comparand is an untracked global here: naming `P`
    // itself is a value ESCAPE under the pre-existing rule, a separate axis.)
    const safe = `
      export {};
      var P = function P(n) { this.pos = n; };
      function mk(a) { return new P(a); }
      function isArray(x) { return x.constructor === Array; }
      function top() { return mk(1); }
    `;
    expect(params(safe).get("P")?.[0]).toEqual({ kind: "f64" });
  });
});

// ── End-to-end: the field fact reaches the emitted slot ──────────────────────

const E2E_SRC = `
var P = function P(startPos) {
  this.pos = startPos;
  this.start = this.end = this.pos;
};
var pp = P.prototype;
pp.mk = function () { return new N(this.start, this.pos - this.end); };
var N = function N(a, b) { this.a = a; this.b = b; };
// The export returns a plain i32 verdict rather than the sum itself: with the
// flag OFF the boxed slots make the sum an opaque GC reference at the boundary,
// which is not comparable across the two compiles.
export function top() { var n = new P(7).mk(); return (n.a + n.b) === 7 ? 1 : -1; }
`;

async function compileE2E(): Promise<{ binary: Uint8Array; slots: Map<string, string> }> {
  resetFnctorFieldProvenance();
  const r = await compile(E2E_SRC, {
    fileName: "t.mjs",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
  const slots = new Map<string, string>();
  for (const rec of fnctorFieldProvenanceRecords()) slots.set(`${rec.owner}.${rec.field}`, rec.slot);
  return { binary: r.binary as Uint8Array, slots };
}

async function run(binary: Uint8Array): Promise<unknown> {
  const module = await WebAssembly.compile(binary);
  if (WebAssembly.Module.imports(module).length > 0) return "has-imports";
  const { exports } = await WebAssembly.instantiate(module, {});
  return (exports as { top(): unknown }).top();
}

describe("#743 — mutual-fixpoint facts reach the fnctor field slots", () => {
  const savedCtor = process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES;
  const savedProv = process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
  beforeEach(() => {
    resetFnctorFieldProvenance();
    process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE = "1";
    // (#743 defaults flip, 2026-08-08) The field-SLOT consumer is the family's
    // one deliberately-excluded sub-lever and is opt-in — see
    // src/derivation-flags.ts. These pins are ABOUT that consumer, so they ask
    // for it explicitly; the shipped default does not have it.
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

  it("emits f64 slots for BOTH sides of a field↔param cycle, behaviour unchanged", async () => {
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "1";
    const on = await compileE2E();
    // `start`/`end` are field READS — the parameter path cannot see them at all.
    expect(on.slots.get("P.pos")).toBe("f64");
    expect(on.slots.get("P.start")).toBe("f64");
    expect(on.slots.get("P.end")).toBe("f64");
    // `N.a`/`N.b` come back the other way: a field read feeding a ctor argument.
    expect(on.slots.get("N.a")).toBe("f64");
    expect(on.slots.get("N.b")).toBe("f64");
    const onResult = await run(on.binary);

    // (#743 defaults flip, 2026-08-08) OFF is a SPELLING now — unset is ON, so
    // deleting the variable here would silently test the flag-ON path.
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "0";
    const off = await compileE2E();
    expect(off.slots.get("P.start")).toBe("externref");
    expect(off.slots.get("N.a")).toBe("externref");
    expect(onResult).toEqual(await run(off.binary));
  });

  it("flag off: byte-identical to a second flag-off compile (satellite invisible)", async () => {
    // (#743 defaults flip, 2026-08-08) OFF is a SPELLING now — unset is ON, so
    // deleting the variable here would silently test the flag-ON path.
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "0";
    const a = await compileE2E();
    const b = await compileE2E();
    expect(Buffer.from(a.binary).equals(Buffer.from(b.binary))).toBe(true);
  });
});
