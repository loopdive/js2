import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3251 S3 — ArraySetLength (§10.4.2.1) over the array-descriptor overlay.
//
// `Object.defineProperty(arr, "length", d)` was a lenient no-op standalone.
// S3 routes it through the overlay companion: a reserved `"length"` entry
// carries the writable bit (enumerable/configurable are spec-fixed false),
// transition legality delegates to the $Object §10.1.6.3 machinery against a
// seeded `{value: len, writable: true, e: false, c: false}` current,
// ToUint32/ToNumber mismatch throws RangeError, shrink walks indices down
// stopping (and throwing TypeError) at a non-configurable companion entry,
// growth reuses the per-carrier grow-with-default arms, and gOPD("length")
// synthesizes the live descriptor from the length field + companion bit.
async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

const MK = "function mkArr(): any { const a: any = [1, 2, 3]; return a; }";

describe("#3251 S3 — ArraySetLength via defineProperty", () => {
  it("shrinks the array and makes removed indices read undefined", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "length", { value: 2 });
          const v: any = arr[2];
          return (arr.length as number) * 10 + (v === undefined ? 1 : 0);
        }`),
    ).toBe(21);
  });

  it("throws RangeError for a negative length", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          try { Object.defineProperty(arr, "length", { value: -1 }); return 0; }
          catch (e) { return (e instanceof RangeError) ? 1 : 2; }
        }`),
    ).toBe(1);
  });

  it("throws RangeError for a non-integer length", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          try { Object.defineProperty(arr, "length", { value: 1.5 }); return 0; }
          catch (e) { return (e instanceof RangeError) ? 1 : 2; }
        }`),
    ).toBe(1);
  });

  it("a non-writable length rejects later value changes with TypeError", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "length", { writable: false });
          try { Object.defineProperty(arr, "length", { value: 2 }); return 0; }
          catch (e) { return (e instanceof TypeError) ? 1 : 2; }
        }`),
    ).toBe(1);
  });

  it("shrink stops at a non-configurable index and throws TypeError (step 15)", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "1", { value: 5, configurable: false });
          try {
            Object.defineProperty(arr, "length", { value: 0 });
            return 0;
          } catch (e) {
            // length must have stopped at the non-configurable index + 1
            return (arr.length as number) * 10 + ((e instanceof TypeError) ? 1 : 2);
          }
        }`),
    ).toBe(21);
  });

  it("grows the array through a length define", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "length", { value: 5 });
          return arr.length as number;
        }`),
    ).toBe(5);
  });

  it("an accessor length define throws TypeError (§10.4.2.1 step 2)", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          try { Object.defineProperty(arr, "length", { get: function (): any { return 5; } }); return 0; }
          catch (e) { return (e instanceof TypeError) ? 1 : 2; }
        }`),
    ).toBe(1);
  });
});

describe("#3251 — plural Object.defineProperties over an array target", () => {
  const MKD = `function mkDescs(): any {
    const d: any = {};
    d["0"] = { value: 101 };
    d["1"] = { value: 202, writable: false };
    return d;
  }`;

  it("routes a vec target through the overlay (was TypeError 'unsupported')", async () => {
    expect(
      await runStandalone(`${MK}
        ${MKD}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperties(arr, mkDescs());
          return (arr[0] as number) + (arr[1] as number);
        }`),
    ).toBe(303);
  });

  it("plural-defined writable:false refuses Reflect and throws on a later strict-module write", async () => {
    expect(
      await runStandalone(`${MK}
        ${MKD}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperties(arr, mkDescs());
          let caught = 0;
          try {
            arr[1] = 999;
          } catch (error) {
            caught = error instanceof TypeError ? 1 : 2;
          }
          const reflected = Reflect.set(arr, "1", 888);
          return caught * 1000 + (reflected === false ? 200 : 0) + (arr[1] as number);
        }`),
    ).toBe(1402);
  });

  it("plain-object defineProperties is unregressed", async () => {
    expect(
      await runStandalone(`function mk(): any { return {}; }
        export function test(): number {
          const o: any = mk();
          const d: any = {};
          d["x"] = { value: 7 };
          Object.defineProperties(o, d);
          return o.x as number;
        }`),
    ).toBe(7);
  });
});

describe("#3251 S3 — gOPD('length') synthesis", () => {
  it("reports {value, writable: true, enumerable: false, configurable: false} by default", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          const d: any = Object.getOwnPropertyDescriptor(arr, "length");
          if (!d) return -1;
          let n: number = (d.value as number) * 1000;
          if (d.writable === true) n = n + 100;
          if (d.enumerable === false) n = n + 10;
          if (d.configurable === false) n = n + 1;
          return n;
        }`),
    ).toBe(3111);
  });

  it("reflects a writable:false define", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "length", { writable: false });
          const d: any = Object.getOwnPropertyDescriptor(arr, "length");
          if (!d) return -1;
          let n: number = (d.value as number) * 1000;
          if (d.writable === false) n = n + 10;
          if (d.configurable === false) n = n + 1;
          return n;
        }`),
    ).toBe(3011);
  });

  it("stays LIVE after a push (reads the length field, not a companion copy)", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "length", { value: 3 });
          arr.push(9);
          const d: any = Object.getOwnPropertyDescriptor(arr, "length");
          return (d.value as number) * 10 + ((arr[3] as number) === 9 ? 1 : 0);
        }`),
    ).toBe(41);
  });

  it("string-key length read stays live too (no stale companion answer)", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "0", { value: 7 }); // overlay active
          arr.push(9);
          return arr["length"] as number;
        }`),
    ).toBe(4);
  });
});
