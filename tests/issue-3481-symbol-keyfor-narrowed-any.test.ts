// #3481 Symbol cluster — `Symbol.keyFor` on a NARROWED `any` operand.
//
// A symbol VALUE lowers to an i32 id (`mapTsTypeToWasm`: `symbol` → i32), so
// `Symbol.keyFor` has an id-keyed host arm (`__symbol_keyFor_id`) that fires
// when the operand is STATICALLY a symbol. The static type is not the same
// question as the physical representation, and TypeScript makes them diverge:
// inside `switch (typeof k) { case "symbol": … }` or `if (typeof k ===
// "symbol")` an `any` binding NARROWS to `symbol` while staying physically an
// `externref` holding a real host Symbol.
//
// The id arm then compiled that operand under an `{kind:"i32"}` hint.
// `compileExpression` HONOURS the hint, so it coerced externref → i32 with
// `__unbox_number` — literally `Number(Symbol())` — and `Symbol.keyFor(k)`
// threw "Cannot convert a Symbol value to a number" instead of answering
// `undefined`.
//
// That is test262's own `harness/temporalHelpers.js`: `formatPropertyName`'s
// `case "symbol":` arm calls `Symbol.keyFor(propertyKey)` on a narrowed `any`
// parameter, which gated every `Array/fromAsync/asyncitems-*` and
// `Iterator/from/*-return-method-*` row in the cluster.
//
// The fix compiles the operand hint-free and dispatches on what it actually
// produced: i32 ⇒ the id helper (unchanged), anything else ⇒ the externref
// host arm. The `narrowed-*` cases below fail on the base compiler; the
// `static-*` and `throws-*` cases are regression guards that pass on both.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures }).test();
}

/** `String(...)` the answer so `undefined` and a key string are both observable. */
const SWITCH_NARROW = `
function keyOf(k: any): any {
  switch (typeof k) {
    case "symbol":
      return String(Symbol.keyFor(k));
    default:
      return "not-a-symbol";
  }
}
`;
const IF_NARROW = `
function keyOf(k: any): any {
  if (typeof k === "symbol") { return String(Symbol.keyFor(k)); }
  return "not-a-symbol";
}
`;

describe("#3481 — Symbol.keyFor on a narrowed `any` operand", () => {
  // The operand is physically an externref here: `keyOf` is also called with a
  // non-symbol, so its parameter cannot be specialised to the i32 id rep.
  for (const [shape, prelude] of [
    ["switch (typeof k)", SWITCH_NARROW],
    ["if (typeof k === …)", IF_NARROW],
  ] as const) {
    describe(shape, () => {
      it("narrowed-any: an UNREGISTERED symbol answers undefined, it does not throw", async () => {
        expect(await run(`${prelude} keyOf("s"); return keyOf(Symbol("q"));`)).toBe("undefined");
      });

      it("narrowed-any: a REGISTERED symbol answers its registry key", async () => {
        expect(await run(`${prelude} keyOf("s"); return keyOf(Symbol.for("regkey"));`)).toBe("regkey");
      });

      it("narrowed-any: a WELL-KNOWN symbol answers undefined", async () => {
        expect(await run(`${prelude} keyOf("s"); return keyOf(Symbol.asyncIterator);`)).toBe("undefined");
      });

      it("narrowed-any: a non-symbol still takes the default arm", async () => {
        expect(await run(`${prelude} return keyOf(7);`)).toBe("not-a-symbol");
      });
    });
  }

  // Regression guards — the operand really IS the i32 id here, so the id-keyed
  // arm must still be selected and must keep answering exactly as before.
  it("static-symbol local: unregistered → undefined", async () => {
    expect(await run(`const s: symbol = Symbol("q"); return String(Symbol.keyFor(s));`)).toBe("undefined");
  });

  it("static-symbol local: registered → its key", async () => {
    expect(await run(`const s: symbol = Symbol.for("k1"); return String(Symbol.keyFor(s));`)).toBe("k1");
  });

  it("static-symbol expression: Symbol.keyFor(Symbol.for(x)) round-trips", async () => {
    expect(await run(`return String(Symbol.keyFor(Symbol.for("k2")));`)).toBe("k2");
  });

  it("static-symbol expression: Symbol.keyFor(Symbol()) → undefined", async () => {
    expect(await run(`return String(Symbol.keyFor(Symbol("q")));`)).toBe("undefined");
  });

  it("registry identity survives: Symbol.for(k) === Symbol.for(k)", async () => {
    expect(await run(`const a: symbol = Symbol.for("id"); const b: symbol = Symbol.for("id"); return a === b;`)).toBe(
      true,
    );
  });

  it("throws-guard: a plain `any` (unnarrowed) non-symbol still raises the spec TypeError", async () => {
    expect(
      await run(
        `const v: any = 7; try { Symbol.keyFor(v); return "no-throw"; } catch (e: any) { return e.constructor.name; }`,
      ),
    ).toBe("TypeError");
  });

  it("throws-guard: a narrowed-any non-symbol reaching keyFor still raises TypeError", async () => {
    // `typeof k === "symbol"` is false, so this never enters the id arm — the
    // host `Symbol.keyFor` produces the spec TypeError itself.
    expect(
      await run(
        `function f(k: any): any { try { return String(Symbol.keyFor(k)); } catch (e: any) { return e.constructor.name; } } f(Symbol("a")); return f({});`,
      ),
    ).toBe("TypeError");
  });
});
