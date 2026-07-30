// #2671 (ES2015 builtin residual) — JSON.stringify array-replacer PropertyList
// fidelity (§25.5.2.1 step 4.b.iv / SerializeJSONObject step 6).
//
// Three host-runtime bugs in the array-form replacer ("property allowlist"):
//   1. PropertyList keys absent from a (possibly nested) object were emitted
//      with a zero-value default instead of being dropped — the live walk's
//      `_liveGet` invoked a module-global `__sget_<key>` getter on a struct
//      lacking that field, which returns `0`/`null` rather than `undefined`.
//      `JSON.stringify({a:{b:2,c:3}}, ['c','b','a'])` produced
//      `{"c":0,"b":0,"a":{"c":3,"b":2,"a":null}}` instead of `{"a":{"c":3,"b":2}}`.
//   2. The PropertyList was not de-duplicated (`['key','key']` kept both).
//   3. String/Number *wrapper objects* (`new String`/`new Number`) as array
//      elements were ignored instead of being ToString'd into keys.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

describe("#2671 — JSON.stringify array replacer (PropertyList)", () => {
  it("orders top-level keys by the replacer array", async () => {
    const exp = await run(`return JSON.stringify({b: 1, a: 2, c: 3}, ['c', 'b', 'a']);`);
    expect(exp.test()).toBe('{"c":3,"b":1,"a":2}');
  });

  it("applies the PropertyList to nested objects and drops absent keys", async () => {
    // Regression: absent keys ('c','b' at top; 'a' nested) must be dropped, not
    // emitted with a default 0/null.
    const exp = await run(`return JSON.stringify({a: {b: 2, c: 3}}, ['c', 'b', 'a']);`);
    expect(exp.test()).toBe('{"a":{"c":3,"b":2}}');
  });

  it("de-duplicates repeated keys in the replacer array", async () => {
    const exp = await run(`return JSON.stringify({key: 1, other: 2}, ['key', 'key']);`);
    expect(exp.test()).toBe('{"key":1}');
  });

  it("coerces Number wrapper-object elements via ToString", async () => {
    const exp = await run(`return JSON.stringify({10: 1, x: 2}, [new Number(10)]);`);
    expect(exp.test()).toBe('{"10":1}');
  });

  it("coerces String wrapper-object elements via ToString", async () => {
    const exp = await run(`return JSON.stringify({foo: 1, bar: 2}, [new String('foo')]);`);
    expect(exp.test()).toBe('{"foo":1}');
  });

  it("ignores boolean/null array elements (only String/Number contribute keys)", async () => {
    const exp = await run(`return JSON.stringify({a: 1, b: 2}, ['a', true as any, null as any]);`);
    expect(exp.test()).toBe('{"a":1}');
  });

  it("no replacer still serializes every own key (no regression)", async () => {
    const exp = await run(`return JSON.stringify({b: 1, a: 2, c: 3});`);
    expect(exp.test()).toBe('{"b":1,"a":2,"c":3}');
  });

  it("object getters still serialize (live walk reads accessor own props)", async () => {
    const exp = await run(`return JSON.stringify({ get a() { return 5; }, b: 7 });`);
    expect(exp.test()).toBe('{"a":5,"b":7}');
  });
});

// §25.5.2.1 step 4 — when `Type(replacer)` is Object and `IsCallable(replacer)`
// is false, only an *array* replacer (`IsArray` true) becomes a PropertyList;
// EVERY other replacer (a plain object, a String/Number wrapper object, or a
// non-object primitive) is silently ignored, so the value serializes in full.
// The regression: a plain object literal `{}` reached the host as a WasmGC
// struct, and `_wasmToPlain` mis-materialised it as `[]` (an empty vec, because
// `__vec_len` returns 0 for a non-vec struct), yielding an empty PropertyList
// that wrongly filtered out every own key — `JSON.stringify(obj, {})` produced
// `"{}"` instead of the full serialization. (test262
// built-ins/JSON/stringify/replacer-wrong-type.js.)
describe("#2671 — JSON.stringify wrong-type replacer is silently ignored", () => {
  const FULL = '{"key":[1]}';

  it("a plain object replacer `{}` is ignored (regression — was `{}`)", async () => {
    const exp = await run(`return JSON.stringify({key: [1]}, {} as any);`);
    expect(exp.test()).toBe(FULL);
  });

  it("a non-empty plain object replacer is ignored, not treated as a key list", async () => {
    const exp = await run(`return JSON.stringify({key: [1]}, {key: 0, other: 1} as any);`);
    expect(exp.test()).toBe(FULL);
  });

  it("a String wrapper-object replacer is ignored", async () => {
    const exp = await run(`return JSON.stringify({key: [1]}, new String('str') as any);`);
    expect(exp.test()).toBe(FULL);
  });

  it("a Number wrapper-object replacer is ignored", async () => {
    const exp = await run(`return JSON.stringify({key: [1]}, new Number(6.1) as any);`);
    expect(exp.test()).toBe(FULL);
  });

  it("null / primitive replacers are ignored", async () => {
    expect((await run(`return JSON.stringify({key: [1]}, null as any);`)).test()).toBe(FULL);
    expect((await run(`return JSON.stringify({key: [1]}, '' as any);`)).test()).toBe(FULL);
    expect((await run(`return JSON.stringify({key: [1]}, 0 as any);`)).test()).toBe(FULL);
  });

  it("an empty array replacer still filters everything (genuine PropertyList path)", async () => {
    const exp = await run(`return JSON.stringify({key: [1]}, [] as any);`);
    expect(exp.test()).toBe("{}");
  });

  it("a non-empty array replacer still filters by its keys (no regression)", async () => {
    const exp = await run(`return JSON.stringify({a: 1, b: 2}, ['b'] as any);`);
    expect(exp.test()).toBe('{"b":2}');
  });
});
