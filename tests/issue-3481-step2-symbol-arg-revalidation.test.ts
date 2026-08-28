// #3481 step 2 — a Symbol reaching a builtin's ToString / ToInteger / ToIndex
// argument slot must throw a real TypeError.
//
// Root cause: a symbol VALUE lowers to a bare `i32` id, so an argument coerced
// with an `{kind:"f64"}` (or string) target is a silent `f64.convert_i32_s` of
// that id — `new ArrayBuffer(Symbol())` allocated `id` bytes and
// `Symbol(Symbol())` produced the description `"101"`. The dynamic twin (a
// symbol that arrives as an `externref`) already threw, via `__unbox_number`'s
// ToPrimitive → `Number(prim)` arm; only the STATIC, native-id path leaked. So
// every case here binds the symbol as a plain local (`const s = Symbol()`),
// which is what the failing test262 files do — writing `Symbol() as any`
// instead probes the dynamic path that was never broken.
//
// The sites are the ones §7.1.4 / §7.1.17 / §7.1.22 funnel through: ArrayBuffer
// and SharedArrayBuffer `length`, DataView `byteOffset` / `byteLength`,
// AggregateError `message`, `Symbol(description)`, `Array.prototype.at` /
// `includes` index, and `isNaN` / `isFinite`.
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

/**
 * Report `"TypeError"` only when the throw is a REAL catchable TypeError —
 * `e instanceof TypeError`, not merely something whose constructor is spelled
 * that way. That distinction is the issue's acceptance bar: a bare-string
 * throw or an opaque payload passes a `.name` check and still fails the
 * authentic test262 `assert.throws(TypeError, …)`.
 */
async function throwKind(body: string): Promise<string> {
  const exports = await run(`
    try { ${body} } catch (e) {
      if (e instanceof TypeError) { return "TypeError"; }
      const c: any = (e as any) && (e as any).constructor;
      return "other:" + (c && c.name ? c.name : typeof e);
    }
    return "no-throw";
  `);
  return exports.test();
}

/** Evaluate `body` and return its value — the regression-guard direction. */
async function value(body: string): Promise<any> {
  const exports = await run(body);
  return exports.test();
}

describe("#3481 step 2 — ToIndex / ToNumber argument slots reject a Symbol", () => {
  it("new ArrayBuffer(symbol) throws (§25.1.3.1 step 2 ToIndex)", async () => {
    expect(await throwKind("const s = Symbol(); new ArrayBuffer(s); return 0;")).toBe("TypeError");
  });

  it("new SharedArrayBuffer(symbol) throws (§25.2.3.1 step 2 ToIndex)", async () => {
    expect(await throwKind("const s = Symbol(); new SharedArrayBuffer(s); return 0;")).toBe("TypeError");
  });

  it("new DataView(buffer, symbol) throws on byteOffset", async () => {
    expect(await throwKind("const s = Symbol(); new DataView(new ArrayBuffer(8), s); return 0;")).toBe("TypeError");
  });

  it("new DataView(buffer, 0, symbol) throws on byteLength", async () => {
    expect(await throwKind("const s = Symbol(); new DataView(new ArrayBuffer(8), 0, s); return 0;")).toBe("TypeError");
  });

  it("[].at(symbol) throws (§23.1.3.1 step 3 ToIntegerOrInfinity)", async () => {
    expect(await throwKind("const s = Symbol(); [1, 2].at(s); return 0;")).toBe("TypeError");
  });

  it("[].includes(x, symbol) throws on fromIndex", async () => {
    expect(await throwKind("const s = Symbol(); [1, 2].includes(1, s); return 0;")).toBe("TypeError");
  });

  it("isNaN(symbol) throws (§19.2.3 step 1 ToNumber)", async () => {
    expect(await throwKind("const s = Symbol(); isNaN(s); return 0;")).toBe("TypeError");
  });

  it("isFinite(symbol) throws (§19.2.2 step 1 ToNumber)", async () => {
    expect(await throwKind("const s = Symbol(); isFinite(s); return 0;")).toBe("TypeError");
  });
});

describe("#3481 step 2 — ToString argument slots reject a Symbol", () => {
  it("new AggregateError([], symbol) throws (§20.5.7.1 step 5a ToString)", async () => {
    expect(await throwKind("const s = Symbol(); new AggregateError([], s); return 0;")).toBe("TypeError");
  });

  it("Symbol(symbol) throws (§20.4.1.1 step 2 ToString)", async () => {
    expect(await throwKind("const s = Symbol(); Symbol(s); return 0;")).toBe("TypeError");
  });
});

describe("#3481 step 2 — the throw is terminal, not a silently wrong value", () => {
  // Pins the concrete pre-fix symptom rather than only "something threw":
  // the id leaked as a length / description, so the call SUCCEEDED.
  it("does not allocate a buffer sized by the symbol id", async () => {
    expect(await throwKind("const s = Symbol(); const b = new ArrayBuffer(s); return b.byteLength;")).toBe("TypeError");
  });

  it("does not stringify the symbol id into a description", async () => {
    expect(await throwKind("const s = Symbol(); const t = Symbol(s); return String(t);")).toBe("TypeError");
  });

  it("evaluates the argument before throwing (§13.3.6.1 order)", async () => {
    // The guard compiles-and-drops its operand, so a side-effecting argument
    // still runs. A guard that threw WITHOUT evaluating would answer 0.
    expect(
      await value(`
        let n = 0;
        function mk(): any { n = n + 1; return Symbol(); }
        try { new ArrayBuffer(mk()); } catch (e) { /* expected */ }
        return n;
      `),
    ).toBe(1);
  });

  it("evaluates the receiver of arr.at(symbol) before throwing", async () => {
    expect(
      await value(`
        let n = 0;
        function recv(): any { n = n + 1; return [1, 2]; }
        const s = Symbol();
        try { recv().at(s); } catch (e) { /* expected */ }
        return n;
      `),
    ).toBe(1);
  });
});

describe("#3481 step 2 — regression guards: non-Symbol arguments are untouched", () => {
  it("new ArrayBuffer(n) still allocates", async () => {
    expect(await value("return new ArrayBuffer(8).byteLength;")).toBe(8);
  });

  it("new ArrayBuffer(objectWithValueOf) still coerces", async () => {
    expect(await value("const o: any = { valueOf() { return 8; } }; return new ArrayBuffer(o).byteLength;")).toBe(8);
  });

  it("new DataView(buffer, offset, length) still constructs", async () => {
    expect(await value("const d = new DataView(new ArrayBuffer(16), 4, 8); return d.byteOffset + d.byteLength;")).toBe(
      12,
    );
  });

  it("new SharedArrayBuffer(n) still allocates", async () => {
    expect(await value("return new SharedArrayBuffer(8).byteLength;")).toBe(8);
  });

  it("Symbol(string) keeps its description", async () => {
    expect(await value('return String(Symbol("d"));')).toBe("Symbol(d)");
  });

  it("Symbol() with no description still works", async () => {
    expect(await value("const s = Symbol(); return typeof s;")).toBe("symbol");
  });

  it("String(symbol) still returns the descriptive string, NOT a throw", async () => {
    // §22.1.1.1 step 1 is the ONE ToString spelling that does not throw.
    expect(await value('const s = Symbol("d"); return String(s);')).toBe("Symbol(d)");
  });

  it("symbol.toString() still returns the descriptive string", async () => {
    expect(await value('const s = Symbol("d"); return s.toString();')).toBe("Symbol(d)");
  });

  it("new AggregateError([], string) keeps its message", async () => {
    expect(await value('return new AggregateError([], "hi").message;')).toBe("hi");
  });

  it("new AggregateError([]) with no message still constructs", async () => {
    expect(await value("return new AggregateError([]).errors.length;")).toBe(0);
  });

  it("[].at(n) still indexes", async () => {
    expect(await value("return [10, 20, 30].at(1);")).toBe(20);
  });

  it("[].at(-1) still indexes from the end", async () => {
    expect(await value("return [10, 20, 30].at(-1);")).toBe(30);
  });

  it("[].at() with no argument does not reach the guard", async () => {
    // The guard keys off `arguments[0]`, so an ABSENT argument must leave the
    // call untouched. This deliberately asserted only "no throw" while the
    // separate, PRE-EXISTING no-argument gap was open (it answered 0 where
    // §23.1.3.1 says 10) rather than pinning a wrong value as a fixture. #5095
    // closed that gap, so the value is now pinned too.
    expect(await throwKind("[10, 20].at();")).toBe("no-throw");
    expect(await value("return [10, 20].at();")).toBe(10);
  });

  it("[].includes(x, fromIndex) still searches", async () => {
    expect(await value("return [10, 20].includes(20, 1);")).toBe(true);
  });

  it("[].includes(x) with no fromIndex still searches", async () => {
    expect(await value("return [10, 20].includes(10);")).toBe(true);
  });

  it("isNaN keeps its ToNumber coercion", async () => {
    expect(await value('return isNaN("x" as any);')).toBe(true);
  });

  it("isFinite keeps its ToNumber coercion", async () => {
    expect(await value('return isFinite("3" as any);')).toBe(true);
  });

  it("the SharedArrayBuffer guard does not hijack a same-named user class", async () => {
    // The SAB guard lives in the generic `new` path, so it must not claim a
    // constructor that merely shares the name. This case used to assert only
    // that the failure was the pre-existing "SharedArrayBuffer is not a
    // constructor" rather than the guard's "Cannot convert a Symbol value to a
    // number"; #5096 made the user class constructable, so it now asserts the
    // user constructor's own value — the strongest form of "not hijacked".
    const exports = await run(`
      class SharedArrayBuffer { v: number; constructor(_v: any) { this.v = 7; } }
      const s = Symbol();
      try { return new SharedArrayBuffer(s).v; }
      catch (e: any) { return String((e as any).message); }
    `);
    expect(exports.test()).toBe(7);
  });
});

describe("#3481 step 2 — the dynamic (externref) symbol path is unchanged", () => {
  // These already threw before the slice, via `__unbox_number`'s ToPrimitive
  // arm. Kept so a future refactor of the static guard cannot quietly take the
  // dynamic one with it.
  it("new ArrayBuffer(dynamic symbol) still throws", async () => {
    expect(await throwKind("const s: any = Symbol(); new ArrayBuffer(s); return 0;")).toBe("TypeError");
  });

  it("Number(symbol) still throws", async () => {
    expect(await throwKind("const s = Symbol(); Number(s); return 0;")).toBe("TypeError");
  });

  it("new Error(symbol) still throws", async () => {
    expect(await throwKind("const s = Symbol(); new Error(s); return 0;")).toBe("TypeError");
  });

  it('"abc".indexOf(symbol) still throws', async () => {
    expect(await throwKind('const s = Symbol(); "abc".indexOf(s); return 0;')).toBe("TypeError");
  });
});
