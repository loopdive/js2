import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// Boolean-brand pair. i32-returning predicates lacked the boolean brand, so a
// string context formatted them numerically ("1"/"0") instead of "true"/"false".
//
// #2016 — `o.hasOwnProperty("x")` (and propertyIsEnumerable) returned a bare
//   i32; `hop("x") + "," + hop("y")` printed "1,0".
// #2030 — `IteratorResult.done` was typed as a raw i32; `r.done` in a string
//   context printed "0"/"1".
//
// Both now carry `{ kind: "i32", boolean: true }`, and the string-concat /
// toString boolean check honours the brand (not just the TS type).

async function evalStr(body: string): Promise<unknown> {
  const exports = await compileToWasm(body);
  return (exports as { test: () => unknown }).test();
}
async function evalBool(body: string): Promise<boolean> {
  const exports = await compileToWasm(body);
  return !!(exports as { test: () => unknown }).test();
}

describe("#2016 hasOwnProperty boolean brand", () => {
  it("stringifies hasOwnProperty results as true/false", async () => {
    expect(
      await evalStr(
        `export function test(): string { const o: any = { x: 1 }; return o.hasOwnProperty("x") + "," + o.hasOwnProperty("y"); }`,
      ),
    ).toBe("true,false");
  });

  it("keeps the boolean value correct", async () => {
    expect(
      await evalBool(`export function test(): boolean { const o: any = { x: 1 }; return o.hasOwnProperty("x"); }`),
    ).toBe(true);
    expect(
      await evalBool(`export function test(): boolean { const o: any = { x: 1 }; return o.hasOwnProperty("y"); }`),
    ).toBe(false);
  });

  it("works in a template literal context too", async () => {
    expect(
      await evalStr(
        `export function test(): string { const o: any = { a: 1 }; return \`\${o.hasOwnProperty("a")}\`; }`,
      ),
    ).toBe("true");
  });
});

describe("#2030 IteratorResult.done boolean brand", () => {
  it("stringifies .done as true/false", async () => {
    expect(
      await evalStr(
        `function* g(){ yield 5; } export function test(): string { const it = g(); const r1 = it.next(); const r2 = it.next(); return r1.done + "/" + r2.done; }`,
      ),
    ).toBe("false/true");
  });

  it("does not regress .done in a boolean (loop) context", async () => {
    expect(
      await evalStr(
        `function* g(){ yield 1; yield 2; } export function test(): string { const it = g(); let out = ""; let r = it.next(); while (!r.done) { out += r.value + ","; r = it.next(); } return out + "done=" + r.done; }`,
      ),
    ).toBe("1,2,done=true");
  });

  it("does not regress numeric .value during iteration", async () => {
    expect(
      await evalStr(
        `function* g(){ yield 1; yield 2; yield 3; } export function test(): string { const it = g(); let out = ""; let r = it.next(); while (!r.done) { out += r.value; r = it.next(); } return out; }`,
      ),
    ).toBe("123");
  });
});
