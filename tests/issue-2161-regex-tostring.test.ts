// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2161 — standalone `RegExp.prototype.toString()` (§22.2.6.14).
 *
 * The spec result is `"/" + R.[[OriginalSource]] + "/" + R.[[OriginalFlags]]`,
 * i.e. `"/" + re.source + "/" + re.flags`. Both `re.source` (the struct's
 * spec-escaped §22.2.6.13.1 source field) and `re.flags` (built from the flag
 * bitfield by `__regex_flags_str`) already resolve natively in standalone mode,
 * but `re.toString()` itself was not wired — it fell through to the generic
 * object path and leaked `env::Object_toString` (an unsatisfiable host import in
 * `--target standalone`). This slice composes the two native field reads with
 * `__str_concat`, returning a native string with ZERO host imports.
 *
 * Deferred (separate string-coercion paths, NOT this method-call dispatch):
 *   - `String(re)` (the `String()` builtin lowering) and
 *   - `` `${re}` `` (template-literal coercion)
 *   both route through value→string coercion, not `re.toString()`, and still
 *   need RegExp-aware coercion. Tracked under #2161.
 */
async function standaloneString(buildExpr: string): Promise<string> {
  const source = `
    let g: string = "";
    export function build(): void { g = ${buildExpr}; }
    export function len(): number { return g.length; }
    export function at(i: number): number { return g.charCodeAt(i); }
  `;
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No JS-host import may leak in standalone — in particular Object_toString.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  for (const re of [/^env::Object_toString$/, /^env::__extern_toString$/, /^wasm:js-string::/, /^env::__extern_get$/]) {
    expect(
      labels.filter((l) => re.test(l)),
      `leaked ${re}`,
    ).toEqual([]);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { build: () => void; len: () => number; at: (i: number) => number };
  ex.build();
  let out = "";
  for (let i = 0; i < ex.len(); i++) out += String.fromCharCode(ex.at(i));
  return out;
}

describe("#2161 — standalone RegExp.prototype.toString()", () => {
  it("renders /source/flags for a flagged literal", async () => {
    expect(await standaloneString("(/ab/gi).toString()")).toBe("/ab/gi");
  });

  it("renders /source/ with no flags", async () => {
    expect(await standaloneString("(/x/).toString()")).toBe("/x/");
  });

  it("renders the empty pattern as /(?:)/ (§22.2.6.13.1)", async () => {
    expect(await standaloneString('(new RegExp("")).toString()')).toBe("/(?:)/");
  });

  it("keeps an escaped slash in the source", async () => {
    expect(await standaloneString("(/a\\/b/).toString()")).toBe("/a\\/b/");
  });

  it("works on a const-bound RegExp receiver", async () => {
    expect(await standaloneString("(() => { const re = /foo/m; return re.toString(); })()")).toBe("/foo/m");
  });

  it("renders all flags in canonical d-g-i-m-s-u-y order", async () => {
    // §22.2.6.4 orders flags hasIndices(d) global(g) ignoreCase(i) multiline(m)
    // dotAll(s) unicode(u) sticky(y). (v is mutually exclusive with u.)
    expect(await standaloneString("(/a/dgimsy).toString()")).toBe("/a/dgimsy");
  });

  it("matches the host JS RegExp.prototype.toString() exactly", async () => {
    for (const [pat, flags] of [
      ["abc", ""],
      ["a.c", "g"],
      ["\\d+", "gi"],
      ["", "m"],
    ] as Array<[string, string]>) {
      const lit = `new RegExp(${JSON.stringify(pat)}, ${JSON.stringify(flags)})`;
      const got = await standaloneString(`(${lit}).toString()`);
      const ref = new RegExp(pat, flags).toString();
      expect(got, `${lit}`).toBe(ref);
    }
  });
});
