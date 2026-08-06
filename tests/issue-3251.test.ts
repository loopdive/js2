import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3251 S1 — standalone array-descriptor OVERLAY substrate.
//
// Under `--target standalone`, arrays are WasmGC `__vec_<k>` structs with no
// per-index/expando descriptor storage: `Object.defineProperty(arr, idx, d)`
// hit the `ref.test $Object` lenient no-op in the define natives, element
// reads never consulted accessors, `getOwnPropertyDescriptor` answered
// undefined, and redefine-legality never threw. S1 gives each vec receiver a
// side-table COMPANION `$Object` that the define/gOPD natives and the dynamic
// read lanes (`__extern_get_idx` / `__extern_get`) consult, with data-define
// values written back into the vec so the typed `array.get` fast path stays
// coherent. See plan/issues/3251-array-descriptor-overlay-substrate.md.
async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

// Dynamic receivers come from a helper fn so they are genuinely `any`-typed
// vec externrefs (the __extern_* dynamic lane), mirroring the test262 shape.
const MK = "function mkArr(): any { const a: any = [1, 2, 3]; return a; }";

describe("#3251 S1 — array-index defineProperty coherence (dynamic lane)", () => {
  it("value define is visible to a direct element read", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "0", { value: 101 });
          return arr[0] as number;
        }`),
    ).toBe(101);
  });

  it("getOwnPropertyDescriptor reports the defined value + attributes", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "0", { value: 101 });
          const d: any = Object.getOwnPropertyDescriptor(arr, "0");
          if (!d) return -1;
          // An existing element keeps its implicit w/e/c=true through a
          // value-only redefine (§10.1.6.3 merge preserves unspecified attrs).
          let n: number = d.value as number;
          if (d.writable === true) n = n + 1000;
          if (d.enumerable === true) n = n + 2000;
          if (d.configurable === true) n = n + 4000;
          return n;
        }`),
    ).toBe(7101);
  });

  it("gOPD synthesizes the implicit element descriptor for an untouched index", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "0", { value: 101 });
          const d: any = Object.getOwnPropertyDescriptor(arr, "1");
          if (!d) return -1;
          let n: number = d.value as number; // 2
          if (d.writable === true) n = n + 1000;
          if (d.configurable === true) n = n + 2000;
          return n;
        }`),
    ).toBe(3002);
  });

  it("redefining a non-configurable non-writable index throws a catchable TypeError", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "0", { value: 1, configurable: false, writable: false });
          try {
            Object.defineProperty(arr, "0", { value: 2 });
            return 0;
          } catch (e) {
            return 1;
          }
        }`),
    ).toBe(1);
  });

  it("re-defining the SAME value on a non-writable index is allowed (SameValue)", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "0", { value: 7, configurable: false, writable: false });
          try {
            Object.defineProperty(arr, "0", { value: 7 });
            return arr[0] as number;
          } catch (e) {
            return -1;
          }
        }`),
    ).toBe(7);
  });

  it("configurable-flip redefine on an existing element is legal and coherent", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "1", { value: 50, configurable: true });
          Object.defineProperty(arr, "1", { value: 60 });
          return arr[1] as number;
        }`),
    ).toBe(60);
  });
});

describe("#3251 S1 — accessor descriptors on array indices", () => {
  it("a defined getter is invoked by a direct element read", async () => {
    expect(
      await runStandalone(`function mkArr(): any { const a: any = [11, 12]; return a; }
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "1", { get: function (): any { return 100; }, configurable: true });
          return arr[1] as number;
        }`),
    ).toBe(100);
  });

  it("array generic methods (every) consult a defined accessor index — the ~204-test cluster shape", async () => {
    expect(
      await runStandalone(`function mkArr(): any { const a: any = [11, 12]; return a; }
        let accessed: any = false;
        function cb(val: any, idx: any, obj: any): any { return val > 10; }
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "1", { get: function (): any { accessed = true; return 100; }, configurable: true });
          const res: any = arr.every(cb);
          return (res === true ? 1 : 0) + (accessed === true ? 2 : 0);
        }`),
    ).toBe(3);
  });

  it("gOPD on an accessor index reports get/configurable, no value/writable", async () => {
    expect(
      await runStandalone(`function mkArr(): any { const a: any = [11, 12]; return a; }
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "1", { get: function (): any { return 100; }, configurable: true });
          const d: any = Object.getOwnPropertyDescriptor(arr, "1");
          if (!d) return -1;
          let n: number = 0;
          if (typeof d.get === "function") n = n + 1;
          if (d.configurable === true) n = n + 2;
          if (d.value === undefined) n = n + 4;
          return n;
        }`),
    ).toBe(7);
  });
});

describe("#3251 S1 — typed local lane (raw array.get reads)", () => {
  it("value define is visible to a typed element read (vec write-back)", async () => {
    expect(
      await runStandalone(`export function test(): number {
          const arr = [1, 2, 3];
          Object.defineProperty(arr, "0", { value: 101 });
          return arr[0];
        }`),
    ).toBe(101);
  });

  it("typed-lane redefine-legality also throws", async () => {
    expect(
      await runStandalone(`export function test(): number {
          const arr = [1, 2, 3];
          Object.defineProperty(arr, "0", { value: 1, configurable: false, writable: false });
          try {
            Object.defineProperty(arr, "0", { value: 2 });
            return 0;
          } catch (e) {
            return 1;
          }
        }`),
    ).toBe(1);
  });
});

describe("#3251 S1 — kind-incompatible values + named expandos", () => {
  it("a string value defined into a number array reads back via the companion", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "0", { value: "xyz" });
          const v: any = arr[0];
          return v === "xyz" ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("a named (non-index) expando define round-trips through the dynamic read lane", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "foo", { value: 42 });
          const d: any = Object.getOwnPropertyDescriptor(arr, "foo");
          const read: any = arr["foo"];
          return (d && d.value === 42 ? 1 : 0) + (read === 42 ? 2 : 0);
        }`),
    ).toBe(3);
  });

  it("fresh-index define keeps CompletePropertyDescriptor false defaults", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "5", { value: 9 });
          const d: any = Object.getOwnPropertyDescriptor(arr, "5");
          if (!d) return -1;
          let n: number = d.value as number; // 9
          if (d.writable === false) n = n + 1000;
          if (d.enumerable === false) n = n + 2000;
          if (d.configurable === false) n = n + 4000;
          return n;
        }`),
    ).toBe(7009);
  });
});

describe("#3251 S1 — no-regression guards", () => {
  it("plain arrays without defineProperty behave unchanged (map/length)", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          const out: any = arr.map(function (x: any): any { return (x as number) * 2; });
          return (out[0] as number) + (out[2] as number) + (arr.length as number);
        }`),
    ).toBe(11);
  });

  it("defineProperty on a PLAIN object is unaffected by the overlay", async () => {
    expect(
      await runStandalone(`function mk(): any { return {}; }
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 5, configurable: false });
          try {
            Object.defineProperty(o, "x", { value: 6 });
            return 0;
          } catch (e) {
            return (o.x as number);
          }
        }`),
    ).toBe(5);
  });

  it("length defines apply ArraySetLength (S3 — was a lenient no-op in S1)", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "length", { value: 2 });
          return arr.length as number;
        }`),
    ).toBe(2);
  });

  it("host mode compiles and runs the same program unchanged", async () => {
    const r = await compile(
      `${MK}
      export function test(): number {
        const arr: any = mkArr();
        return arr[0] as number;
      }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
  });
});
