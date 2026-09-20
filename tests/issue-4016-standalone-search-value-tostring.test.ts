// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4016 — the standalone `String.prototype` search-value methods must take the
 * spec's plain-`ToString` path instead of refusing.
 *
 * `match`/`matchAll`/`search`/`replace`/`replaceAll`/`split` all start by asking
 * `GetMethod(searchValue, @@<protocol>)`. Only when that comes back `undefined`
 * do they fall through to their own string path — `ToString(searchValue)` for
 * `split`, `RegExpCreate(ToString(searchValue), …)` for `search`/`match`. The
 * standalone lane used to refuse the whole call whenever the argument was not a
 * statically-known backend RegExp, conflating "not a RegExp" with "needs a JS
 * host".
 *
 * Two harness constraints shape every case below, both learned the hard way:
 *
 *  - **Exports return numbers only.** A standalone module's string is a WasmGC
 *    `$AnyString`, so returning one hands JS an opaque ref (it prints as `{}`);
 *    string results are encoded numerically instead.
 *  - **`as any` here is REQUIRED, not laziness.** `String.prototype.split` is
 *    typed `(separator: string | RegExp, …)`, so a number/object separator is
 *    only expressible through a cast. The compiler therefore analyses the
 *    assertion's OPERAND — otherwise the only way a TypeScript caller can reach
 *    this path would be the very thing that defeats it.
 *
 * Every expectation was taken from Node BEFORE it was asserted here.
 */
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

async function runStandalone(src: string, fn = "f"): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  // The whole point of the standalone lane: no host to fall back on.
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(mod, {});
  return (exports as Record<string, () => unknown>)[fn]!();
}

/** Native strings with the normal host runtime, used for late-import controls. */
async function runNativeStringsHost(src: string, fn = "f"): Promise<unknown> {
  const r = await compile(src, { nativeStrings: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await instantiateWasm(r.binary as BufferSource, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>)[fn]!();
}

describe("#4016 — String.prototype.search coerces its search value", () => {
  it.each([
    // `RegExpCreate(undefined)` is the EMPTY pattern, not the text "undefined",
    // so this is 0 rather than -1 on a subject containing no "undefined".
    ["absent argument", `return "abc".search(undefined as any);`, 0],
    ["string argument", `return new String("test string").search("string") as number;`, 5],
    ["no match", `return "abc".search("z");`, -1],
    ["number argument", `return "this123is".search(123 as any);`, 4],
    ["null argument", `return "gnulluna".search(null as any);`, 1],
    ["boolean argument", `return "xtruey".search(true as any);`, 1],
  ])("%s", async (_label, body, want) => {
    expect(await runStandalone(`export function f(): number { ${body} }`)).toBe(want);
  });

  it("dispatches an overridden toString on an object search value", async () => {
    const src = `
      export function f(): number {
        const o = { toString() { return "AB"; } };
        return "ssABBABABAB".search(o as any);
      }`;
    expect(await runStandalone(src)).toBe(2);
  });

  it("treats the coerced source as a PATTERN, not a literal substring", async () => {
    // The distinguishing case: `search` builds a RegExp, so metacharacters are
    // live. `"a.c".search("a.c")` matching at 0 would prove nothing; this does.
    const src = `export function f(): number { return "xxabc".search("a.c"); }`;
    expect(await runStandalone(src)).toBe(2);
  });
});

describe("#4016 — String.prototype.match coerces its search value", () => {
  it("returns an exec-shaped result for a string argument", async () => {
    // index * 100 + length * 10 + m[0].length → 2*100 + 1*10 + 2
    const src = `
      export function f(): number {
        const m = "ssABBABABAB".match("AB");
        if (m === null) return -1;
        return (m.index as number) * 100 + m.length * 10 + (m[0] as string).length;
      }`;
    expect(await runStandalone(src)).toBe(212);
  });

  it("an absent argument builds the empty pattern", async () => {
    // `"".match(undefined)` is `[""]` at index 0 — NOT a match on "undefined".
    const src = `
      export function f(): number {
        const m = "".match(undefined as any);
        if (m === null) return -1;
        return (m.index as number) * 100 + m.length * 10 + (m[0] as string).length;
      }`;
    expect(await runStandalone(src)).toBe(10);
  });

  it("returns null when the coerced pattern does not match", async () => {
    const src = `export function f(): number { return "abc".match("z") === null ? 1 : 0; }`;
    expect(await runStandalone(src)).toBe(1);
  });
});

describe("#4016 — String.prototype.split coerces its separator", () => {
  it("splits on a number separator", async () => {
    // ["this","is","a"] → 3*100 + 4*10 + 1
    const src = `
      export function f(): number {
        const a = "this123is123a".split(123 as any);
        return a.length * 100 + a[0].length * 10 + a[2].length;
      }`;
    expect(await runStandalone(src)).toBe(341);
  });

  it('splits on ToString(null) === "null"', async () => {
    // ["g","una"] → 2*100 + 1*10 + 3
    const src = `
      export function f(): number {
        const a = "gnulluna".split(null as any);
        return a.length * 100 + a[0].length * 10 + a[1].length;
      }`;
    expect(await runStandalone(src)).toBe(213);
  });

  it("honours an overridden toString separator and an overridden valueOf limit", async () => {
    // ToUint32(true) === 1 → ["A"] → 1*100 + 1*10 + 1
    const src = `
      export function f(): number {
        const sep = { toString() { return "BB"; } };
        const lim = { valueOf() { return true; } };
        const a = "ABBABABAB".split(sep as any, lim as any);
        return a.length * 100 + a[0].length * 10 + (a[0] === "A" ? 1 : 0);
      }`;
    expect(await runStandalone(src)).toBe(111);
  });

  it('an UNDEFINED separator does not split — and is not ToString\'d to "undefined"', async () => {
    // The silent wrong answer this change had to avoid: §22.1.3.23 step 2 exits
    // early for undefined, so the result is [S]. Splitting on the text
    // "undefined" would give ["", "-here"] — length 2, first element empty.
    const src = `
      export function f(): number {
        function nothing(): void {}
        const a = "undefined-here".split(nothing() as any);
        return a.length * 100 + a[0].length;
      }`;
    expect(await runStandalone(src)).toBe(114);
  });

  it("still evaluates a side-effecting undefined separator expression", async () => {
    const src = `
      export function f(): number {
        let calls = 0;
        function bump(): void { calls = calls + 1; }
        const a = "abc".split(bump() as any);
        return calls * 10 + a.length;
      }`;
    expect(await runStandalone(src)).toBe(11);
  });
});

describe("#4016 — the refusal is NARROWED, not removed", () => {
  const refusal = /with a RegExp or symbol-protocol search value is not supported/;

  it("still refuses a search value that could carry @@split", async () => {
    // An `any` whose operand is also unprovable cannot be shown free of
    // `[Symbol.split]`, so the spec's protocol dispatch might apply. Refusing
    // loudly beats guessing.
    const r = await compile(
      `export function f(): number { const sep: any = JSON.parse("1"); return "abc".split(sep).length; }`,
      { target: "standalone" },
    );
    expect(r.success && r.errors.every((e) => !refusal.test(e.message))).toBe(false);
  });

  it("still refuses an explicit @@split implementor", async () => {
    const r = await compile(
      `export function f(): number {
         const sep = { [Symbol.split](s: string) { return ["x"]; } };
         return "abc".split(sep as any).length;
       }`,
      { target: "standalone" },
    );
    expect(r.success && r.errors.every((e) => !refusal.test(e.message))).toBe(false);
  });

  it("a statically-known RegExp argument keeps its existing native lowering", async () => {
    const src = `export function f(): number { return "xxabc".search(/a.c/); }`;
    expect(await runStandalone(src)).toBe(2);
  });

  it("a RegExp behind an `as any` is still recognised as a RegExp", async () => {
    // Looking through the assertion must not LOSE the RegExp:
    // `wellKnownSymbolMemberOf` answers `true` for the operand, so this keeps
    // the regex lowering instead of ToString-ing it to the source text "/a.c/".
    const src = `export function f(): number { const re = /a.c/; return "xxabc".search(re as any); }`;
    expect(await runStandalone(src)).toBe(2);
  });
});

describe("#4016 S2 — direct split stages values before coercion", () => {
  it("evaluates every operand before receiver, limit, and separator coercion", async () => {
    const src = `
      export function f(): number {
        let order = 0;
        const receiverValue = {
          [Symbol.toPrimitive]() { order = order * 10 + 5; return "a,b"; },
        };
        function receiver(): string { order = order * 10 + 1; return receiverValue as unknown as string; }
        const separatorValue = { [Symbol.toPrimitive]() { order = order * 10 + 7; return ","; } };
        const limitValue = { valueOf() { order = order * 10 + 6; return 2; } };
        function separator(): typeof separatorValue { order = order * 10 + 2; return separatorValue; }
        function limit(): typeof limitValue { order = order * 10 + 3; return limitValue; }
        function extra(): number { order = order * 10 + 4; return 0; }
        // @ts-expect-error split ignores supplied arguments after \`limit\`
        const result = receiver().split(separator() as any, limit() as any, extra());
        return order * 10 + result.length;
      }`;
    // Evaluation: receiver, separator, limit, extra; coercion: receiver, limit, separator.
    expect(await runStandalone(src)).toBe(12345672);
  });

  it("propagates the limit's abrupt completion before separator ToString", async () => {
    const src = `
      export function f(): number {
        const separator = {
          [Symbol.toPrimitive]() { throw 23; },
          toString() { throw 24; },
        };
        const limit = { valueOf() { throw 19; } };
        try {
          "a,b".split(separator as any, limit as any);
          return 0;
        } catch (e) {
          return e === 19 ? 1 : 2;
        }
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("still coerces the separator before the zero-limit early result", async () => {
    const src = `
      export function f(): number {
        let calls = 0;
        const separator = { toString() { calls = calls + 1; return ","; } };
        const result = "a,b".split(separator as any, 0);
        return calls * 10 + result.length;
      }`;
    expect(await runStandalone(src)).toBe(10);
  });

  it("preserves undefined-separator evaluation and ToUint32 wrapping", async () => {
    const src = `
      export function f(): number {
        let calls = 0;
        function separator(): void { calls = calls + 1; }
        function limit(): number { calls = calls + 1; return 0; }
        function extra(): number { calls = calls + 1; return 0; }
        const empty = "abc".split(separator() as any, limit() as any, extra()).length;
        const native = { toString() { return ","; } };
        const unbounded = "a,b,c".split(native as any, -1).length;
        return calls * 100 + empty * 10 + unbounded;
      }`;
    expect(await runStandalone(src)).toBe(303);
  });

  it("refreshes native-string host helper indices after a staged undefined argument call", async () => {
    const src = `
      export function f(): number {
        // Date.now is compiled while the argument is staged, after the split
        // arm's availability preflight. The value remains exactly undefined.
        return "abc".split(void Date.now(), 0).length;
      }`;
    expect(await runNativeStringsHost(src)).toBe(0);
  });

  it("keeps dynamic undefined and raw null limits distinct in the host undefined-separator arm", async () => {
    const src = `
      export function f(): number {
        let dynamicLimit: any;
        const unbounded = "abc".split(void Date.now(), dynamicLimit).length;
        const zero = "abc".split(void Date.now(), null as any).length;
        return unbounded * 10 + zero;
      }`;
    expect(await runNativeStringsHost(src)).toBe(10);
  });

  it("constructs an undescribed Symbol before host limit conversion", async () => {
    const src = `
      export function f(): number {
        const limit = Symbol();
        return typeof limit === "symbol" ? 1 : 0;
      }`;
    expect(await runNativeStringsHost(src)).toBe(1);
  });

  it("rejects a bare undescribed Symbol limit in the host undefined-separator arm", async () => {
    const src = `
      export function f(): number {
        const limit = Symbol();
        "a,b".split(void Date.now(), limit as any);
        return 0;
      }`;
    // This assertion runs outside the opaque native error carrier. The
    // embedded catch+instanceof form would itself re-enter the host bridge.
    await expect(runNativeStringsHost(src)).rejects.toThrow(TypeError);
  });

  it("rejects a no-description Symbol returned by limit ToPrimitive after one numeric-hint callback", async () => {
    const src = `
      export function f(): number {
        const symbol = Symbol();
        let calls = 0;
        let wrongHint = 0;
        const limit = {
          [Symbol.toPrimitive](hint: string) {
            calls = calls + 1;
            if (hint !== "number") wrongHint = 1;
            return symbol;
          },
        };
        try {
          "a,b".split(void Date.now(), limit as any);
          return 0;
        } catch {
          // Do not inspect the opaque host error here. The bare-Symbol control
          // above checks its JS-visible TypeError; this pin verifies that this
          // path reached the callback once with the required Number hint.
          return calls === 1 && wrongHint === 0 ? 1 : 2;
        }
      }`;
    expect(await runNativeStringsHost(src)).toBe(1);
  });

  it("keeps a descriptor-before-split host boundary valid", async () => {
    const src = `
      export function f(): number {
        const target: any = {};
        // Deliberately precede split with the descriptor path. This preserves
        // the existing semantic boundary rather than hiding it by reordering.
        Object.defineProperty(target, "fixed", { value: 1, writable: false, configurable: false });
        Object.defineProperty(target, "fixed", { value: 1 });
        return target.fixed + "abc".split(void Date.now(), 0).length;
      }`;
    // The old __object_is-import assertion belonged to the superseded split
    // preflight experiment. This control retains only its observable behavior.
    expect(await runNativeStringsHost(src)).toBe(1);
  });

  it("keeps a guarded any primitive-string receiver on the undefined-separator arm", async () => {
    const src = `
      export function f(): number {
        const receiver: any = "a,b";
        return receiver.split(undefined as any, 0).length;
      }`;
    expect(await runStandalone(src)).toBe(0);
  });

  it("keeps a guarded any primitive-string receiver on the plain-separator arm", async () => {
    const src = `
      export function f(): number {
        const receiver: any = "a,b,c";
        const comma = { toString() { return ","; } };
        return receiver.split(comma as any, 2).length;
      }`;
    expect(await runStandalone(src)).toBe(2);
  });

  it("keeps raw explicit null distinct from an omitted split limit", async () => {
    const src = `
      export function f(): number {
        const comma = { toString() { return ","; } };
        return "a,b".split(comma as any, null as any).length;
      }`;
    expect(await runStandalone(src)).toBe(0);
  });

  it("throws for a null direct receiver before evaluating its arguments", async () => {
    const src = `
      export function f(): number {
        let calls = 0;
        const comma = { toString() { return ","; } };
        function separator(): typeof comma { calls = calls + 1; return comma; }
        try {
          (null as unknown as string).split(separator() as any, 1);
          return 0;
        } catch (e) {
          return e instanceof TypeError && calls === 0 ? 1 : 2;
        }
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("rejects a Symbol limit before separator conversion", async () => {
    const src = `
      export function f(): number {
        const comma = { toString() { return ","; } };
        try {
          "a,b".split(comma as any, Symbol("limit") as any);
          return 0;
        } catch (e) {
          return e instanceof TypeError ? 1 : 2;
        }
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("constructs an undescribed Symbol before native split-limit coercion", async () => {
    const src = `
      export function f(): number {
        const limit = Symbol();
        return typeof limit === "symbol" ? 1 : 0;
      }`;
    // This positive control keeps the post-ToPrimitive assertions below from
    // accepting a failure in Symbol construction as a conversion TypeError.
    expect(await runStandalone(src)).toBe(1);
  });

  it("rejects a no-description Symbol returned by limit ToPrimitive with the number hint", async () => {
    const src = `
      export function f(): number {
        const symbol = Symbol();
        let primitiveCalls = 0;
        let wrongHint = 0;
        const separator = { toString() { return ","; } };
        const limit = {
          [Symbol.toPrimitive](hint: string) {
            primitiveCalls = primitiveCalls + 1;
            if (hint !== "number") wrongHint = 1;
            return symbol;
          },
        };
        try {
          "a,b".split(separator as any, limit as any);
          return 0;
        } catch (e) {
          return e instanceof TypeError && primitiveCalls === 1 && wrongHint === 0 ? 1 : 2;
        }
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("does not coerce the separator after a native limit produces a Symbol", async () => {
    const src = `
      export function f(): number {
        const symbol = Symbol();
        let primitiveCalls = 0;
        let separatorCalls = 0;
        const separator = {
          toString() {
            separatorCalls = separatorCalls + 1;
            return ",";
          },
        };
        const limit = {
          [Symbol.toPrimitive]() {
            primitiveCalls = primitiveCalls + 1;
            return symbol;
          },
        };
        try {
          "a,b".split(separator as any, limit as any);
          return 0;
        } catch (e) {
          return e instanceof TypeError && primitiveCalls === 1 && separatorCalls === 0 ? 1 : 2;
        }
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("rejects a Symbol returned by separator conversion even with a zero limit", async () => {
    const src = `
      export function f(): number {
        const symbolResult = { [Symbol.toPrimitive]() { return Symbol("separator"); } };
        try {
          "a,b".split(symbolResult as any, 0);
          return 0;
        } catch (e) {
          return e instanceof TypeError ? 1 : 2;
        }
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("applies ToUint32 to finite fractional and negative limits", async () => {
    const src = `
      export function f(): number {
        const comma = { toString() { return ","; } };
        const fractional = "a,b,c".split(comma as any, 1.9).length;
        const negative = "a,b,c".split(comma as any, -1.5).length;
        return fractional * 10 + negative;
      }`;
    expect(await runStandalone(src)).toBe(13);
  });

  it("applies exact finite ToUint32 modulo reduction above i64 range", async () => {
    const src = `
      export function f(): number {
        const comma = { toString() { return ","; } };
        return "a,b,c".split(comma as any, 2 ** 64).length;
      }`;
    // ToUint32(2 ** 64) is zero. This is deliberately separate from the
    // fractional/negative control because a saturating i64 conversion gives -1.
    expect(await runStandalone(src)).toBe(0);
  });

  it("keeps the extracted reflective limit path in the same order", async () => {
    const src = `
      export function f(): number {
        const split = String.prototype.split;
        const separator = { [Symbol.toPrimitive]() { throw 41; } };
        const limit = { valueOf() { throw 37; } };
        try {
          split.call("a,b", separator as any, limit as any);
          return 0;
        } catch (e) {
          return e === 37 ? 1 : 2;
        }
      }`;
    expect(await runStandalone(src)).toBe(1);
  });
});
