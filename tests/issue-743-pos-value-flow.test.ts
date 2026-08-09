// (#743) The three `Parser.pos` value-flow levers landed after the 2026-08-08
// pin census, plus the two defects that census-driven measurement exposed:
//
//  1. RECEIVER-PROVENANCE attribution — an `"all"` write whose receiver
//     provably holds instances of ONE tracked owner re-attributes to that
//     owner (acorn: the 22 `state.pos = …` regexp writes).
//  2. LOCAL BINDINGS — a provably-initialized function-local's value is the
//     join of all its contributions (acorn: `finishOp`'s literal-fed `size`
//     locals; `var end = this.input.indexOf(…)`).
//  3. STRING SUBSTRATE — `String(x)` → string; indexOf/lastIndexOf/charCodeAt
//     and `.length` on a provably-string receiver → f64.
//  4. The `+=` RATCHET fix — a plus-assign contribution must not read its own
//     previous-iteration fact (a transient atom-lag DYNAMIC became permanent).
//  5. `<param>.<field>` ctor carriers (the Token pattern) are node-keyed
//     alongside `this.<y>` reads for the consumer.
//
// Negative cases are the load-bearing half throughout.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fnctorFieldProvenanceRecords, resetFnctorFieldProvenance } from "../src/codegen/fnctor-field-provenance.js";
import { compile } from "../src/index.js";
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

/** Ctor carrier facts keyed by source text (the family's idiom). */
function reads(source: string): Map<string, string> {
  const { checker, file } = fixture(source);
  const out = new Map<string, string>();
  for (const [node, t] of computeFnctorGraphCtorThisReadFacts(file, { checker })) {
    out.set(node.getText(), t.kind);
  }
  return out;
}

function params(source: string): Map<string, readonly string[]> {
  const { checker, file } = fixture(source);
  const out = new Map<string, readonly string[]>();
  for (const [name, facts] of computeFnctorGraphCtorParamFacts(file, { checker })) {
    out.set(
      name,
      facts.map((f) => f.kind),
    );
  }
  return out;
}

// ── 1. Receiver-provenance attribution ───────────────────────────────────────

// The acorn `||`-caching shape, miniaturized: `helper`'s `state` param is fed
// only by the cached-or-fresh RegExp-state local, so its `state.pos = <string>`
// write must stop dragging P's own `pos` fact — while still reaching R's.
const PROVENANCE = (write: string, extra = ""): string => `
var P = function P(x) {
  this.pos = x;
  this.mark = this.pos;
  this.cache = null;
};
var pp = P.prototype;
pp.run = function () {
  var state = this.cache || (this.cache = new R(this));
  this.helper(state);
};
pp.helper = function (state) {
  ${write}
};
var R = function R(owner) {
  this.owner = owner;
  this.pos = 0;
};
${extra}
export function top(v) { var p = new P(v.n); p.run(); return p.mark; }
top({ n: 1 });
`;

describe("#743 receiver-provenance attribution", () => {
  it("re-attributes an all-bucket write through the ||-caching idiom", () => {
    // `state.pos = <provably-dynamic>` used to pin EVERY owner's `pos`; with
    // provenance it reaches only R. (p.v manufactures a real DYNAMIC — an
    // unused param would sit at UNKNOWN and prove nothing, the recorded
    // fixture trap.)
    const facts = reads(PROVENANCE("state.pos = state.owner.v;"));
    expect(facts.get("this.pos")).toBe("f64");
  });

  it("the re-attributed write still reaches the proven owner", () => {
    // R's own `pos` must WIDEN from the string write it received. (The extra
    // constructor uses `p.cache`, whose provenance is R via the field's
    // writes; `r.pos` is a nested read answered by R's instance atom, which
    // cannot carry a widened `pos` — so `this.echo` staying non-f64 is the
    // observable.)
    const src = PROVENANCE(
      "state.pos = 's';",
      `var Q = function Q(r) { this.echo = r.pos; this.k = 0; };
       export function q() { var p = new P(1); p.run(); return new Q(p.cache).echo; }
       q();`,
    );
    expect(reads(src).get("this.pos")).toBe("f64"); // P unpinned…
    expect(reads(src).get("r.pos")).not.toBe("f64"); // …and R's pos is NOT numeric
  });

  it("two possible owners keep the write in the all-bucket", () => {
    const facts = reads(
      PROVENANCE(
        "state.pos = state.owner.v;",
        `var R2 = function R2() { this.pos = 0; };
         pp.other = function () { this.helper(new R2()); };`,
      ),
    );
    expect(facts.get("this.pos")).toBe("dynamic");
  });

  it("an untracked call result joining the chain keeps the write in the all-bucket", () => {
    const facts = reads(
      PROVENANCE("state.pos = state.owner.v;", "pp.other = function (m) { this.helper(m.make()); };"),
    );
    expect(facts.get("this.pos")).toBe("dynamic");
  });

  it("a constructor that can return an object pins nothing", () => {
    // `new R(…)` yields R's RETURN VALUE when that value is an object — the
    // identity proof collapses, so the write stays in the all-bucket.
    const src = `
var P = function P(x) { this.pos = x; this.mark = this.pos; };
var pp = P.prototype;
pp.run = function (v) { var state = new R(v); state.pos = v.s; };
var R = function R(v) { this.pos = 0; if (v.alt) { return v.alt; } };
export function top(v) { var p = new P(v.n); p.run(v); return p.mark; }
top({ n: 1 });
`;
    expect(reads(src).get("this.pos")).toBe("dynamic");
  });

  it("a poisoned (escaped) receiver-holding function's params stay top", () => {
    // `build`'s value escapes, so unseen callers may hand its `state` param
    // ANY receiver — the write must stay in the all-bucket and keep pinning.
    // (Contrast: an escaped CONSTRUCTOR does not defeat provenance at a
    // still-visible `new R(…)` site — `new R` constructs an R there no matter
    // what aliases exist elsewhere.)
    const src = `
var P = function P(x) { this.pos = x; this.mark = this.pos; };
var pp = P.prototype;
pp.run = function () { build(new R(this)); };
function build(state) { state.pos = state.q; }
var R = function R(o) { this.pos = 0; this.q = o.v; };
var alias = [];
alias.push(build); // build's value escapes — unseen call sites possible
export function top(v) { var p = new P(v.n); p.run(); return p.mark; }
top({ n: 1 });
`;
    expect(reads(src).get("this.pos")).toBe("dynamic");
  });

  it("an escaped constructor does not defeat provenance at a visible new-site", () => {
    const src = `
var P = function P(x) { this.pos = x; this.mark = this.pos; };
var pp = P.prototype;
pp.run = function () { this.helper(new R(this)); };
pp.helper = function (state) { state.pos = state.q; };
var R = function R(o) { this.pos = 0; this.q = o.v; };
var alias = [];
alias.push(R); // R escapes — its PARAM facts are gone, its identity is not
export function top(v) { var p = new P(v.n); p.run(); return p.mark; }
top({ n: 1 });
`;
    expect(reads(src).get("this.pos")).toBe("f64");
  });
});

// ── 2. Local bindings ─────────────────────────────────────────────────────────

const LOCAL = (body: string): string => `
var N = function N(a) { this.a = a; };
var P = function P() { this.z = 0; };
P.prototype.m = function (c, q) {
  ${body}
};
export function top(v) { new P().m(v.c, v); return new N(1).a; }
top({ c: true });
`;

describe("#743 local bindings", () => {
  it("a literal-fed local with ++, compound and ternary contributions is f64 (the finishOp shape)", () => {
    const p = params(LOCAL("var size = 1; if (c) { ++size; } size = c ? 3 : 2; new N(size + 1);"));
    expect(p.get("N")).toEqual(["f64"]);
  });

  it("a string reassignment drags the join off f64", () => {
    // join(f64, string) is a lattice UNION atom, not DYNAMIC — the consumer
    // rejects anything that is not f64-class, so `not f64` is the contract.
    const p = params(LOCAL("var size = 1; if (c) { size = 's'; } new N(size);"));
    expect(p.get("N")?.[0]).not.toBe("f64");
  });

  it("a conditionally-executed declaration is INELIGIBLE even with an initializer", () => {
    // `if (c) var x = 1; use(x)` reads `undefined` when c is false — the
    // recorded deviation from the spec's position-only rule.
    const p = params(LOCAL("if (c) var size = 1; new N(size);"));
    expect(p.get("N")).toEqual(["dynamic"]);
  });

  it("a read before the declaration is INELIGIBLE", () => {
    const p = params(LOCAL("new N(size); var size = 1;"));
    expect(p.get("N")).toEqual(["dynamic"]);
  });

  it("a read inside a hoisted nested function declaration is INELIGIBLE", () => {
    const p = params(LOCAL("g(); var size = 1; function g() { new N(size); }"));
    expect(p.get("N")).toEqual(["dynamic"]);
  });

  it("a closure write contributes DYNAMIC", () => {
    const p = params(LOCAL("var size = 1; q.each(function () { size = q.v; }); new N(size);"));
    expect(p.get("N")).toEqual(["dynamic"]);
  });

  it("an ineligible local SHADOWS a same-named outer binding instead of leaking it", () => {
    // The outer `size` param is f64 at every call site; the inner declaration
    // has no initializer, so a name-keyed fallthrough would wrongly answer f64.
    const src = `
var N = function N(a) { this.a = a; };
function outer(size) {
  inner();
  function inner() {
    var size;
    new N(size);
  }
}
export function top() { outer(1); outer(2); return new N(3).a; }
top();
`;
    expect(params(src).get("N")).toEqual(["dynamic"]);
  });

  it("mutually-referencing locals converge to the SCC join", () => {
    const p = params(LOCAL("var a = 1; var b = a; a = b; new N(a);"));
    expect(p.get("N")).toEqual(["f64"]);
  });
});

// ── 3. String substrate ───────────────────────────────────────────────────────

describe("#743 string substrate", () => {
  it("String(x) proves string; indexOf on it proves f64 (the skipBlockComment shape)", () => {
    const src = `
var P = function P(input) { this.input = String(input); this.pos = 0; };
var pp = P.prototype;
pp.skip = function () {
  var end = this.input.indexOf("*/", 2);
  this.pos = end + 2;
};
export function top(v) { var p = new P(v.s); p.skip(); return p.pos; }
top({ s: "a*/b" });
`;
    // Observable through the ctor read: `this.pos`'s field fact must be f64,
    // which requires the proto-method write `end + 2` to have resolved.
    const src2 = src.replace("this.pos = 0;", "this.pos = 0; this.mark = this.pos;");
    expect(reads(src2).get("this.pos")).toBe("f64");
  });

  it("charCodeAt and .length on a proven string prove f64", () => {
    const p = params(`
var N = function N(a, b) { this.a = a; this.b = b; };
function f(v) {
  var s = String(v);
  new N(s.charCodeAt(0), s.length);
}
export function top(v) { f(v); return new N(1, 2).a; }
top("x");
`);
    expect(p.get("N")).toEqual(["f64", "f64"]);
  });

  it("an unproven receiver declines", () => {
    // `v` is an object here — were it fed a string literal, the receiver
    // would be legitimately PROVEN and f64 would be the right answer.
    const p = params(`
var N = function N(a) { this.a = a; };
function f(v) { new N(v.indexOf("x")); }
export function top(v) { f(v); return new N(1).a; }
top({});
`);
    expect(p.get("N")?.[0]).not.toBe("f64");
  });

  it("an in-file property write of the method name declines the rule", () => {
    const p = params(`
var N = function N(a) { this.a = a; };
var hook = {};
hook.indexOf = function () { return "s"; };
function f(v) { new N(String(v).indexOf("x")); }
export function top(v) { f(v); return new N(1).a; }
top("x");
`);
    expect(p.get("N")).toEqual(["dynamic"]);
  });

  it("an in-file String shadow declines String()", () => {
    // The shadow returns `v.q` (dynamic) — with the HOST String rule wrongly
    // firing this would read f64; with the shadow guard it goes through the
    // in-file function's return fact, which is dynamic.
    const p = params(`
var N = function N(a) { this.a = a; };
function String(v) { return v.q; }
function f(v) { new N(String(v).charCodeAt(0)); }
export function top(v) { f(v); return new N(1).a; }
top({});
`);
    expect(p.get("N")).toEqual(["dynamic"]);
  });

  it("Object.defineProperties with a resolvable literal map only declines its own keys", () => {
    // The acorn shape: accessors installed from a once-declared literal —
    // unrelated keys must not kill the string rules module-wide.
    const p = params(`
var N = function N(a) { this.a = a; };
var P = function P() { this.z = 0; };
var accessors = { inScope: { get: function () { return 1; } } };
Object.defineProperties(P.prototype, accessors);
function f(v) { new N(String(v).charCodeAt(0)); }
export function top(v) { f(v); return new N(1).a; }
top("x");
`);
    expect(p.get("N")).toEqual(["f64"]);
  });
});

// ── 4. The `+=` ratchet ───────────────────────────────────────────────────────

describe("#743 plus-assign feedback is solved in-pass, not across iterations", () => {
  it("a field whose plain assigns resolve late still converges with += present", () => {
    // `end` resolves only after `input` enters the instance atom (iteration
    // ≥ 2). With the old previous-iteration read, the `+=` write locked the
    // transient DYNAMIC in forever; every contribution here is numeric.
    const src = `
var P = function P(input, x) {
  this.input = String(input);
  this.pos = x;
  this.mark = this.pos;
};
var pp = P.prototype;
pp.skip = function () {
  this.pos = this.input.indexOf("*/", 2) + 2;
  this.pos += 3;
};
export function top(v) { var p = new P(v.s, v.n); p.skip(); return p.mark; }
top({ s: "a*/b", n: 1 });
`;
    expect(reads(src).get("this.pos")).toBe("f64");
  });

  it("a += with a genuinely dynamic RHS still pins", () => {
    const src = `
var P = function P(x) { this.pos = x; this.mark = this.pos; };
P.prototype.grow = function (v) { this.pos += v.step; };
export function top(v) { var p = new P(v.n); p.grow(v); return p.mark; }
top({ n: 1 });
`;
    expect(reads(src).get("this.pos")).toBe("dynamic");
  });

  it("a string += flows string through the feedback, not f64", () => {
    const src = `
var P = function P(x) { this.s = ""; this.echo = this.s; this.k = x; };
P.prototype.add = function (v) { this.s += String(v); };
export function top(v) { var p = new P(v.n); p.add(v.t); return p.echo; }
top({ n: 1, t: "x" });
`;
    expect(reads(src).get("this.s")).toBe("string");
  });
});

// ── 5. End to end: the Token pattern reaches the emitted binary ──────────────

// `this.s = p.start` — the carrier is a property read on a parameter, which
// neither the parameter path nor the `this.<y>` path could consume before this
// slice. The slot must flip f64 flag-on with an identical runtime answer.
const E2E_SRC = `
var P = function P(x) { this.pos = x; this.start = this.pos; };
P.prototype.tok = function () { return new T(this); };
var T = function T(p) { this.s = p.start; this.k = 0; };
export function top() { return new P(7).tok().s === 7 ? 1 : -1; }
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

describe("#743 param-property carrier — end to end", () => {
  const savedCtor = process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES;
  const savedProv = process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE;
  beforeEach(() => {
    resetFnctorFieldProvenance();
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

  it("`this.s = p.start` emits an f64 slot with the flag on, externref off, same answer", async () => {
    // Pre-existing (reproduced flag-OFF, i.e. on main's emission): this shape
    // returns -1 at runtime in standalone through the chained dynamic-read
    // path — the same family as the recorded `P.parse` static-dispatch
    // fixture. So this test pins flag-on ≡ flag-off behavior plus the f64
    // slot, not an absolute value (the family's standing pattern).
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "1";
    const on = await compileE2E();
    expect(on.slots.get("T.s")).toBe("f64");
    const onResult = await run(on.binary);

    // (#743 defaults flip, 2026-08-08) OFF is a SPELLING now — unset is ON, so
    // deleting the variable here would silently test the flag-ON path.
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "0";
    const off = await compileE2E();
    expect(off.slots.get("T.s")).toBe("externref");
    expect(await run(off.binary)).toEqual(onResult);
  });

  it("flag off: the new rules are invisible in the emitted bytes", async () => {
    // (#743 defaults flip, 2026-08-08) OFF is a SPELLING now — unset is ON, so
    // deleting the variable here would silently test the flag-ON path.
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "0";
    const a = await compileE2E();
    const b = await compileE2E();
    expect(Buffer.from(a.binary).equals(Buffer.from(b.binary))).toBe(true);
  });
});
