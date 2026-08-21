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
});
