// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5208 — a compiled `Date` reached the host as an opaque `{timestamp}` struct.
//
// A compiled `new Date(e)` is the compiler-owned WasmGC carrier `$__Date`
// (`(struct (field (mut i64)))` — one timestamp, see `ensureDateStruct`). When
// that value crosses to a HOST function it was marshalled by the generic
// struct marshaller `_wrapForHost`, which presents any struct as a data proxy.
// A proxy is not a `Date`: every host operation that needs the time VALUE saw
// an object that ToNumber's to NaN.
//
// MEASURED on base (2026-09-06, this branch's parent = PR #5657):
//
//   Object.prototype.toString.call(new Date(0))   "[object Date]"   ← already OK
//   JSON.stringify({ d: new Date(0) })            {"d":{"timestamp":null}}
//   new Intl.DateTimeFormat(…).formatToParts(0)   real parts        ← already OK
//   …formatToParts(new Date(0))                   RangeError: Invalid time value
//   …format(new Date(0))                          RangeError: Invalid time value
//
// The `formatToParts` row is the one that matters at scale: the minified
// `@js-temporal/polyfill`'s `getCalendarParts` is literally
// `formatToParts(new Date(e))`, and its `catch` rewrites the RangeError into
// `Invalid ISO date` — which is what 66 of the 123 #5249 Temporal calendar rows
// report. Instrumenting `_wrapForHost` and running the 123-row family
// provider-linked showed exactly ONE crossing site for a compiled Date in the
// whole polyfill: `invokeMethod` (the extern-class method-ARGUMENT marshaller)
// called from `HelperBase_getCalendarParts`.
//
// FIX. Materialise the carrier as a real host `Date` at the host boundary,
// leaving the compiled representation untouched (the standalone lane, #1343
// date-native, owns `{timestamp}`). The module already publishes the exact
// discriminator this needs — `__\0js2_is_date` / `__\0js2_date_value`, a
// `ref.test $__Date`, not a duck-type on a `timestamp` field. The host Date is
// identity-cached per carrier and its time value is re-synced from the carrier
// on every crossing, so `===` holds across two crossings AND a compiled-side
// mutation is visible to the next one.
//
// JSON is the same defect at a different boundary: `JSON.stringify` never
// reaches `_wrapForHost`, it flattens through `_wasmToPlain` (fast path) or
// walks `_serializeJSONProperty` (replacer path). Converting the carrier at
// both of those points lets the spec's own §25.5.2.4 step 2 find the real
// `Date.prototype.toJSON`; no Date-specific `toJSON` is synthesised in
// compiled code.

import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Single-module JS-host lane; `test()` runs AFTER instantiation. */
async function run(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "issue-5208.ts", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>).test!();
}

/**
 * Same lane, but the crossing happens DURING module start — before
 * `setInstance` publishes the post-instantiation export view. The #5209 /
 * #5211 series showed that this window has its own marshalling behaviour, so
 * every claim here is asserted at init as well as after it.
 */
async function runAtInit(expr: string): Promise<unknown> {
  return run(`const AT_INIT: string = ${expr};
    export function test(): string { return AT_INIT; }`);
}

/** Multi-module (linked) JS-host lane — the shape the Temporal provider takes. */
async function runLinked(source: string): Promise<unknown> {
  const files: Record<string, string> = {
    "./epoch.ts": `export function makeDate(ms: number): Date { return new Date(ms); }`,
    "./entry.ts": source,
  };
  const result = await compileMulti(files, "./entry.ts", { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>).test!();
}

const FORMAT_TO_PARTS = `
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });
  const parts: any = f.formatToParts(new Date(0));
  let out = "";
  for (let i = 0; i < parts.length; i++) out += parts[i].type + "=" + parts[i].value + ";";
  return out;`;

describe("#5208 — compiled Date crosses to the host as a real Date", () => {
  it("Intl.DateTimeFormat.formatToParts(new Date(0)) returns parts, not RangeError", async () => {
    // The #5249 blocker, verbatim. On base: RangeError: Invalid time value.
    expect(await run(`export function test(): string {${FORMAT_TO_PARTS}}`)).toBe(
      "month=1;literal=/;day=1;literal=/;year=1970;",
    );
  });

  it("…and at init", async () => {
    expect(
      await run(`
        function build(): string {${FORMAT_TO_PARTS}}
        const AT_INIT: string = build();
        export function test(): string { return AT_INIT; }`),
    ).toBe("month=1;literal=/;day=1;literal=/;year=1970;");
  });

  it("…and across a module boundary (linked lane)", async () => {
    expect(
      await runLinked(`
        import { makeDate } from "./epoch.js";
        export function test(): string {
          const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });
          const parts: any = f.formatToParts(makeDate(0));
          let out = "";
          for (let i = 0; i < parts.length; i++) out += parts[i].type + "=" + parts[i].value + ";";
          return out;
        }`),
    ).toBe("month=1;literal=/;day=1;literal=/;year=1970;");
  });

  it("format(new Date(ms)) formats the carrier's own instant", async () => {
    // On base: RangeError. A constant answer would also pass a fixed-epoch
    // check, so use a non-zero instant the carrier alone can supply.
    expect(
      await run(`
        export function test(): string {
          const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });
          return String(f.format(new Date(86400000 * 366)));
        }`),
    ).toBe("1/2/1971");
  });

  it("a NON-gregorian calendar reads the carrier (the #5249 capability)", async () => {
    // getCalendarParts' real shape: an ICU-only calendar, fed a compiled Date.
    expect(
      await run(`
        export function test(): string {
          const f = new Intl.DateTimeFormat("en-US-u-ca-ethiopic", {
            timeZone: "UTC", era: "short", year: "numeric", month: "numeric", day: "numeric",
          });
          const parts: any = f.formatToParts(new Date(0));
          let out = "";
          for (let i = 0; i < parts.length; i++) out += parts[i].type + "=" + parts[i].value + ";";
          return out;
        }`),
    ).toBe("month=4;literal=/;day=23;literal=/;year=1962;literal= ;era=AM;");
  });

  it("JSON.stringify serialises a nested Date as its ISO string", async () => {
    // On base: {"d":{"timestamp":null}} — the raw carrier field, leaked.
    expect(await run(`export function test(): string { return JSON.stringify({ d: new Date(0) }); }`)).toBe(
      '{"d":"1970-01-01T00:00:00.000Z"}',
    );
  });

  it("…at init, JSON.stringify answers undefined — an UNRELATED init-window gap", async () => {
    // Declared bound, not a fix. During the wasm `start` section
    // `JSON.stringify` answers `undefined` for ANY value, Date or not — the
    // plain-object control below fails identically, so this is not the #5208
    // carrier defect and is deliberately left alone here. Measured 2026-09-06
    // on this branch, before and after the fix. (`formatToParts` at init IS
    // fixed — see above — because its blocker was the #5193 export window,
    // which this PR closes for the Date bridge exports.)
    expect(await runAtInit(`JSON.stringify({ d: new Date(0) })`)).toBeUndefined();
    expect(await runAtInit(`JSON.stringify({ d: 1 })`)).toBeUndefined();
  });

  it("JSON.stringify serialises a bare Date, an array of Dates, and an invalid Date", async () => {
    // §25.5.2.4 step 2 → Date.prototype.toJSON, which answers null for a Date
    // whose time value is NaN. Nothing Date-specific is added to the compiled
    // side; converting the carrier lets the spec's own step find toJSON.
    expect(
      await run(`
        export function test(): string {
          return JSON.stringify(new Date(0)) + "|" +
            JSON.stringify([new Date(0), new Date(86400000)]) + "|" +
            JSON.stringify({ d: new Date(NaN) });
        }`),
    ).toBe('"1970-01-01T00:00:00.000Z"|["1970-01-01T00:00:00.000Z","1970-01-02T00:00:00.000Z"]|{"d":null}');
  });

  it("JSON.stringify with a function replacer takes the live walk and still sees a Date", async () => {
    // The replacer path never reaches `_wasmToPlain`; it walks
    // `_serializeJSONProperty`, whose step 2 must find `Date.prototype.toJSON`
    // on the marshalled value. On base the replacer received the raw carrier
    // and the output was {"d":{"timestamp":null}}.
    expect(
      await run(`
        export function test(): string {
          return JSON.stringify({ d: new Date(0) }, function (k: any, v: any): any { return v; });
        }`),
    ).toBe('{"d":"1970-01-01T00:00:00.000Z"}');
  });

  it("Object.prototype.toString.call(new Date(0)) is [object Date]", async () => {
    // Regression guard, not a new fix: this repro from the issue already held
    // on this branch's base. Pinned so the marshalling change cannot undo it.
    expect(await run(`export function test(): string { return Object.prototype.toString.call(new Date(0)); }`)).toBe(
      "[object Date]",
    );
  });

  it("the fully dynamic spelling was never broken and stays working (control)", async () => {
    // Measured on base: `(Intl as any).DateTimeFormat` + `f.format(new Date(0))`
    // already answered "1/1/1970". That spelling lowers to
    // `__extern_method_call`, a DIFFERENT marshaller from the typed
    // extern-class one this PR changes — which is why the scope stayed on the
    // typed path the polyfill actually takes rather than widening to both.
    expect(
      await run(`
        export function test(): string {
          const DTF: any = (Intl as any).DateTimeFormat;
          const f: any = new DTF("en-US", { timeZone: "UTC" });
          return String(f.format(new Date(0)));
        }`),
    ).toBe("1/1/1970");
  });

  it("the compiled representation is unchanged — getTime/valueOf still read the carrier", async () => {
    // The standalone lane (#1343 date-native) owns `{timestamp}`; the fix is a
    // host-boundary marshal, so compiled-side reads must be untouched.
    expect(
      await run(`
        export function test(): string {
          const d = new Date(1234567890000);
          return String(d.getTime()) + "|" + String(d.valueOf()) + "|" + String(+d);
        }`),
    ).toBe("1234567890000|1234567890000|1234567890000");
  });

  it("a compiled-side mutation is visible to the NEXT crossing", async () => {
    // The host Date is identity-cached per carrier, so it must be re-synced
    // from the carrier's timestamp on each crossing rather than frozen at the
    // first one.
    expect(
      await run(`
        export function test(): string {
          const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });
          const d = new Date(0);
          const before = String(f.format(d));
          d.setUTCFullYear(1999);
          return before + "|" + String(f.format(d));
        }`),
    ).toBe("1/1/1970|1/1/1999");
  });

  it("keyed-collection identity for a Date is unchanged", async () => {
    // Scope guard. `_wrapForHost` caches its host view per struct, so a
    // marshaller that minted a fresh `Date` per crossing would be an identity
    // regression wherever the host compares by reference — which is why
    // `_marshalWasmDateForHost` caches too. Map/Set take their own
    // keyed-collection arm (untouched here); this pins that the change did not
    // disturb it.
    expect(
      await run(`
        export function test(): string {
          const d = new Date(0);
          const s: any = new Set();
          s.add(d);
          const m: any = new Map();
          m.set(d, 7);
          return String(s.has(d)) + "|" + String(s.size) + "|" + String(m.get(d));
        }`),
    ).toBe("true|1|7");
  });
});
