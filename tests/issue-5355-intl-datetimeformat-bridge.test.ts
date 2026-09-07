// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5355 — `Intl.DateTimeFormat` was a SHELL.
//
// #5206 delivered the `Intl` GLOBAL: it made the ambient `Intl` NAMESPACE
// resolve to the host global object, which fixed every fully dynamic spelling
// (`(Intl as any).DateTimeFormat`, which lowers to `__extern_get` +
// `__construct_closure`). The TYPED spelling — the one ordinary TypeScript and
// the minified `@js-temporal/polyfill` bundle both emit — was untouched and
// still did nothing:
//
//   typeof f                                        "object"     ← a STATIC lie
//   f === undefined                                 true
//   new Intl.DateTimeFormat("en-US").format(d)      undefined    (node: "1/1/1970")
//   …resolvedOptions()                              undefined    (node: object)
//   …formatToParts(d)   single-module: RuntimeError: dereferencing a null pointer
//                       linked lane:   TypeError: invalid receiver
//
// ROOT CAUSE (measured on base, 2026-09-06). `compileNewExpression`
// (src/codegen/expressions/new-super.ts) resolves the constructed class name
// from the checker — for `new Intl.DateTimeFormat(...)` that is the interface
// symbol `DateTimeFormat` — and looks it up in `ctx.externClasses`.
// `extern-declarations.ts` registered `Intl.ListFormat` and `Intl.NumberFormat`
// there but never `Intl.DateTimeFormat`, so the expression fell through EVERY
// arm to the terminal `reportError(… "Unsupported new expression for class")`
// and yielded `undefined`.
//
// The "typeof object but === undefined" paradox is not a value-representation
// bug: `typeof` on a typed expression is constant-folded from the declared TS
// type, which says `Intl.DateTimeFormat`, while the VALUE is `undefined`. The
// two lanes then diverge only in how they fail on that undefined receiver
// (compiled null-deref vs. host-side receiver check) — which is why the fix is
// to make the receiver real, not to unify the failure.
//
// A second symptom the same miss produced: `.format(...)` on the undefined
// receiver name-matched `ListFormat.format` in the extern method tables, so the
// module imported `Intl_ListFormat_format` for a `DateTimeFormat` call.
//
// FIX. Register `Intl.DateTimeFormat` as an extern class exactly like its two
// siblings — the receiver stays an opaque host externref and `format` /
// `formatToParts` / `resolvedOptions` / `formatRange(ToParts)` forward to the
// real ICU-backed host object (#679/#682 dual-backend shape: host fast path).
// Unlike the siblings the registration is gated on the JS-host lane, so no new
// unsatisfiable host import can reach a `--target standalone`/`wasi` binary;
// standalone throws a catchable TypeError naming the bound instead (there is no
// ICU data in pure Wasm — see new-intl-host-bridge.ts).

import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Single-module JS-host lane. */
async function run(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "issue-5355.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>).test!();
}

/**
 * Multi-module (linked) JS-host lane — the constructor is built in one module
 * and consumed in another, which is the shape the Temporal provider link takes.
 * On base this lane answered `undefined` rather than trapping.
 */
async function runLinked(source: string): Promise<unknown> {
  const files: Record<string, string> = {
    "./fmt.ts": `export function makeFormatter(): any {
       return new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });
     }`,
    "./entry.ts": source,
  };
  const result = await compileMulti(files, "./entry.ts", { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>).test!();
}

/** Host-free lane: compile to standalone and assert zero imports before running. */
async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-5355-standalone.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return (instance.exports as Record<string, () => unknown>).test!();
}

describe("#5355 — Intl.DateTimeFormat host-mirror bridge", () => {
  it("constructs a real object, not an undefined typed `object`", async () => {
    // The narrowest statement of the defect. On base: "object|true|true".
    expect(
      await run(`
        export function test(): string {
          const f = new Intl.DateTimeFormat("en-US");
          return typeof f + "|" + String((f as any) === undefined) + "|" + String((f as any) == null);
        }
      `),
    ).toBe("object|false|false");
  });

  it("resolvedOptions() returns the host's resolved options", async () => {
    // On base: "undefined|undefined" (the object itself was undefined).
    expect(
      await run(`
        export function test(): string {
          const r = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).resolvedOptions();
          return String(r.timeZone) + "|" + String(r.calendar);
        }
      `),
    ).toBe("UTC|gregory");
  });

  it("format() returns the formatted string, not undefined", async () => {
    // On base: "undefined" — while `typeof` still statically said "string".
    expect(
      await run(`
        export function test(): string {
          return String(new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(0));
        }
      `),
    ).toBe("1/1/1970");
  });

  it("formatToParts() returns real parts instead of trapping", async () => {
    // On base this TRAPPED: RuntimeError: dereferencing a null pointer.
    expect(
      await run(`
        export function test(): string {
          const parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).formatToParts(0);
          let out = "";
          for (let i = 0; i < parts.length; i++) out += parts[i].type + "=" + parts[i].value + ";";
          return out;
        }
      `),
    ).toBe("month=1;literal=/;day=1;literal=/;year=1970;");
  });

  it("carries a NON-gregorian calendar's parts (the #5249 bound)", async () => {
    // This is the capability the 66 stuck #5249 calendar rows actually need:
    // buddhist / indian / ethiopic / coptic cannot be computed arithmetically,
    // only read out of ICU. A compiled shim could not answer this at all.
    expect(
      await run(`
        export function test(): string {
          const f = new Intl.DateTimeFormat("en-US-u-ca-ethiopic", {
            timeZone: "UTC", era: "short", year: "numeric", month: "numeric", day: "numeric",
          });
          const parts = f.formatToParts(0);
          let out = "";
          for (let i = 0; i < parts.length; i++) out += parts[i].type + "=" + parts[i].value + ";";
          return out + "cal=" + String(f.resolvedOptions().calendar);
        }
      `),
    ).toBe("month=4;literal=/;day=23;literal=/;year=1962;literal= ;era=AM;cal=ethiopic");
  });

  it("does not import Intl_ListFormat_format for a DateTimeFormat call", async () => {
    // The name-collision symptom: with no `DateTimeFormat` extern class, the
    // method lookup fell through to `ListFormat`'s identically-named entry.
    const result = await compile(
      `export function test(): string {
         return String(new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(0));
       }`,
      { fileName: "issue-5355-imports.ts" },
    );
    expect(result.success).toBe(true);
    const names = result.imports.map((entry) => entry.name);
    expect(names).toContain("Intl_DateTimeFormat_new");
    expect(names).toContain("Intl_DateTimeFormat_format");
    expect(names).not.toContain("Intl_ListFormat_format");
  });

  it("works across a module boundary (linked lane)", async () => {
    // On base: "true|undefined|undefined".
    expect(
      await runLinked(`
        import { makeFormatter } from "./fmt.js";
        export function test(): string {
          const f: any = makeFormatter();
          return String(f === undefined) + "|" + String(f.format(0)) + "|" +
            String(f.formatToParts(0).length);
        }
      `),
    ).toBe("false|1/1/1970|5");
  });

  it("keeps the fully dynamic (#5206) spelling working", async () => {
    // Control: this path already worked via `__extern_get`, and must not have
    // been rerouted by the typed registration.
    expect(
      await run(`
        export function test(): string {
          const DTF: any = (Intl as any).DateTimeFormat;
          const f: any = new DTF("en-US", { timeZone: "UTC" });
          return String(f.format(0));
        }
      `),
    ).toBe("1/1/1970");
  });

  it("standalone REFUSES with a catchable TypeError instead of answering undefined", async () => {
    // The declared standalone bound. On base the constructor silently produced
    // `undefined` (this returned 10) and the first method call then trapped —
    // a trap is neither catchable nor diagnosable. There is no ICU in pure
    // Wasm, so refusing is the correct answer, not a placeholder.
    expect(
      await runStandalone(`
        export function test(): number {
          try { const f = new Intl.DateTimeFormat("en-US"); return (f as any) === undefined ? 10 : 11; }
          catch (e: any) { return e instanceof TypeError ? 1 : 2; }
        }
      `),
    ).toBe(1);
  });

  it("leaks no Intl host import into standalone or wasi", async () => {
    // The #2961 no-leak ratchet: the new bridge must not add to the pre-existing
    // ListFormat/NumberFormat leak. (Those two are untouched by this issue.)
    for (const target of ["standalone", "wasi"] as const) {
      const result = await compile(
        `export function test(): string {
           return String(new Intl.DateTimeFormat("en-US").format(0));
         }`,
        { target, fileName: "issue-5355-leak.ts", skipSemanticDiagnostics: true },
      );
      expect(result.success).toBe(true);
      expect(result.imports.map((entry) => entry.name).filter((name) => name.startsWith("Intl_"))).toEqual([]);
      expect(result.errors.filter((error) => error.message.includes("Intl_"))).toEqual([]);
    }
  });
});
