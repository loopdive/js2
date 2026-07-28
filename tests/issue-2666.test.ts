// #2666 — `base[prop]` evaluation order in compound assignment: ToPropertyKey
// applied EXACTLY ONCE for a read-modify-write.
//
// For `o[key] op= rhs` with a computed, side-effecting key, ECMAScript evaluates
// the LHS Reference once (§13.15.2) → the key's ToPropertyKey (§7.1.19) fires
// once. The compiler used to pass the raw key object to both __extern_get and
// __extern_set (each ToPropertyKeys internally), firing `key.toString` twice and
// producing the wrong value. The fix coerces the key once (the new
// __to_property_key host import / native helper) and reuses the primitive for
// both the read and the write.
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
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

async function runStandalone(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const result = await compile(src, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  } as any);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#2666 — base[prop] compound-assign ToPropertyKey once + eval order", () => {
  it("evaluates the key expression, then rejects a null base before ToPropertyKey or the RHS", async () => {
    const exp = await run(
      `var keyCalls = 0; var toStringCalls = 0; var rhsCalls = 0;
       var base: any = null;
       function key(): any {
         keyCalls++;
         return { toString() { toStringCalls++; return "x"; } };
       }
       function rhs(): number { rhsCalls++; return 2; }
       var isTypeError = 0;
       try { base[key()] *= rhs(); } catch (e) { isTypeError = e instanceof TypeError ? 1 : 0; }
       return keyCalls * 1000 + toStringCalls * 100 + rhsCalls * 10 + isTypeError;`,
    );
    expect(exp.test()).toBe(1001);
  });

  it("rejects an undefined base before ToPropertyKey or the RHS", async () => {
    const exp = await run(
      `var toStringCalls = 0; var rhsCalls = 0;
       var base: any = undefined;
       var key: any = { toString() { toStringCalls++; return "x"; } };
       function rhs(): number { rhsCalls++; return 2; }
       var isTypeError = 0;
       try { base[key] += rhs(); } catch (e) { isTypeError = e instanceof TypeError ? 1 : 0; }
       return toStringCalls * 100 + rhsCalls * 10 + isTypeError;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("applies the same nullish-base ordering to computed-key update expressions", async () => {
    const exp = await run(
      `var keyCalls = 0; var toStringCalls = 0;
       var base: any = null;
       function key(): any {
         keyCalls++;
         return { toString() { toStringCalls++; return "x"; } };
       }
       var isTypeError = 0;
       try { ++base[key()]; } catch (e) { isTypeError = e instanceof TypeError ? 1 : 0; }
       return keyCalls * 100 + toStringCalls * 10 + isTypeError;`,
    );
    expect(exp.test()).toBe(101);
  });

  it("preserves the nullish-base ordering in the host-free standalone lowering", async () => {
    await expect(
      runStandalone(
        `var toStringCalls = 0; var rhsCalls = 0;
         var base: any = undefined;
         var key: any = { toString() { toStringCalls++; return "x"; } };
         function rhs(): number { rhsCalls++; return 2; }
         var isTypeError = 0;
         try { base[key] += rhs(); } catch (e) { isTypeError = e instanceof TypeError ? 1 : 0; }
         return toStringCalls * 100 + rhsCalls * 10 + isTypeError;`,
      ),
    ).resolves.toBe(1);
  });

  it("a side-effecting computed key is ToPropertyKey'd exactly ONCE", async () => {
    const exp = await run(
      `var n = 0; var o: any = { x: 1 };
       var key = { toString() { n++; return "x"; } };
       o[key] += 10;
       return n;`,
    );
    expect(exp.test()).toBe(1); // was 2 (read + write both coerced)
  });

  it("the compound write through a computed key produces the correct value", async () => {
    const exp = await run(
      `var o: any = { x: 1 }; var key = { toString() { return "x"; } };
       o[key] += 10; return o.x;`,
    );
    expect(exp.test()).toBe(11); // was null (broken)
  });

  it("base, prop, rhs are evaluated left-to-right (base before prop before rhs)", async () => {
    const exp = await run(
      `var log = ""; var o: any = { x: 0 };
       function B() { log += "B"; return o; }
       function K() { log += "K"; return "x"; }
       function R() { log += "R"; return 3; }
       B()[K()] += R(); return log;`,
    );
    expect(exp.test()).toBe("BKR");
  });

  it("the computed-key compound op computes on the current value (+=)", async () => {
    const exp = await run(
      `var o: any = { n: 4 }; var key = { toString() { return "n"; } };
       o[key] += 6; return o.n;`,
    );
    expect(exp.test()).toBe(10);
  });

  it("a string-literal / string-variable key still works (no regression)", async () => {
    const exp1 = await run(`var o: any = { x: 1 }; o["x"] += 10; return o.x;`);
    expect(exp1.test()).toBe(11);
    const exp2 = await run(`var o: any = { x: 1 }; var k = "x"; o[k] += 10; return o.x;`);
    expect(exp2.test()).toBe(11);
  });

  it("array index compound assignment still works (no regression)", async () => {
    const exp = await run(`var a = [10]; a[0] += 5; return a[0];`);
    expect(exp.test()).toBe(15);
  });

  it("a numeric-key compound coerces the key once to its string form", async () => {
    const exp = await run(
      `var n = 0; var o: any = { "1": 7 };
       var key = { toString() { n++; return "1"; } };
       o[key] += 3;
       return n * 100 + o["1"];`,
    );
    // toString once (n=1) → 100 + 10 = 110.
    expect(exp.test()).toBe(110);
  });
});
