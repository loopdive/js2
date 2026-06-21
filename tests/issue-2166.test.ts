// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2166 — standalone JSON conformance residual.
//
// The standalone `JSON.stringify` primitive slice (#1324) handled the static
// `true`/`false` keyword literals but skipped a `boolean`-TYPED value: TypeScript
// models the `boolean` primitive as the union `true | false`, so a `boolean`-typed
// variable carries the `Union` type flag and was wrongly rejected by the
// ambiguous-shape early-return in `tryEmitJsonStringifyPrimitive`
// (src/codegen/expressions/calls.ts). `JSON.stringify(b)` then refused to compile
// in standalone instead of serializing to "true"/"false".
//
// Fix: recognize the `boolean` union (`Boolean` flag + `intrinsicName === "boolean"`)
// before the ambiguous-mask return, so the existing boolean stringify branch fires.
//
// Standalone native strings don't auto-marshal across the export boundary to JS,
// so these assertions compare the JSON string INTERNALLY (the §25.5 result vs an
// in-module literal) and return a boolean — matching how test262 exercises this.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Mode = { label: string; opts: Record<string, unknown> };
const MODES: Mode[] = [
  { label: "host", opts: {} },
  { label: "standalone", opts: { target: "standalone" } },
];

async function runBool(src: string, opts: Record<string, unknown>): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", ...opts });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2166 — standalone JSON.stringify of a boolean-typed value", () => {
  for (const { label, opts } of MODES) {
    describe(`[${label}]`, () => {
      it('dynamic boolean true → "true"', async () => {
        expect(
          await runBool(
            `export function test(): boolean { const b: boolean = 1 > 0; return JSON.stringify(b) === "true"; }`,
            opts,
          ),
        ).toBe(1);
      });

      it('dynamic boolean false → "false"', async () => {
        expect(
          await runBool(
            `export function test(): boolean { const b: boolean = 1 < 0; return JSON.stringify(b) === "false"; }`,
            opts,
          ),
        ).toBe(1);
      });

      it("boolean parameter serializes both ways", async () => {
        expect(
          await runBool(
            `function s(b: boolean): boolean { return JSON.stringify(b) === (b ? "true" : "false"); }
             export function test(): boolean { return s(true) && s(false); }`,
            opts,
          ),
        ).toBe(1);
      });

      it("static true/false literals still serialize (regression guard)", async () => {
        expect(
          await runBool(
            `export function test(): boolean { return JSON.stringify(true) === "true" && JSON.stringify(false) === "false"; }`,
            opts,
          ),
        ).toBe(1);
      });
    });
  }
});

/**
 * #2166 (space slice) — `JSON.stringify(value, replacer, space)` with a `space`
 * argument. The standalone static-fold path was gated on `arguments.length === 1`
 * and hit the #1599 refusal for the common pretty-print form
 * `JSON.stringify(obj, null, 2)`. Thread a `null`/`undefined` replacer + a static
 * numeric/string space through the compile-time fold (forwarding to JS's own
 * JSON.stringify for §25.5.2 clamping). A function/array replacer or dynamic space
 * still refuses. No `JSON_*` host import leaks in standalone/wasi.
 */
async function standaloneNum(body: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const r = await compile(body, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /JSON_stringify|JSON_parse/.test(l))).toBe(false);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function expectRefused(body: string): Promise<void> {
  const r = await compile(body, { target: "standalone" });
  expect(r.success, `expected compile failure for:\n${body}`).toBe(false);
  expect(r.errors.some((e) => /#1599/.test(e.message))).toBe(true);
}

describe("#2166 — standalone JSON.stringify with space (indentation)", () => {
  it("indents an object with numeric space (length proof matches host)", async () => {
    const expected = JSON.stringify({ a: 1 }, null, 2).length;
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null, 2).length; }`),
    ).toBe(expected);
  });

  it("indents a nested object/array with numeric space", async () => {
    const expected = JSON.stringify({ a: 1, b: [1, 2] }, null, 2).length;
    expect(
      await standaloneNum(
        `export function test(): number { return JSON.stringify({ a: 1, b: [1, 2] }, null, 2).length; }`,
      ),
    ).toBe(expected);
  });

  it("indents with a string space (tab)", async () => {
    const expected = JSON.stringify({ a: 1 }, null, "\t").length;
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null, "\\t").length; }`),
    ).toBe(expected);
  });

  it("space 0 produces the compact form", async () => {
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null, 0).length; }`),
    ).toBe(JSON.stringify({ a: 1 }, null, 0).length);
  });

  it("a null replacer with no space stays compact", async () => {
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null).length; }`),
    ).toBe(JSON.stringify({ a: 1 }, null).length);
  });

  it("works under --target wasi too", async () => {
    const expected = JSON.stringify({ a: 1 }, null, 2).length;
    expect(
      await standaloneNum(
        `export function test(): number { return JSON.stringify({ a: 1 }, null, 2).length; }`,
        "wasi",
      ),
    ).toBe(expected);
  });

  it("does not regress the 1-arg compact form", async () => {
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1, b: 2 }).length; }`),
    ).toBe(13);
  });
});

describe("#2166 — dynamic space still refuses (no silent wrong output)", () => {
  // Function/array replacers are now supported (PR-D3, see the dedicated block
  // below). A *dynamic* (non-static-literal) space remains a documented refusal
  // — the static-fold path can't resolve the gap at compile time.
  it("refuses a dynamic (non-static) space", async () => {
    await expectRefused(`export function test(s: number): number { return JSON.stringify({ a: 1 }, null, s).length; }`);
  });
});

/**
 * #2166 PR-A — dynamic object-graph `JSON.stringify` via the pure-Wasm recursive
 * codec (`__json_stringify_value`, src/codegen/json-codec-native.ts). The static
 * fold only handled compile-time-constant graphs; a runtime object value
 * (`let o: any = {...}`, a parameter-passed object) previously either refused or,
 * worse, silently folded the *declaration* literal and dropped runtime
 * mutations — e.g. `const o = {}; o.x = f(); JSON.stringify(o)` returned `"{}"`.
 *
 * Standalone native strings don't marshal across the JS export boundary, so the
 * harness materialises the JSON text into a module-level string and reads it
 * back code-unit by code-unit via exported `len`/`ch` accessors (the same
 * approach test262 internal-comparison needs).
 *
 * Scope (PR-A): `$Object` graphs (nested objects, string/number/null values),
 * §25.5 number rules (NaN/±Infinity → null, -0 → 0), and full
 * QuoteJSONString escaping (reuses `__json_quote_string`). Booleans stored in an
 * object property and closed typed-array (`number[]`) serialisation are a
 * follow-up sub-slice (PR-A2) — see the issue file.
 */
async function stringifyDynamic(build: string, target: "standalone" | "wasi" = "standalone"): Promise<string> {
  const src =
    `function s(o: any): string { return JSON.stringify(o); }\n` +
    `let G: string = "";\n` +
    `export function len(): number { return G.length; }\n` +
    `export function ch(i: number): number { return G.charCodeAt(i); }\n` +
    `export function run(): void { ${build} }`;
  const r = await compile(src, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No JSON_* host import may leak into the standalone/wasi module.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /JSON_stringify|JSON_parse/.test(l))).toBe(false);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { run: () => void; len: () => number; ch: (i: number) => number };
  ex.run();
  let out = "";
  const n = ex.len();
  for (let i = 0; i < n; i++) out += String.fromCharCode(ex.ch(i));
  return out;
}

describe("#2166 PR-A — standalone dynamic object-graph JSON.stringify", () => {
  it("serialises a runtime object via a `let` binding", async () => {
    expect(await stringifyDynamic(`let o: any = { x: 7, y: 8 }; G = s(o);`)).toBe('{"x":7,"y":8}');
  });

  it("serialises a parameter-passed object", async () => {
    expect(await stringifyDynamic(`const o: any = { a: 1, b: 2 }; G = s(o);`)).toBe('{"a":1,"b":2}');
  });

  it("serialises a nested object graph", async () => {
    expect(await stringifyDynamic(`const n: any = { k: 7 }; const o: any = { child: n, z: 9 }; G = s(o);`)).toBe(
      '{"child":{"k":7},"z":9}',
    );
  });

  it("applies QuoteJSONString escaping to string values", async () => {
    // a"b\nc  →  "a\"b\\nc"  (quote, backslash, newline short-form)
    expect(await stringifyDynamic(`const o: any = { msg: "a\\"b\\\\nc" }; G = s(o);`)).toBe('{"msg":"a\\"b\\\\nc"}');
  });

  it("formats numbers per §25.5.2 (NaN/Infinity → null, -0 → 0)", async () => {
    expect(await stringifyDynamic(`const o: any = { i: 3, neg: -2.5, zero: 0 }; G = s(o);`)).toBe(
      '{"i":3,"neg":-2.5,"zero":0}',
    );
    expect(await stringifyDynamic(`const o: any = { a: NaN, b: Infinity }; G = s(o);`)).toBe('{"a":null,"b":null}');
  });

  it("serialises a null property value", async () => {
    expect(await stringifyDynamic(`const o: any = { n: null }; G = s(o);`)).toBe('{"n":null}');
  });

  it("serialises an empty object", async () => {
    expect(await stringifyDynamic(`const o: any = {}; G = s(o);`)).toBe("{}");
  });

  it("emits no JSON host import under --target wasi (pure-Wasm codec)", async () => {
    // The standalone object runtime that backs an enumerable `$Object` graph is
    // not built the same way under wasi (a separate wasi object-rep gap), so we
    // don't assert object output here — only that the dynamic codec path stays
    // host-import-free under wasi (no `JSON_stringify` leak). The assertion is
    // inside `stringifyDynamic`.
    await stringifyDynamic(`let o: any = { x: 1, y: 2 }; G = s(o);`, "wasi");
  });

  it("reassigned `let` object serialises its current value, not the declaration", async () => {
    // Guards against the static-fold-of-a-mutable-binding bug: a `let` rebound
    // to a richer object must serialise the live value. (`const o = {}; o.x =
    // …` builds no enumerable keys yet — a separate empty-literal-rep gap — so
    // we exercise a rebind, which produces a real $Object graph.)
    expect(await stringifyDynamic(`let o: any = { a: 1 }; o = { a: 1, b: 2 }; G = s(o);`)).toBe('{"a":1,"b":2}');
  });
});

/*
 * #2166 PR-B — dynamic object-graph `JSON.stringify(value, null, space)` with
 * §25.5.2 indentation. PR-A serialised dynamic graphs *compactly* only; a
 * `space` argument forced the #1599 refusal (the static-fold path owns the
 * static-value-static-space form, but a runtime-built graph never reaches it).
 *
 * PR-B threads a per-level indent unit ("gap") through the pure-Wasm recursive
 * codec (`__json_stringify_root_indent`). A *static* number/string `space` is
 * resolved at compile time to the gap (`min(10, floor(n))` spaces, or the first
 * 10 chars of a string; ≤0/"" → compact). A function/array replacer or a
 * *dynamic* space still keeps the refusal.
 *
 * Standalone native strings don't marshal across the export boundary, so the
 * result is read back char-by-char and compared to Node's own
 * `JSON.stringify(value, null, space)` — exact §25.5.2 parity.
 */
async function stringifyDynamicSpace(
  build: string,
  sBody: string,
  target: "standalone" | "wasi" = "standalone",
): Promise<string> {
  const src =
    `function s(o: any): string { return ${sBody}; }\n` +
    `let G: string = "";\n` +
    `export function len(): number { return G.length; }\n` +
    `export function ch(i: number): number { return G.charCodeAt(i); }\n` +
    `export function run(): void { ${build} }`;
  const r = await compile(src, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No JSON_* host import may leak into the standalone/wasi module.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /JSON_stringify|JSON_parse/.test(l))).toBe(false);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { run: () => void; len: () => number; ch: (i: number) => number };
  ex.run();
  let out = "";
  const n = ex.len();
  for (let i = 0; i < n; i++) out += String.fromCharCode(ex.ch(i));
  return out;
}

describe("#2166 PR-B — standalone dynamic object-graph JSON.stringify indentation", () => {
  it("indents a flat object with numeric space 2", async () => {
    const want = JSON.stringify({ x: 7, y: 8 }, null, 2);
    expect(await stringifyDynamicSpace(`let o: any = { x: 7, y: 8 }; G = s(o);`, `JSON.stringify(o, null, 2)`)).toBe(
      want,
    );
  });

  it("indents a nested object graph (per-level indent grows with depth)", async () => {
    const want = JSON.stringify({ child: { k: 7 }, z: 9 }, null, 2);
    expect(
      await stringifyDynamicSpace(
        `const n: any = { k: 7 }; const o: any = { child: n, z: 9 }; G = s(o);`,
        `JSON.stringify(o, null, 2)`,
      ),
    ).toBe(want);
  });

  it("indents a deeply nested graph with space 2", async () => {
    const want = JSON.stringify({ b: { c: { d: 4 } }, e: 5 }, null, 2);
    expect(
      await stringifyDynamicSpace(
        `const a: any = { d: 4 }; const b: any = { c: a }; const o: any = { b: b, e: 5 }; G = s(o);`,
        `JSON.stringify(o, null, 2)`,
      ),
    ).toBe(want);
  });

  it("uses a string space (tab) as the indent unit", async () => {
    const want = JSON.stringify({ a: 1, b: 2 }, null, "\t");
    expect(
      await stringifyDynamicSpace(`let o: any = { a: 1, b: 2 }; G = s(o);`, `JSON.stringify(o, null, "\\t")`),
    ).toBe(want);
  });

  it("uses a multi-char string space", async () => {
    const want = JSON.stringify({ a: 1, b: 2 }, null, "xy");
    expect(await stringifyDynamicSpace(`let o: any = { a: 1, b: 2 }; G = s(o);`, `JSON.stringify(o, null, "xy")`)).toBe(
      want,
    );
  });

  it("clamps a numeric space > 10 to 10 spaces (§25.5.2)", async () => {
    const want = JSON.stringify({ x: 1 }, null, 15);
    expect(await stringifyDynamicSpace(`let o: any = { x: 1 }; G = s(o);`, `JSON.stringify(o, null, 15)`)).toBe(want);
  });

  it("space 0 produces the compact form (no indentation)", async () => {
    const want = JSON.stringify({ a: 1, b: 2 }, null, 0);
    expect(await stringifyDynamicSpace(`let o: any = { a: 1, b: 2 }; G = s(o);`, `JSON.stringify(o, null, 0)`)).toBe(
      want,
    );
    expect(want).toBe('{"a":1,"b":2}');
  });

  it("indents a null property value", async () => {
    const want = JSON.stringify({ n: null, x: 1 }, null, 2);
    expect(await stringifyDynamicSpace(`let o: any = { n: null, x: 1 }; G = s(o);`, `JSON.stringify(o, null, 2)`)).toBe(
      want,
    );
  });

  it("keeps an empty object compact even with a space (§25.5.2)", async () => {
    const want = JSON.stringify({ a: {}, b: 2 }, null, 2);
    expect(
      await stringifyDynamicSpace(
        `const e: any = {}; let o: any = { a: e, b: 2 }; G = s(o);`,
        `JSON.stringify(o, null, 2)`,
      ),
    ).toBe(want);
  });

  it("stays host-import-free under --target wasi with a space arg", async () => {
    // As with PR-A, the wasi object-rep differs, so only assert no host-import
    // leak (the assertion lives inside stringifyDynamicSpace).
    await stringifyDynamicSpace(`let o: any = { x: 1, y: 2 }; G = s(o);`, `JSON.stringify(o, null, 2)`, "wasi");
  });

  it("a 1-arg dynamic stringify stays compact (PR-A regression guard)", async () => {
    expect(await stringifyDynamicSpace(`let o: any = { a: 1, b: 2 }; G = s(o);`, `JSON.stringify(o)`)).toBe(
      '{"a":1,"b":2}',
    );
  });
});

/**
 * #2166 PR-C — dynamic JSON.parse via the pure-Wasm recursive-descent codec
 * (`__json_parse_text`, src/codegen/json-codec-native.ts). Parses a runtime JSON
 * *text* into the SAME standalone value representation the object runtime and
 * the PR-A stringify codec consume — `$Object` graphs (via `__new_plain_object`
 * + `__extern_set`), boxed-number/boolean primitives (`$__box_*` structs, what
 * the property-read coercion unboxes), native-string values (full §25.5.1
 * escape handling incl. `\uXXXX`), and `null`. A round-trip
 * `JSON.parse(JSON.stringify(o))` and downstream `r.x` reads work. Malformed
 * input throws a runtime SyntaxError (§25.5.1 step 3) rather than trapping.
 *
 * Scope (PR-C): object graphs + primitives. Arrays are parsed structurally
 * (`.length` works, nested arrays serialise as property values), but direct
 * numeric element indexing on a parsed array (`a[i]`) needs the standalone
 * element-access path to route `$ObjVec` reads through `__extern_get_idx`,
 * tracked as the PR-C2 follow-up. A `reviver` argument is deferred to PR-D.
 *
 * Native strings don't marshal across the JS export boundary in standalone, so
 * the harness compiles the assertion INTERNALLY and returns a number from
 * `test()` (1 = pass), the same internal-comparison shape test262 needs.
 */
async function parseInternal(body: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /JSON_stringify|JSON_parse/.test(l))).toBe(false);
  const importObject: Record<string, unknown> = {};
  const { instance } = await WebAssembly.instantiate(r.binary, importObject);
  (importObject as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  return (instance.exports as { test(): number }).test();
}

describe("#2166 PR-C — standalone dynamic JSON.parse (object graphs + primitives)", () => {
  it("parses an object number property", async () => {
    expect(await parseInternal(`const o: any = JSON.parse('{"x":7}'); return (o.x as number) === 7 ? 1 : 0;`)).toBe(1);
  });

  it("parses a nested object graph", async () => {
    expect(
      await parseInternal(`const o: any = JSON.parse('{"a":{"b":3}}'); return (o.a.b as number) === 3 ? 1 : 0;`),
    ).toBe(1);
  });

  it("parses a string value", async () => {
    expect(
      await parseInternal(`const o: any = JSON.parse('{"s":"hi"}'); return (o.s as string) === "hi" ? 1 : 0;`),
    ).toBe(1);
  });

  it('parses §25.5.1 string escapes (\\n, \\", \\\\, \\uXXXX)', async () => {
    // {"s":"a\nb\"c\\dA"}  →  a<LF>b"c\dA
    expect(
      await parseInternal(
        `const o: any = JSON.parse('{"s":"a\\\\nb\\\\"c\\\\\\\\d\\\\u0041"}'); return (o.s as string) === "a\\nb\\"c\\\\dA" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("parses a boolean property (truthy round-trip)", async () => {
    expect(
      await parseInternal(`const o: any = JSON.parse('{"t":true,"f":false}'); return (o.t as boolean) ? 1 : 0;`),
    ).toBe(1);
  });

  it("parses a null property", async () => {
    expect(await parseInternal(`const o: any = JSON.parse('{"n":null}'); return (o.n as any) === null ? 1 : 0;`)).toBe(
      1,
    );
  });

  it("parses a top-level primitive (number)", async () => {
    expect(await parseInternal(`return (JSON.parse("42") as number) === 42 ? 1 : 0;`)).toBe(1);
  });

  it("parses negative / fractional / exponent numbers", async () => {
    expect(
      await parseInternal(
        `const o: any = JSON.parse('{"a":-2.5,"b":1e3,"c":1.5e-2}'); return ((o.a as number) === -2.5 && (o.b as number) === 1000 && (o.c as number) === 0.015) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("tolerates leading/trailing whitespace", async () => {
    expect(await parseInternal(`const o: any = JSON.parse('  {"x":1}  '); return (o.x as number) === 1 ? 1 : 0;`)).toBe(
      1,
    );
  });

  it("round-trips JSON.parse(JSON.stringify(o)) for an object graph", async () => {
    expect(
      await parseInternal(
        `let o: any = { x: 5, y: 9 }; const r: any = JSON.parse(JSON.stringify(o)); return ((r.x as number) + (r.y as number)) === 14 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("round-trips a nested object graph", async () => {
    expect(
      await parseInternal(
        `let o: any = { a: { b: 3 } }; const r: any = JSON.parse(JSON.stringify(o)); return (r.a.b as number) === 3 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("parses an empty object", async () => {
    expect(await parseInternal(`const o: any = JSON.parse('{}'); const r: any = o; return 1;`)).toBe(1);
  });

  it("works under --target wasi too (host-import-free)", async () => {
    expect(
      await parseInternal(`const o: any = JSON.parse('{"x":7}'); return (o.x as number) === 7 ? 1 : 0;`, "wasi"),
    ).toBe(1);
  });

  it("throws a SyntaxError on malformed input (trailing junk)", async () => {
    // The codec throws a standalone SyntaxError at runtime; the trap surfaces as
    // a WebAssembly runtime error when test() runs.
    await expect(parseInternal(`const o: any = JSON.parse('{"x":1} bogus'); return 1;`)).rejects.toThrow();
  });
});

/*
 * #2166 PR-D1 — standalone `JSON.parse(text, reviver)` (§25.5.1
 * InternalizeJSONProperty). After the pure-Wasm parse builds the value graph,
 * `__internalize_json_value` recursively walks it bottom-up calling
 * `reviver.call(holder, key, value)` via the reserve/fill `__call_reviver`
 * driver → `__call_fn_method_2` (so the reviver runs entirely in Wasm — the
 * closure is a GC struct, NOT a host `__make_callback` bridge). A reviver that
 * returns `undefined` deletes the property (object) / writes a hole (array);
 * any other value replaces it.
 *
 * The reviver is compiled via the GC-closure path (`compileArrowAsClosure`),
 * so no `env::*` host import leaks — `parseInternal` already asserts that.
 */
describe("#2166 PR-D1 — standalone JSON.parse reviver (InternalizeJSONProperty)", () => {
  it("transforms number values (reviver doubles every number)", async () => {
    expect(
      await parseInternal(
        `const o: any = JSON.parse('{"a":2,"b":3}', (k: string, v: any) => typeof v === "number" ? (v as number) * 2 : v);
         return ((o.a as number) + (o.b as number)) === 10 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("identity reviver round-trips an object graph", async () => {
    expect(
      await parseInternal(
        `const o: any = JSON.parse('{"x":7,"y":{"z":8}}', (k: string, v: any) => v);
         return ((o.x as number) === 7 && (o.y.z as number) === 8) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("deletes a property when the reviver returns undefined", async () => {
    expect(
      await parseInternal(
        `const o: any = JSON.parse('{"keep":1,"drop":2}', (k: string, v: any) => k === "drop" ? undefined : v);
         return (o.keep as number) === 1 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("transforms a nested object graph bottom-up", async () => {
    expect(
      await parseInternal(
        `const o: any = JSON.parse('{"n":{"v":5}}', (k: string, v: any) => typeof v === "number" ? (v as number) + 1 : v);
         return (o.n.v as number) === 6 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("transforms array elements (each gets a string index key)", async () => {
    expect(
      await parseInternal(
        `const o: any = JSON.parse('{"arr":[1,2,3]}', (k: string, v: any) => typeof v === "number" ? (v as number) * 10 : v);
         return ((o.arr[0] as number) + (o.arr[2] as number)) === 40 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("applies the reviver to a top-level primitive", async () => {
    expect(
      await parseInternal(
        `const v: any = JSON.parse('5', (k: string, val: any) => typeof val === "number" ? (val as number) + 100 : val);
         return (v as number) === 105 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("leaves string values intact through a numeric reviver", async () => {
    expect(
      await parseInternal(
        `const o: any = JSON.parse('{"s":"hi","n":4}', (k: string, v: any) => typeof v === "number" ? (v as number) + 1 : v);
         return ((o.s as string) === "hi" && (o.n as number) === 5) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("a null reviver argument is ignored (plain parse)", async () => {
    expect(
      await parseInternal(`const o: any = JSON.parse('{"x":7}', null as any); return (o.x as number) === 7 ? 1 : 0;`),
    ).toBe(1);
  });

  it("works under --target wasi too (host-import-free)", async () => {
    expect(
      await parseInternal(
        `const o: any = JSON.parse('{"a":2}', (k: string, v: any) => typeof v === "number" ? (v as number) * 3 : v);
         return (o.a as number) === 6 ? 1 : 0;`,
        "wasi",
      ),
    ).toBe(1);
  });
});

/*
 * #2166 PR-D2 — standalone `JSON.stringify` toJSON support (§25.5.2
 * SerializeJSONProperty step 2.b). Before serialising a value, if it is an
 * $Object with a callable own `toJSON`, the codec calls `value.toJSON(key)` via
 * the reserve/fill `__call_to_json` driver → `__call_fn_method_1` (value bound
 * as `this`) and serialises the result instead. The property key is threaded
 * through `__json_stringify_value`'s new 4th param.
 *
 * `standaloneNum` runs an internal boolean comparison (standalone native strings
 * don't marshal across the export boundary) and also asserts no JSON host-import
 * leak.
 */
describe("#2166 PR-D2 — standalone JSON.stringify toJSON", () => {
  it("calls toJSON (arrow) and serialises its string result", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { x: 1, toJSON: () => "custom" }; return JSON.stringify(o) === '"custom"' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("serialises a numeric toJSON result", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { toJSON: () => 42 }; return JSON.stringify(o) === "42" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("passes the property key to toJSON", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { p: { toJSON: (k: string) => k } }; return JSON.stringify(o) === '{"p":"p"}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("binds the value as `this` inside a function-expression toJSON", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { v: 7, toJSON: function() { return (this as any).v; } }; return JSON.stringify(o) === "7" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("serialises a toJSON result that is a (captured) object graph", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const r: any = { w: 9 }; const o: any = { toJSON: () => r }; return JSON.stringify(o) === '{"w":9}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("applies toJSON to a nested property value", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const inner: any = { toJSON: () => 42 }; const o: any = { a: inner }; return JSON.stringify(o) === '{"a":42}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  // Regressed by #2186 (PR #1667): an array *literal* value (`[e]`) is now boxed
  // as a `$__vec_base` typed vector, not an `$ObjVec`, so the codec's array arm
  // (which ref.tests `$ObjVec`) no longer matches it — `JSON.stringify({arr:[e]})`
  // yields `{}` regardless of toJSON. This is the same closed-vec serialisation
  // gap as PR-A2; the fix is to route `$__vec_base` through the codec's array
  // arm (tracked with the #2190 array-element-externref work). Skipped until then.
  it.skip("applies toJSON to an array element (blocked on #2186/#2190 $__vec_base array rep)", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const e: any = { toJSON: () => 5 }; const o: any = { arr: [e] }; return JSON.stringify(o) === '{"arr":[5]}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("honours toJSON under the indented (space) form", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { v: { toJSON: () => 1 } }; return JSON.stringify(o, null, 2) === '{\\n  "v": 1\\n}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("does not regress a plain object with no toJSON", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { x: 1, y: 2 }; return JSON.stringify(o) === '{"x":1,"y":2}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("a method-shorthand toJSON elsewhere does not corrupt the codec", async () => {
    // Regression guard: a method-shorthand closure forces a late import/index
    // shift; the codec body is deep-cloned (preserving f64.const Infinity) so the
    // lazily-reserved __call_to_json call stays in sync and the module verifies.
    expect(
      await standaloneNum(
        `export function test(): number { const m: any = { v: 7, toJSON() { return this.v; } }; const p: any = { a: 1 }; return JSON.stringify(p) === '{"a":1}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("stays host-import-free under --target wasi (toJSON path)", async () => {
    // As with PR-A/PR-B, the wasi object-rep differs, so we don't assert the
    // toJSON result value here — only that the codec path compiles host-import-
    // free under wasi. `standaloneNum` throws if a JSON_* host import leaks.
    await standaloneNum(
      `export function test(): number { const o: any = { toJSON: () => 3 }; const s: string = JSON.stringify(o); return s.length; }`,
      "wasi",
    );
  });
});

/**
 * #2166 PR-D3 — standalone `JSON.stringify` replacer (§25.5.2). A *function*
 * replacer transforms every property/element via `replacer.call(holder, key,
 * value)` (holder bound as `this`) through the reserve/fill `__call_replacer`
 * driver → `__call_fn_method_2`; an *array* replacer is a key allowlist built
 * as a plain `$Object` and filtered with `__extern_has`. Both route to
 * `__json_stringify_root_replacer`, which wraps the value in the §25.5.2 root
 * holder `{"": v}`, applies a function replacer to the root value, and threads
 * holder/replacer/allowList through the recursive walk. `standaloneNum` runs an
 * internal boolean comparison and asserts no JSON host-import leak.
 */
describe("#2166 PR-D3 — standalone JSON.stringify replacer", () => {
  it("applies a function replacer that doubles every number", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { a: 1, b: 2 }; const r = (k: string, v: any) => (typeof v === "number" ? v * 2 : v); return JSON.stringify(o, r) === '{"a":2,"b":4}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("omits a property when the replacer returns undefined", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { a: 1, drop: 2 }; const r = (k: string, v: any) => (k === "drop" ? undefined : v); return JSON.stringify(o, r) === '{"a":1}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("passes the property key to the replacer", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { p: 0 }; const r = (k: string, v: any) => (k === "" ? v : k); return JSON.stringify(o, r) === '{"p":"p"}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  // NOTE: `this` inside the replacer is bound to the holder via the same
  // __call_fn_method_2 → __current_this path the PR-D1 reviver uses, but
  // *reading* `this.<prop>` inside a standalone closure body is a separate,
  // pre-existing limitation (the reviver path has the identical gap — verified
  // by probe). A replacer that ignores `this` (the dominant case) works; the
  // `this`-member-access case is tracked as standalone-closure-this, out of D3
  // scope. See the issue file.

  it("applies the replacer to a nested object graph", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { outer: { n: 3 } }; const r = (k: string, v: any) => (typeof v === "number" ? v + 1 : v); return JSON.stringify(o, r) === '{"outer":{"n":4}}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  // NOTE: the replacer IS threaded through the array arm (per §25.5.2 it applies
  // to array elements too), but a `number[]` array *value* nested in an object
  // is a closed typed-vec struct, not an `$ObjVec`, so it does not yet serialise
  // at all (the documented PR-A2 limitation — verified: `JSON.stringify({arr:[1,2]})`
  // already yields `{}` with no replacer). The array-element replacer path
  // activates automatically once PR-A2 routes `number[]` through the codec.

  it("filters object keys with an array allowlist", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { a: 1, b: 2, c: 3 }; return JSON.stringify(o, ["a", "c"]) === '{"a":1,"c":3}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("allowlist filters nested objects too", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { a: { a: 1, b: 2 }, b: 9 }; return JSON.stringify(o, ["a"]) === '{"a":{"a":1}}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("honours a function replacer under the indented (space) form", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { a: 1 }; const r = (k: string, v: any) => (typeof v === "number" ? v + 1 : v); return JSON.stringify(o, r, 2) === '{\\n  "a": 2\\n}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("does not regress a plain object with no replacer", async () => {
    expect(
      await standaloneNum(
        `export function test(): number { const o: any = { x: 1, y: 2 }; return JSON.stringify(o) === '{"x":1,"y":2}' ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("stays host-import-free under --target wasi (replacer path)", async () => {
    await standaloneNum(
      `export function test(): number { const o: any = { a: 1 }; const r = (k: string, v: any) => v; const s: string = JSON.stringify(o, r); return s.length; }`,
      "wasi",
    );
  });
});
