// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2588 — standalone RegExp named-groups result object (`m.groups`) + `$<name>`
 * replacement substitution.
 * #2589 — standalone RegExp `d`-flag match `.indices` array.
 *
 * Both extend the `$__regexp_match_vec` struct (native-regex.ts) with extra
 * result fields built from the same `caps` slots the capture array consumes,
 * with ZERO new host imports (pure standalone / WasmGC).
 *
 * NOTE (#2588 substrate dependency): `m.groups.<name>` reads the STRING value
 * back through the generic standalone any-typed open-object reader, which is the
 * in-flight value-rep substrate (#2580 — string VALUES read back as undefined,
 * numeric values work). So this suite proves the groups OBJECT is materialised
 * (key present, non-null, correct shape) and that `$<name>` substitution + the
 * `d`-flag `.indices` array are fully correct; the `m.groups.<name>` value read
 * unblocks for free once #2580 lands.
 */

/** Compile in standalone mode, returning the run result + any host-import leaks. */
async function standalone(src: string): Promise<{ ok: boolean; run: () => unknown; leaks: string[] }> {
  const r = await compile(src, { target: "standalone" });
  if (!r.success) {
    throw new Error("compile failed: " + r.errors.map((e) => e.message).join("\n"));
  }
  const leaks = r.imports
    .map((i) => `${i.module}::${i.name}`)
    .filter((l) => /^env::__extern|^env::Object_|^wasm:js-string::/.test(l));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { ok: true, run: (instance.exports as { run: () => unknown }).run, leaks };
}

/** Read a standalone-returned native string char-by-char (no JS-string conv). */
async function standaloneString(buildExpr: string): Promise<{ out: string; leaks: string[] }> {
  const source = `
    let g: string = "";
    export function build(): void { g = ${buildExpr}; }
    export function len(): number { return g.length; }
    export function at(i: number): number { return g.charCodeAt(i); }
  `;
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaks = r.imports.map((i) => `${i.module}::${i.name}`).filter((l) => /^env::__extern|^env::Object_/.test(l));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { build: () => void; len: () => number; at: (i: number) => number };
  ex.build();
  let out = "";
  for (let i = 0; i < ex.len(); i++) out += String.fromCharCode(ex.at(i));
  return { out, leaks };
}

describe("#2588 — standalone named-groups result object (m.groups)", () => {
  it("m.groups is a non-null object for a pattern WITH named groups", async () => {
    const { run, leaks } = await standalone(`
      export function run(): number {
        const m = /(?<yr>\\d{4})/.exec("2026");
        if (m === null) return -1;
        return m.groups === undefined ? 0 : 1;
      }
    `);
    expect(run()).toBe(1);
    expect(leaks).toEqual([]);
  });

  it("m.groups is undefined for a pattern WITHOUT named groups", async () => {
    const { run, leaks } = await standalone(`
      export function run(): number {
        const m = /(\\d{4})/.exec("2026");
        if (m === null) return -1;
        return m.groups === undefined ? 99 : 1;
      }
    `);
    expect(run()).toBe(99);
    expect(leaks).toEqual([]);
  });
});

describe("#2588 — standalone $<name> replacement substitution", () => {
  it("$<m>/$<y> swaps named captures", async () => {
    const { out, leaks } = await standaloneString(`"2026-06".replace(/(?<y>\\d{4})-(?<m>\\d{2})/, "$<m>/$<y>")`);
    expect(out).toBe("06/2026");
    expect(leaks).toEqual([]);
  });

  it("$<name> mixed with literal text", async () => {
    const { out } = await standaloneString(`"2026".replace(/(?<y>\\d{4})/, "year=$<y>!")`);
    expect(out).toBe("year=2026!");
  });

  it("$<name> mixed with numbered $1", async () => {
    const { out } = await standaloneString(`"2026".replace(/(?<y>\\d{4})/, "$1-$<y>")`);
    expect(out).toBe("2026-2026");
  });

  it("unknown $<bad> expands to empty (named-groups present, §22.2.6.11)", async () => {
    const { out } = await standaloneString(`"2026".replace(/(?<y>\\d{4})/, "[$<bad>]")`);
    expect(out).toBe("[]");
  });

  it("$< stays literal when the pattern has NO named groups (Annex B)", async () => {
    const { out } = await standaloneString(`"ab".replace(/(a)/, "$<x>")`);
    expect(out).toBe("$<x>b");
  });

  it("$< with no closing > is literal", async () => {
    const { out } = await standaloneString(`"2026".replace(/(?<y>\\d{4})/, "$<y")`);
    expect(out).toBe("$<y");
  });

  it("does not regress $& / $1 substitution", async () => {
    expect((await standaloneString(`"abc".replace(/b/, "[$&]")`)).out).toBe("a[b]c");
    expect((await standaloneString(`"abc".replace(/(b)/, "<$1>")`)).out).toBe("a<b>c");
  });
});

describe("#2589 — standalone d-flag match .indices array", () => {
  it("indices[0] is [start, end] of the whole match", async () => {
    const { run, leaks } = await standalone(`
      export function run(): number {
        const m = /(a)(b)/d.exec("xab") as RegExpExecArray & { indices: number[][] };
        if (m === null) return -1;
        return m.indices[0][0] * 100 + m.indices[0][1];  // 1,3 -> 103
      }
    `);
    expect(run()).toBe(103);
    expect(leaks).toEqual([]);
  });

  it("indices[n] is [start, end] for capture group n", async () => {
    const { run, leaks } = await standalone(`
      export function run(): number {
        const m = /(a)(b)/d.exec("xab") as RegExpExecArray & { indices: number[][] };
        if (m === null) return -1;
        // group1 [1,2], group2 [2,3]
        return m.indices[1][0] * 1000 + m.indices[1][1] * 100 + m.indices[2][0] * 10 + m.indices[2][1];
      }
    `);
    expect(run()).toBe(1223);
    expect(leaks).toEqual([]);
  });

  it("m.indices is undefined when the pattern lacks the d flag", async () => {
    const { run, leaks } = await standalone(`
      export function run(): number {
        const m = /(a)(b)/.exec("xab");
        if (m === null) return -1;
        return (m as { indices?: unknown }).indices === undefined ? 99 : 1;
      }
    `);
    expect(run()).toBe(99);
    expect(leaks).toEqual([]);
  });

  it("an unmatched capture group → indices[n] is undefined", async () => {
    const { run, leaks } = await standalone(`
      export function run(): number {
        const m = /(a)|(b)/d.exec("a") as RegExpExecArray & { indices: (number[] | undefined)[] };
        if (m === null) return -1;
        // group1 matched [0,1]; group2 did not participate → undefined
        if (m.indices[1] === undefined) return 0;
        return m.indices[2] === undefined ? 1 : 2;
      }
    `);
    expect(run()).toBe(1);
    expect(leaks).toEqual([]);
  });
});
