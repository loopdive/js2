import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3251 S2 — dynamic write-lane enforcement over the array-descriptor overlay.
//
// S1 gave vec receivers a companion $Object for descriptor storage but plain
// writes bypassed it: `writable:false` was not enforced, setters were never
// invoked, and a dynamic write left the companion's stored value stale for
// gOPD. S2 splices an overlay WRITE prologue into `__extern_set` (in front of
// the #3190 in-bounds vec-store arm; `__extern_set_strict` is an alias of the
// same native): accessor entries invoke `set` with the vec as `this`,
// non-writable data entries drop the write (sloppy), companion-authoritative
// values update in place, and plain writable data entries refresh the
// companion before falling through to the vec store.
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

describe("#3251 S2 — write-lane enforcement (dynamic lane)", () => {
  it("a plain write to a writable:false index never lands (strict throw or sloppy drop)", async () => {
    // Compiled TS is module (strict) code, and current main's write lane
    // throws a catchable TypeError on a non-writable index write — either
    // way the value must be unchanged. (The fork-era S2 expected a silent
    // sloppy drop; main hardened this before the port landed.)
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "0", { value: 1, writable: false });
          try {
            arr[0] = 99;
          } catch (e) {}
          return arr[0] as number;
        }`),
    ).toBe(1);
  });

  it("a defined setter is invoked with the ARRAY as this", async () => {
    expect(
      await runStandalone(`${MK}
        let got: any = -1;
        let thisLen: any = -1;
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "1", {
            get: function (): any { return got; },
            set: function (v: any): any { got = v; thisLen = (this as any).length; },
            configurable: true,
          });
          arr[1] = 42;
          return (got === 42 ? 42 : 0) + (thisLen === 3 ? 100 : 0);
        }`),
    ).toBe(142);
  });

  it("a getter-only index refuses Reflect and throws in strict module code without changing value", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "1", { get: function (): any { return 100; }, configurable: true });
          let caught = 0;
          try {
            arr[1] = 5;
          } catch (error) {
            caught = error instanceof TypeError ? 1 : 2;
          }
          const reflected = Reflect.set(arr, "1", 6);
          return caught * 1000 + (reflected === false ? 200 : 0) + (arr[1] as number);
        }`),
    ).toBe(1300);
  });

  it("gOPD stays fresh after a dynamic write to a writable defined index", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "0", { value: 7, writable: true, configurable: true });
          arr[0] = 55;
          const d: any = Object.getOwnPropertyDescriptor(arr, "0");
          return d ? (d.value as number) : -1;
        }`),
    ).toBe(55);
  });

  it("a companion-authoritative (kind-incompatible) value accepts writes in place", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "0", { value: "a" });
          arr[0] = "b";
          const v: any = arr[0];
          return v === "b" ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("plain writes to un-overlaid indices still land in the vec (fall-through)", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          Object.defineProperty(arr, "2", { value: 30 });
          arr[1] = 9;
          return (arr[1] as number) * 10 + (arr[2] as number === 30 ? 1 : 0);
        }`),
    ).toBe(91);
  });

  it("writes on arrays with NO descriptors keep the zero-overlay fast path", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const arr: any = mkArr();
          arr[0] = 5;
          arr[1] = 6;
          return (arr[0] as number) + (arr[1] as number) + (arr[2] as number);
        }`),
    ).toBe(14);
  });
});
