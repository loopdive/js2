// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2161 — standalone `String(re)` + template-literal `` `${re}` `` RegExp→string
 * coercion (§22.2.6.14).
 *
 * `re.toString()` (the method-call form) already renders `"/" + re.source + "/"
 * + re.flags` natively (slice 7), but the value→string COERCION paths did not
 * route through it:
 *   - `String(re)` — the `String()` builtin lowering null-deref'd on the
 *     `$NativeRegExp` struct (the generic ref→string `coerceType` path).
 *   - `` `${re}` `` — the native template-literal path fell through to
 *     `$__any_to_string`, yielding `"[object Object]"`.
 * Both now route to the shared `emitStandaloneRegExpToStringFromExpr` core,
 * returning the spec `"/source/flags"` string with ZERO host imports.
 */

/** Compile `build()` to set a module-global string, read it back char-by-char. */
async function standaloneString(buildExpr: string): Promise<{ out: string; leaks: string[] }> {
  const source = `
    let g: string = "";
    export function build(): void { g = ${buildExpr}; }
    export function len(): number { return g.length; }
    export function at(i: number): number { return g.charCodeAt(i); }
  `;
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No JS-host import may leak in standalone — in particular the generic object
  // toString / extern coercion bridges that the coercion path would have used.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  const leaks = labels.filter((l) =>
    /^env::Object_toString$|^env::__extern_toString$|^env::__extern_get$|^wasm:js-string::/.test(l),
  );
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { build: () => void; len: () => number; at: (i: number) => number };
  ex.build();
  let out = "";
  for (let i = 0; i < ex.len(); i++) out += String.fromCharCode(ex.at(i));
  return { out, leaks };
}

describe("#2161 — standalone String(re) coercion", () => {
  it("String(/ab/gi) → /ab/gi", async () => {
    const { out, leaks } = await standaloneString("String(/ab/gi)");
    expect(out).toBe("/ab/gi");
    expect(leaks).toEqual([]);
  });

  it("String(/x/) (no flags) → /x/", async () => {
    const { out, leaks } = await standaloneString("String(/x/)");
    expect(out).toBe("/x/");
    expect(leaks).toEqual([]);
  });

  it('String(new RegExp("")) → /(?:)/ (§22.2.6.13.1 empty source)', async () => {
    const { out, leaks } = await standaloneString('String(new RegExp(""))');
    expect(out).toBe("/(?:)/");
    expect(leaks).toEqual([]);
  });

  it("String(/a\\/b/) preserves the escaped slash", async () => {
    const { out, leaks } = await standaloneString("String(/a\\/b/)");
    expect(out).toBe("/a\\/b/");
    expect(leaks).toEqual([]);
  });

  it("String(re) on a const-bound receiver", async () => {
    const { out, leaks } = await standaloneString("(() => { const rc = /zz/m; return String(rc); })()");
    expect(out).toBe("/zz/m");
    expect(leaks).toEqual([]);
  });

  it("renders the canonical dgimsy flag order", async () => {
    const { out } = await standaloneString("String(/p/dgimsy)");
    expect(out).toBe("/p/dgimsy");
  });

  it("matches host-JS String(re) exactly across pattern/flag pairs", async () => {
    for (const [expr, host] of [
      ["String(/foo/)", String(/foo/)],
      ["String(/foo/g)", String(/foo/g)],
      ["String(/a.b/is)", String(/a.b/is)],
      ["String(/\\d+/gimsuy)", String(/\d+/gimsuy)],
    ] as const) {
      const { out } = await standaloneString(expr);
      expect(out, expr).toBe(host);
    }
  });
});

describe("#2161 — standalone template-literal `${re}` coercion", () => {
  it("`x${/abc/gi}y` → x/abc/giy", async () => {
    const { out, leaks } = await standaloneString("`x${/abc/gi}y`");
    expect(out).toBe("x/abc/giy");
    expect(leaks).toEqual([]);
  });

  it("`<${/foo/}>` (flagless span) → </foo/>", async () => {
    const { out, leaks } = await standaloneString("`<${/foo/}>`");
    expect(out).toBe("</foo/>");
    expect(leaks).toEqual([]);
  });

  it("a leading RegExp span with no head text", async () => {
    const { out } = await standaloneString("`${/p/dgimsy}`");
    expect(out).toBe("/p/dgimsy");
  });

  it("two RegExp spans in one template", async () => {
    const { out, leaks } = await standaloneString("`${/a/g}-${/b/i}`");
    expect(out).toBe("/a/g-/b/i");
    expect(leaks).toEqual([]);
  });

  it("template on a const-bound receiver", async () => {
    const { out } = await standaloneString("(() => { const rc = /zz/m; return `[${rc}]`; })()");
    expect(out).toBe("[/zz/m]");
  });

  it("matches host-JS template coercion exactly", async () => {
    for (const [expr, host] of [
      ["`<${/foo/}>`", `<${/foo/}>`],
      ["`${/a.b/is}`", `${/a.b/is}`],
      ["`p=${/\\w+/gu};`", `p=${/\w+/gu};`],
    ] as const) {
      const { out } = await standaloneString(expr);
      expect(out, expr).toBe(host);
    }
  });
});
