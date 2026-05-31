// Issue #1552 — catch parameter destructuring (ECMA-262 §14.15.2)
//
// Before this PR, `try { ... } catch (pattern) { ... }` had a hand-rolled
// destructure lowering that did bare `__extern_get(value, "key")` for
// object patterns and `__array_from_iter` + indexed access for array
// patterns. It lacked default-value evaluation, nested patterns, rest
// patterns, fn-name inference, null-throws, and other BindingInitialization
// behaviour that the function-parameter destructuring helper handles.
//
// The fix routes catch-pattern destructure through the same
// `compileExternrefObjectDestructuringDecl` / `compileExternrefArray-
// DestructuringDecl` helpers used by `let { x } = ...` / `let [x] = ...`
// declarations — picking up defaults, nested patterns, rest, and null
// throws for free.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runReturning(src: string): Promise<unknown> {
  const wrapped = `export function run(): any { ${src} }`;
  const r = await compile(wrapped, { fileName: "x.ts" });
  if (!r.success) {
    throw new Error("compile failed: " + JSON.stringify(r.errors.slice(0, 3).map((e) => e.message)));
  }
  const imports = buildImports(r.imports ?? [], undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  // Wire up exports for __sget_* / callback fallbacks — required when the
  // catch destructuring helper reads struct externref fields via the
  // __extern_get → __sget_* fallback path.
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { run: () => unknown }).run();
}

describe("issue #1552 — catch parameter destructuring", () => {
  it("object pattern reads thrown properties", async () => {
    const r = await runReturning(`
      try { throw { a: 1, b: 2 } } catch ({ a, b }) { return a + '-' + b }
    `);
    expect(r).toBe("1-2");
  });

  it("array pattern reads thrown iterable", async () => {
    const r = await runReturning(`
      try { throw [1, 2, 3] } catch ([a, b, c]) { return a + b + c }
    `);
    expect(r).toBe(6);
  });

  it("default is NOT evaluated when value is present (init-skipped)", async () => {
    const r = await runReturning(`
      let n = 0;
      try { throw { x: 5 } } catch ({ x = ++n }) { return x + '-' + n }
    `);
    expect(r).toBe("5-0");
  });

  it("default IS evaluated when value is undefined", async () => {
    const r = await runReturning(`
      let n = 0;
      try { throw { y: undefined } } catch ({ y = ++n }) { return y + '-' + n }
    `);
    expect(r).toBe("1-1");
  });

  it("default IS evaluated when property is missing", async () => {
    const r = await runReturning(`
      let n = 0;
      try { throw {} } catch ({ z = ++n }) { return z + '-' + n }
    `);
    expect(r).toBe("1-1");
  });

  // Empty patterns still RequireObjectCoercible per ECMA-262 §8.5.2 /
  // §8.5.3 (the catch path emits the null/undefined guard for `catch ({})`
  // and `catch ([])` even though the decl path short-circuits empty
  // patterns to keep `let {} = null` non-throwing, see #1553c).
  it("destructuring `null` with an empty object pattern throws TypeError", async () => {
    const r = await runReturning(`
      let kind = 'none';
      try {
        try { throw null } catch ({}) { /* unreachable */ }
      } catch (e) {
        kind = (e && e.name) || String(e);
      }
      return kind;
    `);
    expect(r).toBe("TypeError");
  });

  it("destructuring `undefined` with an empty object pattern throws TypeError", async () => {
    const r = await runReturning(`
      let kind = 'none';
      try {
        try { throw undefined } catch ({}) { /* unreachable */ }
      } catch (e) {
        kind = (e && e.name) || String(e);
      }
      return kind;
    `);
    expect(r).toBe("TypeError");
  });

  it("destructuring `null` with an empty array pattern throws TypeError", async () => {
    const r = await runReturning(`
      let kind = 'none';
      try {
        try { throw null } catch ([]) { /* unreachable */ }
      } catch (e) {
        kind = (e && e.name) || String(e);
      }
      return kind;
    `);
    expect(r).toBe("TypeError");
  });

  it("empty patterns over a coercible value do NOT throw", async () => {
    expect(
      await runReturning(`
      let t = 9; try { try { throw { a: 1 } } catch ({}) { t = 1 } } catch (e) { t = 2 } return t;
    `),
    ).toBe(1);
    expect(
      await runReturning(`
      let t = 9; try { try { throw [1, 2] } catch ([]) { t = 1 } } catch (e) { t = 2 } return t;
    `),
    ).toBe(1);
  });

  it("object-rest skips non-enumerable own properties (CopyDataProperties)", async () => {
    const r = await runReturning(`
      let o = { a: 1 };
      Object.defineProperty(o, 'x', { value: 9, enumerable: false });
      try { throw o } catch ({ ...rest }) { return JSON.stringify(rest) }
    `);
    expect(r).toBe(JSON.stringify({ a: 1 }));
  });

  it("infers fn.name on an anonymous default initializer (#1450)", async () => {
    const r = await runReturning(`
      try { throw [] } catch ([fn = function () {}]) { return fn.name }
    `);
    expect(r).toBe("fn");
  });

  it("rest pattern collects remaining own properties", async () => {
    const r = await runReturning(`
      try { throw { a: 1, b: 2, c: 3 } } catch ({ a, ...rest }) {
        return JSON.stringify({ a, rest });
      }
    `);
    expect(r).toBe(JSON.stringify({ a: 1, rest: { b: 2, c: 3 } }));
  });

  it("nested object pattern works", async () => {
    const r = await runReturning(`
      try { throw { outer: { inner: 42 } } } catch ({ outer: { inner } }) {
        return inner;
      }
    `);
    expect(r).toBe(42);
  });

  it("nested array pattern works", async () => {
    const r = await runReturning(`
      try { throw [[1, 2], [3, 4]] } catch ([[a, b], [c, d]]) {
        return a + b + c + d;
      }
    `);
    expect(r).toBe(10);
  });

  it("plain identifier catch (no destructure) still works", async () => {
    const r = await runReturning(`
      try { throw 'oops' } catch (e) { return e }
    `);
    expect(r).toBe("oops");
  });
});
