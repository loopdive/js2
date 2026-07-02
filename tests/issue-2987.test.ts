import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2987 — standalone `Object.getOwnPropertyDescriptor` on a boxed String
// wrapper receiver. `new String("ab")` builds a `$Object` wrapper carrying its
// [[StringData]] native string in the reserved FLAG_INTERNAL slot (#1910 S2).
// Its integer-index own properties ("0".."n-1") and "length" are String-exotic
// (§10.4.3) with NO ordinary `$PropEntry`, so the native gOPD's `__obj_find`
// missed them and returned `undefined` (the test then trapped dereferencing the
// missing descriptor). The gOPD runtime now recovers the slot string and
// synthesizes the spec descriptor:
//   index  → { value: char, writable:false, enumerable:true,  configurable:false }
//   length → { value: len,  writable:false, enumerable:false, configurable:false }
// Number/Boolean wrappers already round-tripped via the ordinary $Object MOP and
// are covered here as non-regression guards. gc/host + wasi lanes are byte-inert
// (the arm is standalone-only).
async function runNum(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#2987 standalone gOPD on boxed String-wrapper exotic own properties", () => {
  it("gOPD(new String('ab'), '0').value === 'a'", async () => {
    expect(
      await runNum(
        `export function f(): number { const s = new String("ab"); const d: any = Object.getOwnPropertyDescriptor(s, "0"); return d.value === "a" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("gOPD(new String('123'), '2').value === '3' (15.2.3.3-3-14)", async () => {
    expect(
      await runNum(
        `export function f(): number { const s = new String("123"); const d: any = Object.getOwnPropertyDescriptor(s, "2"); return d.value === "3" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("index descriptor attrs: writable:false, enumerable:true, configurable:false", async () => {
    expect(
      await runNum(
        `export function f(): number { const s = new String("ab"); const d: any = Object.getOwnPropertyDescriptor(s, "0"); return d.writable === false && d.enumerable === true && d.configurable === false ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("length descriptor: {value:len, writable:false, enumerable:false, configurable:false} (15.2.3.3-4-192)", async () => {
    expect(
      await runNum(
        `export function f(): number { const s = new String("abc"); const d: any = Object.getOwnPropertyDescriptor(s, "length"); return d.value === 3 && d.writable === false && d.enumerable === false && d.configurable === false ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("out-of-range index → undefined", async () => {
    expect(
      await runNum(
        `export function f(): number { const s = new String("ab"); return Object.getOwnPropertyDescriptor(s, "5") === undefined ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("non-index string key → undefined", async () => {
    expect(
      await runNum(
        `export function f(): number { const s = new String("ab"); return Object.getOwnPropertyDescriptor(s, "foo") === undefined ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("ordinary user own property on the wrapper still resolves", async () => {
    expect(
      await runNum(
        `export function f(): number { const s = new String("ab"); (s as any).x = 42; const d: any = Object.getOwnPropertyDescriptor(s, "x"); return d.value === 42 ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Number wrapper defineProperty round-trips (non-regression)", async () => {
    expect(
      await runNum(
        `export function f(): number { const w = new Number(5); Object.defineProperty(w, "p", { value: 7, writable: true, enumerable: true, configurable: true }); return (w as any).p; }`,
      ),
    ).toBe(7);
  });

  it("Boolean wrapper gOPD round-trips (non-regression)", async () => {
    expect(
      await runNum(
        `export function f(): number { const w = new Boolean(true); Object.defineProperty(w, "q", { value: 9, enumerable: false, writable: false, configurable: false }); const d: any = Object.getOwnPropertyDescriptor(w, "q"); return d.value; }`,
      ),
    ).toBe(9);
  });

  it("plain object gOPD for an index key stays undefined (arm skips non-wrappers)", async () => {
    expect(
      await runNum(
        `export function f(): number { const o: any = {}; return Object.getOwnPropertyDescriptor(o, "0") === undefined ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
