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
