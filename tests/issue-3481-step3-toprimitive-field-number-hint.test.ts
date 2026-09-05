// #3481 step 3 — `@@toPrimitive` held in a struct FIELD must be dispatched by
// the NUMBER-hint coercion, host-free.
//
// `@@toPrimitive` arrives in three physically different shapes. A sidecar slot
// (`o[Symbol.toPrimitive] = fn`) and a struct METHOD
// (`{ [Symbol.toPrimitive](hint) {…} }`) both had a dispatch; an object-literal
// computed PROPERTY (`{ [Symbol.toPrimitive]: fn }`) stores the closure in a
// field named `@@toPrimitive` and emits no `${name}_@@toPrimitive` function, so
// `coerceType(ref → f64)` skipped §7.1.1 step 2 for it and fell straight into
// OrdinaryToPrimitive.
//
// Two consequences, and they are what these cases pin:
//  1. `valueOf` WON over `@@toPrimitive` — a plain wrong answer, reachable
//     inside an ordinary function (`Number({[Symbol.toPrimitive]: () => 5,
//     valueOf: () => 7})` was 7).
//  2. At MODULE scope there was no answer at all. Top-level code runs in the
//     wasm START function, before the host is handed `instance.exports`, so the
//     host ToPrimitive walker cannot read any struct field — the whole coercion
//     collapsed to `"[object Object]"` → NaN. Every test262 file is module-level
//     code, so this is the shape that matters there.
//
// The dispatch is compiled (`__objlit_tp_callable` / `__objlit_tp_call` wrapping
// `__call_fn_method_N`), so it also works under `--target standalone`, where
// there is no host at all.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string, options: Record<string, unknown> = {}): Promise<any> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    ...options,
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

/** Evaluate `body` inside an exported function. */
async function inFunction(body: string): Promise<any> {
  const exports = await run(`export function test(): any { ${body} }`);
  return exports.test();
}

/**
 * Evaluate `expr` at MODULE scope — the wasm START function, which runs before
 * `__setExports`. Stashing the result in a global and reading it back through an
 * export is what makes the start-function timing observable from a test.
 */
async function atModuleScope(prelude: string, expr: string): Promise<any> {
  const exports = await run(`${prelude}\nconst __r: any = ${expr};\nexport function test(): any { return __r; }`);
  return exports.test();
}

const TP5 = `{ [Symbol.toPrimitive]: function (): number { return 5; } }`;

describe("#3481 step 3 — @@toPrimitive in a struct field, number hint", () => {
  it("@@toPrimitive beats valueOf (§7.1.1 step 2 before OrdinaryToPrimitive)", async () => {
    expect(
      await inFunction(
        `const o = { [Symbol.toPrimitive]: function (): number { return 5; }, valueOf: function (): number { return 7; } };
         return Number(o as any);`,
      ),
    ).toBe(5);
  });

  it("@@toPrimitive beats toString", async () => {
    expect(
      await inFunction(
        `const o = { [Symbol.toPrimitive]: function (): number { return 5; }, toString: function (): string { return "7"; } };
         return Number(o as any);`,
      ),
    ).toBe(5);
  });

  it("@@toPrimitive beats BOTH valueOf and toString", async () => {
    expect(
      await inFunction(
        `const o = { [Symbol.toPrimitive]: function (): number { return 5; }, valueOf: function (): number { return 7; }, toString: function (): string { return "9"; } };
         return Number(o as any);`,
      ),
    ).toBe(5);
  });

  it("receives the 'number' hint", async () => {
    expect(
      await inFunction(
        `const o = { [Symbol.toPrimitive]: function (hint: string): number { return hint === "number" ? 5 : 9; } };
         return Number(o as any);`,
      ),
    ).toBe(5);
  });

  it("runs with the receiver as `this` (§7.1.1 step 2c Call(exoticToPrim, input))", async () => {
    expect(
      await inFunction(
        `const o: any = { n: 6, [Symbol.toPrimitive]: function (): number { return (this as any).n; } };
         return Number(o);`,
      ),
    ).toBe(6);
  });

  it("arithmetic goes through it too", async () => {
    expect(await inFunction(`const o = ${TP5}; return (o as any) * 2;`)).toBe(10);
  });

  it("Math.* argument coercion goes through it", async () => {
    expect(await inFunction(`const o = ${TP5}; return Math.abs(o as any);`)).toBe(5);
  });

  it("a throw from @@toPrimitive propagates unchanged", async () => {
    expect(
      await inFunction(
        `const o = { [Symbol.toPrimitive]: function (): number { throw new RangeError("boom"); } };
         try { return Number(o as any); } catch (e: any) { return e instanceof RangeError ? "RangeError" : "other"; }`,
      ),
    ).toBe("RangeError");
  });

  it("one literal WITH and one WITHOUT @@toPrimitive keep their own answers", async () => {
    // Sibling object literals can share a unified struct shape, so the arm has
    // to key off the per-INSTANCE field value, not the presence of the field in
    // the type. Pre-fix this answered "1,7"; the `1` was the first object's
    // valueOf winning over its own @@toPrimitive.
    expect(
      await inFunction(
        `const a = { [Symbol.toPrimitive]: function (): number { return 5; }, valueOf: function (): number { return 1; } };
         const b = { valueOf: function (): number { return 7; } };
         return String(Number(a as any)) + "," + String(Number(b as any));`,
      ),
    ).toBe("5,7");
  });
});

describe("#3481 step 3 — module scope (the wasm START function)", () => {
  it("Number(obj) dispatches @@toPrimitive at module scope", async () => {
    expect(await atModuleScope(`const o = ${TP5};`, `Number(o as any)`)).toBe(5);
  });

  it("arithmetic dispatches @@toPrimitive at module scope", async () => {
    expect(await atModuleScope(`const o = ${TP5};`, `(o as any) * 2`)).toBe(10);
  });

  it("Math.abs dispatches @@toPrimitive at module scope", async () => {
    expect(await atModuleScope(`const o = ${TP5};`, `Math.abs(o as any)`)).toBe(5);
  });

  it("valueOf at module scope is unchanged (it already worked)", async () => {
    expect(await atModuleScope(`const o = { valueOf: function (): number { return 7; } };`, `Number(o as any)`)).toBe(
      7,
    );
  });
});

describe("#3481 step 3 — standalone (no JS host at all)", () => {
  it("Number(obj) dispatches @@toPrimitive with --target standalone", async () => {
    const exports = await run(`export function test(): number { const o = ${TP5}; return Number(o as any); }`, {
      target: "standalone",
    });
    expect(exports.test()).toBe(5);
  });
});

describe("#3481 step 3 — regression guards: shapes that must NOT change", () => {
  it("no @@toPrimitive at all → valueOf still wins", async () => {
    expect(await inFunction(`const o = { valueOf: function (): number { return 7; } }; return Number(o as any);`)).toBe(
      7,
    );
  });

  it("no @@toPrimitive at all → toString when there is no valueOf", async () => {
    expect(
      await inFunction(`const o = { toString: function (): string { return "7"; } }; return Number(o as any);`),
    ).toBe(7);
  });

  it("an @@toPrimitive field holding `undefined` is SKIPPED (§7.1.1 step 2b)", async () => {
    // `undefined` compiles to a distinguished host carrier, NOT `ref.null`, so
    // a plain null test would have mistaken it for a live method. The guard is
    // a callability test, which is why this still falls through to valueOf.
    expect(
      await inFunction(
        `const o: any = { [Symbol.toPrimitive]: undefined, valueOf: function (): number { return 7; } };
         return Number(o);`,
      ),
    ).toBe(7);
  });

  it("an @@toPrimitive field holding `null` is SKIPPED", async () => {
    expect(
      await inFunction(
        `const o: any = { [Symbol.toPrimitive]: null, valueOf: function (): number { return 7; } };
         return Number(o);`,
      ),
    ).toBe(7);
  });

  it("a NON-CALLABLE @@toPrimitive field does not hijack the coercion", async () => {
    expect(
      await inFunction(
        `const o: any = { [Symbol.toPrimitive]: 1, valueOf: function (): number { return 7; } };
         return Number(o);`,
      ),
    ).toBe(7);
  });

  it("the METHOD shape (#1716) is untouched", async () => {
    expect(
      await inFunction(
        `const o = { [Symbol.toPrimitive](hint: string): number { return 5; }, valueOf: function (): number { return 7; } };
         return Number(o as any);`,
      ),
    ).toBe(5);
  });

  it("KNOWN GAP: the STRING hint still ignores the @@toPrimitive field", async () => {
    // §7.1.1 step 2 applies to every hint, so the spec answer is "5". This
    // slice deliberately covers the NUMBER hint only — the `ref → externref`
    // coercion has its own, differently shaped lowering. Pinned rather than
    // left silent so the next slice sees the exact remaining shape, and so a
    // future string-hint fix is forced to update this expectation instead of
    // quietly flipping an untested path.
    expect(
      await inFunction(
        `const o = { [Symbol.toPrimitive]: function (): number { return 5; }, toString: function (): string { return "s"; } };
         return String(o as any);`,
      ),
    ).toBe("s");
  });

  it("a plain object with neither method is still NaN", async () => {
    expect(await inFunction(`const o = { a: 1 }; return Number(o as any);`)).toBeNaN();
  });

  it("a number-valued field named like anything else is untouched", async () => {
    expect(await inFunction(`const o = { valueOf: function (): number { return 3; } }; return (o as any) - 1;`)).toBe(
      2,
    );
  });
});
