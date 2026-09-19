// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6632 (#5383 S46) — a `T | undefined` slot (a class field, or a struct
// field reached through the generic dynamic member-get dispatcher) reads back
// as JS `null` instead of `undefined` in two codegen sites under
// `--target standalone` (native strings).
//
// Root cause: `resolveWasmType`'s single-kind nullable-union collapse gives
// `string | undefined` the SAME wasm carrier as `string | null` — a bare
// `ref_null $AnyString` — because a wasm `ref.null` cannot itself distinguish
// "the JS value is null" from "the JS value is absent" (#4741 already fixed
// this ambiguity for the generic `coerceType` ref/ref_null → externref row:
// a null `$AnyString` resurrects as the canonical `undefined` extern). Two
// OTHER call sites box a `ref_null $AnyString` field to externref WITHOUT
// going through that #4741 arm, so they still republish the null as host
// `null`:
//
//  1. `compileTypeofExpression` (typeof-delete.ts) — the ref/ref_null operand
//     branch called `extern.convert_any` directly instead of routing through
//     `coerceType`, so `typeof (v: string | undefined)` on an absent class
//     field answered "object" instead of "undefined".
//  2. The generic dynamic member-get dispatcher (`__get_member_<name>`,
//     member-get-dispatch.ts) — used for a COMPUTED-key read (`obj[key]`, the
//     route `TemporalHelpers.canonicalizeCalendarEra`'s reduction takes) as
//     opposed to a statically-typed direct field access. Its per-candidate
//     box step called `coercionInstrs(ctx, fieldType, {kind:"externref"})`
//     with NO `FunctionContext`, so the #4741 arm (which lives in the
///    push-style `coerceType` engine and needs a temp local) was unreachable;
//     the bare `extern.convert_any` row ran instead.
//
// Both fixes route through the SAME `canonicalUndefinedExternInstrs`
// resurrection used by #4741, scoped exactly to the `ref_null $AnyString`
// carrier (never touching a genuinely-`T | null` field, which correctly stays
// `null`/"object").
//
// NOTE (S46 handback): fixing these two sites is NOT sufficient to flip the
// two named test262 rows (`Temporal/PlainDate/from/argument-object-valid.js`,
// `argument-string.js`) — see the S46 findings in
// plan/issues/5383-standalone-temporal-provider.md for the reduction that
// shows the actual failing read goes through the fully-dynamic `$Object`
// `__extern_get`/`__extern_set` hashtable (a THIRD site, not yet fixed) when
// the receiver object's static type is `any` (a polymorphic
// `Calendar.isoToDate` interface method return). This test file covers only
// the two verified, scoped fixes above.

import { describe, expect, it } from "vitest";
import { compileMulti, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

async function runStandalone(body: string): Promise<string> {
  const entry = "/__main.js";
  const result = await compileMulti(
    {
      [entry]:
        `let __s = "";\n` +
        `export function prepare() { try { ${body} } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n` +
        `export function at(i) { return __s.charCodeAt(i); }\n`,
    },
    entry,
    { allowJs: true, skipSemanticDiagnostics: true, canonicalRuntimeTypes: true, ...STANDALONE } as never,
  );
  if (!result.success) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const { instance } = await instantiateLinkedProject(result, {});
  const exports = instance.exports as unknown as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

async function runCrossModule(files: Record<string, string>, entry: string): Promise<string> {
  const result = await compileMulti(files, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    canonicalRuntimeTypes: true,
    ...STANDALONE,
  } as never);
  if (!result.success) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const { instance } = await instantiateLinkedProject(result, {});
  const exports = instance.exports as unknown as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

describe("#6632 (#5383 S46) — string | undefined slot resurrection", () => {
  it("typeof a class field typed string|undefined, absent value: 'undefined' not 'object'", async () => {
    const out = await runStandalone(`
      class D { era: string | undefined; constructor(e: string | undefined) { this.era = e; } }
      const d = new D(undefined);
      __s = typeof d.era;
    `);
    expect(out).toBe("undefined");
  });

  it("typeof a class field typed string|undefined, present value: 'string'", async () => {
    const out = await runStandalone(`
      class D { era: string | undefined; constructor(e: string | undefined) { this.era = e; } }
      const d = new D("hi");
      __s = typeof d.era;
    `);
    expect(out).toBe("string");
  });

  it("CONTROL: typeof a class field typed string|null, null value stays 'object'", async () => {
    const out = await runStandalone(`
      class D { era: string | null; constructor(e: string | null) { this.era = e; } }
      const d = new D(null);
      __s = typeof d.era;
    `);
    expect(out).toBe("object");
  });

  it("CONTROL: typeof a plain string field: 'string'", async () => {
    const out = await runStandalone(`
      class D { era: string; constructor(e: string) { this.era = e; } }
      const d = new D("x");
      __s = typeof d.era;
    `);
    expect(out).toBe("string");
  });

  it("CONTROL: typeof a class field typed number|undefined, absent value: 'undefined' (pre-existing f64 undefSentinel path, unaffected)", async () => {
    const out = await runStandalone(`
      class D { age: number | undefined; constructor(e: number | undefined) { this.age = e; } }
      const d = new D(undefined);
      __s = typeof d.age;
    `);
    expect(out).toBe("undefined");
  });

  it("a dynamic (computed-key) read of a string|undefined field, absent value, via the generic member-get dispatcher: typeof is 'undefined'", async () => {
    const out = await runStandalone(`
      class D { era: string | undefined; constructor(e: string | undefined) { this.era = e; } }
      const d = new D(undefined);
      const k = "era";
      const v = (d as any)[k];
      __s = typeof v;
    `);
    expect(out).toBe("undefined");
  });

  it("=== undefined / == null semantics on the resurrected value", async () => {
    const out = await runStandalone(`
      class D { era: string | undefined; constructor(e: string | undefined) { this.era = e; } }
      const d = new D(undefined);
      const k = "era";
      const v = (d as any)[k];
      __s = (v === undefined ? "strict-undef" : "no") + "|" + (v == null ? "loose-null" : "no");
    `);
    expect(out).toBe("strict-undef|loose-null");
  });

  it("cross-module: a getter returning string|undefined resurrects correctly through the link boundary", async () => {
    const out = await runCrossModule(
      {
        "/provider.js": `
          export class D {
            _era;
            constructor(e) { this._era = e; }
            get era() { return this._era; }
          }
        `,
        "/__main.js": `
          import { D } from "./provider.js";
          let __s = "";
          export function prepare() {
            try {
              const d = new D(undefined);
              const t1 = typeof d.era;
              const t2 = (d.era === undefined) ? "eq" : "neq";
              __s = t1 + ":" + t2;
            } catch (e) { __s = "!" + (e && e.message ? e.message : e); }
            return __s.length;
          }
          export function at(i) { return __s.charCodeAt(i); }
        `,
      },
      "/__main.js",
    );
    expect(out).toBe("undefined:eq");
  });
});
