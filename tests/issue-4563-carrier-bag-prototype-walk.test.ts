import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

/**
 * #4563 — a callable carrier's expando bag shadowed the prototype walk.
 *
 * `__closure_prop_get` consulted the carrier's own-property bag and `return`ed
 * **unconditionally** once that bag was non-null, so the §8.10.5 inherited-read
 * fallback below it became unreachable the moment ANY own property was defined
 * on a closure or a `$__bound_fn`:
 *
 *     var b = foo.bind({});
 *     Function.prototype.p = 12;
 *     b.p                                       // 12   — bag still null
 *     Object.defineProperty(b, "zz", {value: 1});
 *     b.p                                       // was undefined — want 12
 *
 * An ordinary object with a prototype keeps inheriting through the same
 * sequence, which is what isolates it to the carrier bag rather than the define.
 *
 * The discriminator has to be `hasOwn` on the bag, not "is the read undefined":
 * a bag entry whose stored value IS `undefined` is a real own property and must
 * still win over the prototype.
 *
 * This is a pure enabler — it moves no conformance row by itself. It is what
 * makes the §20.2.3.2 bound-function `length`/`name` seed viable: seeding those
 * own properties put every bound function into the broken state, which is why
 * that seed measured +2/−2 before this landed.
 */
async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e: { message: string }) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#4563 — an own property must not sever a callable carrier's prototype walk", () => {
  it("keeps a BOUND function inheriting from Function.prototype", async () => {
    expect(
      await runStandalone(`
        export function run(): number {
          const foo: any = function () {};
          const b: any = foo.bind({});
          (Function.prototype as any).p4563 = 12;
          Object.defineProperty(b, "zz", { value: 1, configurable: true });
          return b.p4563 === 12 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps a PLAIN closure inheriting from Function.prototype", async () => {
    // Not bound-specific: any callable carrier with a bag was affected.
    expect(
      await runStandalone(`
        export function run(): number {
          const g: any = function () {};
          (Function.prototype as any).p4563b = 12;
          Object.defineProperty(g, "zz", { value: 1, configurable: true });
          return g.p4563b === 12 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("still lets an OWN property win over the inherited one", async () => {
    expect(
      await runStandalone(`
        export function run(): number {
          const g: any = function () {};
          (Function.prototype as any).p4563c = 12;
          Object.defineProperty(g, "p4563c", { value: 99, configurable: true });
          return g.p4563c === 99 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("treats an own entry whose value is `undefined` as present, not absent", async () => {
    // The load-bearing negative for the `hasOwn` discriminator: a value test
    // would fall through to the prototype here and answer 12.
    expect(
      await runStandalone(`
        export function run(): number {
          const g: any = function () {};
          (Function.prototype as any).p4563d = 12;
          Object.defineProperty(g, "p4563d", { value: undefined, configurable: true });
          return g.p4563d === undefined ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("leaves the carrier's own property readable", async () => {
    expect(
      await runStandalone(`
        export function run(): number {
          const g: any = function () {};
          Object.defineProperty(g, "zz", { value: 7, configurable: true });
          return g.zz === 7 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("leaves an ordinary object's prototype walk alone", async () => {
    expect(
      await runStandalone(`
        export function run(): number {
          const proto: any = { p: 12 };
          const o: any = Object.create(proto);
          Object.defineProperty(o, "zz", { value: 1, configurable: true });
          return o.p === 12 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps an array inheriting after a dynamic element write creates its bag", async () => {
    expect(
      await runStandalone(`
        function set(o: any, k: any, v: any): void { o[k] = v; }
        function get(o: any, k: any): any { return o[k]; }
        export function run(): number {
          const expected: any = (Array.prototype as any).every;
          const a: any[] = [];
          set(a, 0, 1);
          return typeof expected === "function" && get(a, "every") === expected ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps an array inheriting after an unrelated named expando", async () => {
    expect(
      await runStandalone(`
        function set(o: any, k: any, v: any): void { o[k] = v; }
        function get(o: any, k: any): any { return o[k]; }
        export function run(): number {
          const expected: any = (Array.prototype as any).every;
          const a: any[] = [];
          set(a, "unrelated", 1);
          return typeof expected === "function" && get(a, "every") === expected ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("still lets an array own property with value undefined shadow the prototype", async () => {
    expect(
      await runStandalone(`
        function set(o: any, k: any, v: any): void { o[k] = v; }
        function get(o: any, k: any): any { return o[k]; }
        export function run(): number {
          const a: any[] = [];
          (Array.prototype as any).p4563vec = 12;
          set(a, "p4563vec", undefined);
          return get(a, "p4563vec") === undefined ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("binds an array descriptor getter to the original array", async () => {
    expect(
      await runStandalone(`
        function get(o: any, k: any): any { return o[k]; }
        let seen: any = null;
        export function run(): number {
          const a: any[] = [];
          Object.defineProperty(a, "own4563", {
            configurable: true,
            get: function (): number { seen = this; return 7; },
          });
          return get(a, "own4563") === 7 && seen === a ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("coerces an object key only once on an array bag hit", async () => {
    expect(
      await runStandalone(`
        function set(o: any, k: any, v: any): void { o[k] = v; }
        function get(o: any, k: any): any { return o[k]; }
        let calls = 0;
        export function run(): number {
          const a: any[] = [];
          set(a, "x", 7);
          const key: any = { toString: function (): string { calls += 1; return "x"; } };
          calls = 0;
          const value = get(a, key);
          return calls * 10 + value;
        }
      `),
    ).toBe(17);
  });

  it("coerces an object key only once when an array bag misses into its prototype", async () => {
    expect(
      await runStandalone(`
        function set(o: any, k: any, v: any): void { o[k] = v; }
        function get(o: any, k: any): any { return o[k]; }
        let calls = 0;
        export function run(): number {
          const a: any[] = [];
          (Array.prototype as any).x4563 = 7;
          set(a, "unrelated", 1);
          const key: any = { toString: function (): string { calls += 1; return "x4563"; } };
          calls = 0;
          const value = get(a, key);
          return calls * 10 + value;
        }
      `),
    ).toBe(17);
  });

  it("coerces an object key before the array descriptor overlay lookup", async () => {
    expect(
      await runStandalone(`
        function get(o: any, k: any): any { return o[k]; }
        let calls = 0;
        export function run(): number {
          const a: any[] = [];
          Object.defineProperty(a, "x4563overlay", { value: 7, configurable: true });
          const key: any = { toString: function (): string { calls += 1; return "x4563overlay"; } };
          calls = 0;
          const value = get(a, key);
          return calls * 10 + (value === 7 ? 1 : 0);
        }
      `),
    ).toBe(11);
  });
});
