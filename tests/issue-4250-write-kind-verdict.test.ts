// (#4250) The whole-program per-field WRITE-KIND VERDICT, in its three roles:
//
//  1. fail-closed gate on the ctor-param SLOT lever (which this issue flips to
//     the family's unset-⇒-ON rule);
//  2. proven-violation veto on the PRE-EXISTING literal slot choice — main's
//     `this.tag = 1; … a.tag = "s"; typeof a.tag` miscompile;
//  3. unsound-fold guard on `typeof <recv>.<field>` — the SECOND defect behind
//     the same repro: even with the slot demoted, the checker-typed fold
//     answered "number" at compile time. The repro needed BOTH.
//
// Every poison pin carries a positive control proving the pin would otherwise
// have narrowed (acceptance criterion 4).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { computeFnctorGraphFieldVerdicts } from "../src/ir/fnctor-method-edges.js";
import { ts } from "../src/ts-api.js";

async function run(source: string, env: Record<string, string> = {}): Promise<unknown> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    const r = await compile(source, {
      fileName: "t.mjs",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
    const module = await WebAssembly.compile(r.binary as Uint8Array);
    expect(WebAssembly.Module.imports(module).length).toBe(0);
    const { exports } = await WebAssembly.instantiate(module, {});
    return (exports as { test(): unknown }).test();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
        delete process.env[k];
      } else process.env[k] = v;
    }
  }
}

// ── The three probed arms answer correctly in EVERY configuration ────────────

describe("#4250 — the filed repros", () => {
  it("literal arm (main's original defect): later string write survives, default config", async () => {
    expect(
      await run(`
var A = function A() { this.tag = 1; };
var a = new A();
a.tag = "s";
export function test() { return typeof a.tag === "string" ? 1 : 0; }
`),
    ).toBe(1);
  });

  it("literal arm positive control: with no violating write the value round-trips numerically", async () => {
    expect(
      await run(`
var A = function A() { this.tag = 1; };
var a = new A();
a.tag = 7;
export function test() { return typeof a.tag === "number" && a.tag === 7 ? 1 : 0; }
`),
    ).toBe(1);
  });

  it("param arm: correct with the (now default-ON) slot lever", async () => {
    expect(
      await run(`
var A = function A(n) { this.tag = n; };
var a = new A(1);
a.tag = "s";
export function test() { return typeof a.tag === "string" ? 1 : 0; }
`),
    ).toBe(1);
  });

  it("field-fact arm: correct with the slot lever", async () => {
    expect(
      await run(`
var A = function A(n) { this.pos = n; this.mark = this.pos; };
var a = new A(1);
a.mark = "s";
export function test() { return typeof a.mark === "string" ? 1 : 0; }
`),
    ).toBe(1);
  });

  it("the literal fix survives an unrelated module-wide poison (raw-join split)", async () => {
    // A dictionary-object computed write elsewhere in the module trips the
    // cannot-see poison; the guarded verdict goes DYNAMIC everywhere, but the
    // ENUMERATED string write is still positive evidence — a poison adds
    // unseen writes, it never erases seen ones. acorn-shaped modules have ~20
    // such dictionary writes; without the raw/guarded split the repro fix
    // silently vanished in exactly those modules.
    expect(
      await run(`
var A = function A() { this.tag = 1; };
var a = new A();
a.tag = "s";
export function stash(dict, k, v) { dict[k] = v; }
stash({}, "x", 1);
export function test() { return typeof a.tag === "string" ? 1 : 0; }
`),
    ).toBe(1);
  });

  it("boolean violation of a numeric-literal slot: typeof answers boolean", async () => {
    expect(
      await run(`
var A = function A() { this.tag = 1; };
var a = new A();
a.tag = true;
export function test() { return typeof a.tag === "boolean" ? 1 : 0; }
`),
    ).toBe(1);
  });
});

// ── Verdict unit surface ──────────────────────────────────────────────────────

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

function verdict(source: string, owner: string, field: string): string | undefined {
  const { checker, file } = fixture(source);
  return computeFnctorGraphFieldVerdicts(file, { checker }).get(owner)?.get(field)?.kind;
}

// A tracked owner whose `tag` is seeded numerically; each case appends the
// write under test. `use(v.q)` shapes manufacture provably-DYNAMIC values (an
// unused param sits at UNKNOWN and proves nothing — the family's recorded
// fixture trap).
const BASE = `
var A = function A() { this.tag = 1; this.k = 2; };
var a = new A();
export function keep(v) { return new A().tag; }
keep({});
`;

describe("#4250 — verdict poison classes (each with its positive control)", () => {
  it("positive control: only numeric writes → f64", () => {
    expect(verdict(`${BASE} a.tag = 7;`, "A", "tag")).toBe("f64");
  });

  it("a string write through an in-module helper (all-bucket flow) widens", () => {
    expect(verdict(`${BASE} function h(x) { x.tag = "s"; } h(a);`, "A", "tag")).not.toBe("f64");
  });

  it("computed-key write on a provenance-pinned receiver poisons that owner", () => {
    const src = `${BASE} function h(k) { a[k] = 1; } h("tag");`;
    expect(verdict(src, "A", "tag")).toBe("dynamic");
    // …and only that owner:
    const two = `
var B = function B() { this.other = 3; };
var b = new B();
export function kb() { return new B().other; }
kb();
${src}`;
    expect(verdict(two, "B", "other")).toBe("f64");
  });

  it("computed-key write on an unknowable receiver poisons everything", () => {
    expect(verdict(`${BASE} export function h(x, k) { x[k] = 1; } h(a, "tag");`, "A", "k")).toBe("dynamic");
  });

  it("computed-key write on a builtin instance poisons nothing", () => {
    expect(verdict(`${BASE} function h(k) { var e = new SyntaxError("x"); e[k] = 1; } h("tag");`, "A", "tag")).toBe(
      "f64",
    );
  });

  it("delete through a binding poisons the name", () => {
    expect(verdict(`${BASE} delete a.tag;`, "A", "tag")).toBe("dynamic");
  });

  it("Object.defineProperty on a binding poisons the literal key (and only it)", () => {
    const src = `${BASE} Object.defineProperty(a, "tag", { get: function () { return "s"; } });`;
    expect(verdict(src, "A", "tag")).toBe("dynamic");
    expect(verdict(src, "A", "k")).toBe("f64");
  });

  it("Object.assign on a binding poisons all of that owner's fields", () => {
    const src = `${BASE} export function h(src) { Object.assign(a, src); } h({});`;
    expect(verdict(src, "A", "tag")).toBe("dynamic");
    expect(verdict(src, "A", "k")).toBe("dynamic");
  });
});

// ── The lever's fail-closed vs the literal arm's proven-violation asymmetry ──

describe("#4250 — fail-closed lever, violation-only literal veto", () => {
  it("an UNPROVEN write blocks the param-slot lever (fail closed)…", async () => {
    // `v.q` is dynamic; the ctor param is proven f64 by its call site, but the
    // verdict cannot bound the later write, so the slot must stay boxed and
    // the dynamic value must round-trip.
    expect(
      await run(`
var A = function A(n) { this.tag = n; };
var a = new A(1);
export function poke(v) { a.tag = v.q; }
poke({ q: "s" });
export function test() { return typeof a.tag === "string" ? 1 : 0; }
`),
    ).toBe(1);
  });

  it("…while the pre-existing literal arm keeps its slot on an unproven write (recorded asymmetry)", async () => {
    // Violation-only: demoting every long-shipped checker-typed slot with a
    // merely-unproven same-named write would be a mass de-optimization with no
    // observed defect. The residual exposure equals main's pre-#4250 exposure.
    // Observable: the value coerces at the store (NaN), exactly as before.
    expect(
      await run(`
var A = function A() { this.tag = 1; };
var a = new A();
export function poke(v) { a.tag = v.q; }
poke({ q: 2 });
export function test() { return a.tag === 2 ? 1 : 0; }
`),
    ).toBe(1);
  });
});

// ── Kill switch ───────────────────────────────────────────────────────────────

describe("#4250 — JS2WASM_FIELD_WRITE_VERDICT=0 restores pre-#4250 behaviour", () => {
  it("literal repro reverts to the old wrong answer with the verdict disabled", async () => {
    expect(
      await run(
        `
var A = function A() { this.tag = 1; };
var a = new A();
a.tag = "s";
export function test() { return typeof a.tag === "string" ? 1 : 0; }
`,
        { JS2WASM_FIELD_WRITE_VERDICT: "0" },
      ),
    ).toBe(0);
  });
});
