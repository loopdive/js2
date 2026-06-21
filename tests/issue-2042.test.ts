import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2042 PR-A — standalone `Object.defineProperty` with a non-string (numeric)
// key must not trap `illegal cast`.
//
// The standalone `$Object` runtime is string-keyed: `__obj_insert` does
// `ref.cast $AnyString` on the incoming key. The defineProperty call sites
// compile the key with the `{ externref }` hint, which boxes a *number* literal
// (`Object.defineProperty(o, 0, …)`) as a boxed-number externref rather than a
// string — that boxed number then traps `illegal cast` in `__obj_insert`.
//
// PR-A ToPropertyKeys the key (ToString for everything but Symbols) at the call
// site so a numeric key reaches `__obj_insert` as its canonical decimal string
// ("0", "5"). PR-B (ValidateAndApply / descriptor-default semantics, value
// readback, enumeration) is a separate senior follow-up — this test asserts
// only that the define no longer traps and that the string-key path is
// unregressed. (Standalone enumeration / `getOwnPropertyNames` over a
// defineProperty'd key is itself not yet supported — #1472 Phase B / PR-B — so
// it is intentionally NOT exercised here.)

async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2042 standalone Object.defineProperty key cast", () => {
  it("numeric key define does not trap illegal cast", async () => {
    // Before PR-A this threw `illegal cast` at runtime inside __obj_insert.
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, 0, { value: 5 });
          return 1;
        }`,
      ),
    ).toBe(1);
  });

  it("a larger numeric key define does not trap", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, 5, { value: 9, enumerable: true, writable: true, configurable: true });
          return 1;
        }`,
      ),
    ).toBe(1);
  });

  it("numeric key define with an accessor descriptor does not trap", async () => {
    // The accessor branch (emitExternDefinePropertyNoValue) gets the same
    // key-stringification; a numeric key there must not trap either.
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, 0, { get() { return 5; } });
          return 1;
        }`,
      ),
    ).toBe(1);
  });

  it("string key define still round-trips (regression guard)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "foo", { value: 7 });
          const v: any = o.foo;
          return (v === 7) ? 1 : 0;
        }`,
      ),
    ).toBe(1);
  });

  it("a string numeric-looking key does not trap", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "0", { value: 5 });
          return 1;
        }`,
      ),
    ).toBe(1);
  });
});

// #2042 S1 — central `__to_property_key` coercion at the top of `__obj_find` /
// `__obj_hash` / `__obj_insert`. PR-A only ToPropertyKey'd the
// `Object.defineProperty` call site; every OTHER caller (computed numeric member
// access `o[0]`, `Reflect.get(o, 1)`, `getOwnPropertyDescriptor(o, 0)`,
// `delete o[0]`, `0 in o`) still fed a boxed number straight into the
// `ref.cast $AnyString` and trapped `illegal cast [in __obj_find()]`. S1 coerces
// the key ONCE in the runtime so the downstream cast is always safe — numeric
// keys become their canonical decimal string ("0"/"1.5"), matching `{0:x}`
// literal-key storage.
describe("#2042 S1 standalone numeric-key ToPropertyKey hardening", () => {
  it("numeric computed set + read round-trips (was illegal cast)", async () => {
    expect(await runStandalone(`export function test(): number { const o: any = {}; o[0] = 5; return o[0]; }`)).toBe(5);
  });

  it("numeric literal key read via computed access", async () => {
    expect(await runStandalone(`export function test(): number { const o: any = {0: 7}; return o[0]; }`)).toBe(7);
  });

  it("getOwnPropertyDescriptor with a numeric key does not trap", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          const o: any = {};
          o[0] = 9;
          const d: any = Object.getOwnPropertyDescriptor(o, 0);
          return d.value;
        }`,
      ),
    ).toBe(9);
  });

  it("Reflect.get with a numeric key returns the string-keyed value", async () => {
    expect(
      await runStandalone(`export function test(): number { const o: any = {1: 8}; return Reflect.get(o, 1); }`),
    ).toBe(8);
  });

  it("non-integer numeric key uses canonical decimal string", async () => {
    expect(
      await runStandalone(`export function test(): number { const o: any = {}; o[1.5] = 4; return o[1.5]; }`),
    ).toBe(4);
  });

  it('o[-0] normalizes to key "0"', async () => {
    expect(await runStandalone(`export function test(): number { const o: any = {}; o[0] = 1; return o[-0]; }`)).toBe(
      1,
    );
  });

  it("`in` with a numeric key does not trap", async () => {
    expect(
      await runStandalone(`export function test(): number { const o: any = {}; o[2] = 1; return (2 in o) ? 1 : 0; }`),
    ).toBe(1);
  });

  it("delete with a numeric key does not trap", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = {}; o[0] = 1; delete o[0]; return (0 in o) ? 1 : 0; }`,
      ),
    ).toBe(0);
  });

  it("string keys remain unregressed alongside the new coercion", async () => {
    expect(await runStandalone(`export function test(): number { const o: any = {}; o.foo = 3; return o.foo; }`)).toBe(
      3,
    );
  });
});
