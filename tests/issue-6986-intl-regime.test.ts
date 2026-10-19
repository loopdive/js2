// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6986 — Intl on the native semantic regime. With `hostAccelerators: ["intl"]`
// the host Intl is called through the JS value boundary (native strings, options
// bags, Dates and host arrays marshalled); without it, a build that has no host
// Intl rejects `Intl` at compile time instead of failing silently at run time.

import { describe, expect, it } from "vitest";
import { classifyHostImport } from "../src/host-import-policy.js";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

type Options = Parameters<typeof compile>[1];
const INTL: Options = { semanticProviders: "native-first", hostAccelerators: ["intl"] };
const REGIME: Options = { semanticProviders: "native-first" };

async function run(source: string, options: Options) {
  const result = await compile(source, { fileName: "issue-6986.ts", ...options });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const exports = wrapCompiledExports(result, instance) as Record<string, () => unknown>;
  return { result, value: exports.run!() };
}

async function compileErrors(source: string, options: Options): Promise<string> {
  const result = await compile(source, { fileName: "issue-6986.ts", ...options });
  expect(result.success).toBe(false);
  return result.errors.map((error) => error.message).join("\n");
}

describe("#6986 `intl` host accelerator on the native regime", () => {
  const cases: ReadonlyArray<readonly [string, string, () => unknown]> = [
    [
      "NumberFormat with a currency options bag",
      `export function run(): string { return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(1234.5); }`,
      () => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(1234.5),
    ],
    [
      "Number.prototype.toLocaleString(locale)",
      `export function run(): string { return (1234.5).toLocaleString("de-DE"); }`,
      () => (1234.5).toLocaleString("de-DE"),
    ],
    [
      "Date.prototype.toLocaleDateString(locale, options)",
      `export function run(): string { return new Date(0).toLocaleDateString("en-US", { timeZone: "UTC" }); }`,
      () => new Date(0).toLocaleDateString("en-US", { timeZone: "UTC" }),
    ],
    [
      "Collator.compare",
      `export function run(): number { return new Intl.Collator("de").compare("ä", "z"); }`,
      () => new Intl.Collator("de").compare("ä", "z"),
    ],
    [
      "String.prototype.localeCompare(that, locale)",
      `export function run(): number { return "ä".localeCompare("z", "de"); }`,
      () => "ä".localeCompare("z", "de"),
    ],
    [
      "BigInt.prototype.toLocaleString(locale)",
      `export function run(): string { return (12345n).toLocaleString("de-DE"); }`,
      () => 12345n.toLocaleString("de-DE"),
    ],
    [
      "DateTimeFormat.format(compiled Date)",
      `export function run(): string { return new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(new Date(0)); }`,
      () => new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(new Date(0)),
    ],
    [
      "ListFormat",
      `export function run(): string { return new Intl.ListFormat("en", { type: "conjunction" }).format(["a", "b", "c"]); }`,
      () => new Intl.ListFormat("en", { type: "conjunction" }).format(["a", "b", "c"]),
    ],
    [
      "PluralRules / RelativeTimeFormat",
      `export function run(): string { return new Intl.PluralRules("en").select(1) + "|" + new Intl.RelativeTimeFormat("en").format(-1, "day"); }`,
      () => `${new Intl.PluralRules("en").select(1)}|${new Intl.RelativeTimeFormat("en").format(-1, "day")}`,
    ],
    [
      "formatToParts (host array → native vector) and resolvedOptions",
      `export function run(): string {
         const parts = new Intl.NumberFormat("en-US").formatToParts(1234.5);
         const fmt = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2 });
         return parts.length + ":" + parts[0].type + ":" + fmt.resolvedOptions().locale + ":" + fmt.format(3);
       }`,
      () => {
        const parts = new Intl.NumberFormat("en-US").formatToParts(1234.5);
        const fmt = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2 });
        return `${parts.length}:${parts[0]!.type}:${fmt.resolvedOptions().locale}:${fmt.format(3)}`;
      },
    ],
    [
      "Intl namespace / static functions",
      `export function run(): string {
         return Intl.getCanonicalLocales(["EN-us"])[0] + ":" + Intl.NumberFormat.supportedLocalesOf(["en"]).length;
       }`,
      () => `${Intl.getCanonicalLocales(["EN-us"])[0]}:${Intl.NumberFormat.supportedLocalesOf(["en"]).length}`,
    ],
  ];

  for (const [label, source, expected] of cases) {
    it(`matches the host: ${label}`, async () => {
      expect((await run(source, INTL)).value).toBe(expected());
    });
  }

  it("classifies every emitted Intl import as the `intl` host accelerator", async () => {
    const { result } = await run(
      `export function run(): string {
         return new Intl.NumberFormat("en-US").format(1) + (2).toLocaleString("en-US") + Intl.getCanonicalLocales("en")[0];
       }`,
      INTL,
    );
    const intlImports = result.imports.filter((entry) => /Intl|__intl_/.test(entry.name));
    expect(intlImports.map((entry) => entry.name).sort()).toEqual([
      "Intl_NumberFormat_format",
      "Intl_NumberFormat_new",
      "__intl_static_getCanonicalLocales",
      "__intl_toLocaleString",
    ]);
    for (const entry of intlImports) {
      expect(classifyHostImport(entry, "javascript", ["intl"])).toMatchObject({
        classification: "host-accelerator",
        family: "intl",
      });
      expect(classifyHostImport(entry, "javascript").classification).not.toBe("legacy-semantic");
    }
  });
});

describe("#6986 no host Intl: a compile error, never a silent run-time failure", () => {
  const uses = [
    `export function run(): string { return new Intl.NumberFormat("en-US").format(1); }`,
    `export function run(): number { return new Intl.Collator("de").compare("a", "b"); }`,
    `export function run(): string { return typeof Intl; }`,
    `export function run(): number { return Intl.DateTimeFormat.supportedLocalesOf(["en"]).length; }`,
  ];

  it("native-first in a JS environment names --host-accelerator intl", async () => {
    for (const source of uses) {
      const errors = await compileErrors(source, REGIME);
      expect(errors).toContain("--host-accelerator intl");
      expect(errors).toContain("native semantic regime");
    }
  });

  it("standalone and WASI name the missing ICU data and the accelerator", async () => {
    for (const target of ["standalone", "wasi"] as const) {
      for (const source of uses) {
        const errors = await compileErrors(source, { target });
        expect(errors).toContain(`is not available in --target ${target}`);
        expect(errors).toContain("--host-accelerator intl");
      }
    }
  });

  it("keeps what needs no host Intl: the ListFormat prelude, type positions, a local `Intl`", async () => {
    const listFormat = `export function run(): string { return new Intl.ListFormat("en").format(["a", "b"]); }`;
    expect((await run(listFormat, REGIME)).value).toBe(new Intl.ListFormat("en").format(["a", "b"]));
    expect((await run(listFormat, REGIME)).result.imports.some((entry) => entry.name.startsWith("Intl_"))).toBe(false);
    const typeOnly = `export function run(): number { const o: Intl.NumberFormatOptions = { minimumFractionDigits: 1 }; return o.minimumFractionDigits!; }`;
    expect((await run(typeOnly, REGIME)).value).toBe(1);
    const shadowed = `const Intl = { tag: 7 }; export function run(): number { return Intl.tag; }`;
    expect((await run(shadowed, REGIME)).value).toBe(7);
    expect((await run(shadowed, { target: "standalone" })).result.success).toBe(true);
  });

  it("the regime without the accelerator keeps its native locale-free stand-ins (no Intl import)", async () => {
    // ECMA-262's implementation-defined fallback (no grouping). With a locale
    // argument the native path still answers null — a native-provider gap, not an
    // Intl import, recorded in the issue as a follow-up.
    const { result, value } = await run(`export function run(): string { return (1234.5).toLocaleString(); }`, REGIME);
    expect(value).toBe("1234.5");
    expect(result.imports.some((entry) => /Intl|__intl_/.test(entry.name))).toBe(false);
  });

  it("leaves the host-assisted lane's Intl untouched", async () => {
    const source = `export function run(): string { return new Intl.NumberFormat("en-US").format(1234.5); }`;
    const { result, value } = await run(source, { semanticProviders: "host-assisted" }); // (#6708) no longer the default
    expect(value).toBe("1,234.5");
    expect(
      result.imports
        .map((entry) => entry.name)
        .filter((name) => name.startsWith("Intl_"))
        .sort(),
    ).toEqual(["Intl_NumberFormat_format", "Intl_NumberFormat_new"]);
  });
});
