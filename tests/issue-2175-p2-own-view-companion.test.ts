// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2175 P2 — the OWN-property views see entries written onto a builtin
 * prototype by `Object.defineProperty`.
 *
 * ## The gap
 *
 * `Object.defineProperty(Date.prototype, "p2", {value: 99})` stores the entry in
 * the brand COMPANION (`proto-index-store.ts`, #4176's substitution-by-recursion
 * write arms). #4176 wired the companion into `__extern_get` / `__extern_has`
 * only, so measured on `origin/main` @ `3e69b1e34`:
 *
 * | view | was | spec |
 * | --- | --- | --- |
 * | `Date.prototype.p2` (syntactic read) | 99 OK | 99 |
 * | `dp.p2` (flowing `$NativeProto`) | 99 OK | 99 |
 * | `"p2" in dp` | true OK | true |
 * | `hasOwnProperty(dp, "p2")` | **false** | true |
 * | `gOPD(dp, "p2")` / `gOPD(Date.prototype, "p2")` | **undefined** | a descriptor |
 *
 * Brand-independent (`Object.prototype` behaves identically) and receiver-form
 * independent — so it is the consult list, not a brand or a binding shape.
 *
 * ## The fix, and why the descriptor is right for free
 *
 * Both own-views SUBSTITUTE a `$NativeProto` receiver by its companion `$Object`
 * (`protoIndexOwnViewSubstituteInstrs`) and then run their existing `$Object`
 * path unchanged. The companion entry is an ordinary `$PropEntry` whose flags
 * the write arm already populated — `__defineProperty_value`'s companion
 * recursion passes the caller's flag word straight through — so gOPD reports the
 * REAL writable/enumerable/configurable bits rather than synthesized ones. That
 * is what the flag round-trip case below pins: guessed flags were explicitly
 * ruled out by the plan.
 *
 * Own-layer only: `create = 0`, no chain walk, and a non-`$NativeProto` receiver
 * is untouched — hence the inherited-property negative control.
 *
 * All cases `--target standalone`, zero `env` imports.
 */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, `compile failed:\n${(r.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const env = r.imports.filter((i) => i.module === "env");
  expect(env, `unexpected host imports: ${env.map((i) => i.name).join(", ")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2175 P2 — own-property views consult the NativeProto companion", () => {
  it("all five views agree on a defineProperty'd builtin-proto entry", async () => {
    expect(
      await runStandalone(`
        function opaque(x: any): any { return x; }
        export function test(): number {
          Object.defineProperty(Date.prototype, "p2", { value: 99, configurable: true });
          const dp: any = opaque(Date.prototype);
          const readSyn: number = ((Date.prototype as any).p2 === 99) ? 1 : 0;
          const readFlow: number = (dp.p2 === 99) ? 1 : 0;
          const inOp: number = ("p2" in dp) ? 1 : 0;
          const hasOwn: number = Object.prototype.hasOwnProperty.call(dp, "p2") ? 1 : 0;
          const gopdFlow: number = (Object.getOwnPropertyDescriptor(dp, "p2") !== undefined) ? 1 : 0;
          const gopdSyn: number = (Object.getOwnPropertyDescriptor(Date.prototype, "p2") !== undefined) ? 1 : 0;
          return (readSyn && readFlow && inOp && hasOwn && gopdFlow && gopdSyn) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("descriptor carries the REAL stored flags, not synthesized defaults", async () => {
    // Two shapes on one binary: all-absent attributes (⇒ all false) and
    // all-explicit-true. A synthesized descriptor would answer the same for both.
    expect(
      await runStandalone(`
        export function test(): number {
          Object.defineProperty(Date.prototype, "d1", { value: 99 });
          const d: any = Object.getOwnPropertyDescriptor(Date.prototype, "d1");
          const defaults: number =
            (d !== undefined && d.value === 99 && d.writable === false &&
             d.enumerable === false && d.configurable === false) ? 1 : 0;
          Object.defineProperty(Date.prototype, "d2",
            { value: 5, writable: true, enumerable: true, configurable: true });
          const e: any = Object.getOwnPropertyDescriptor(Date.prototype, "d2");
          const explicit: number =
            (e !== undefined && e.writable === true && e.enumerable === true &&
             e.configurable === true) ? 1 : 0;
          return (defaults === 1 && explicit === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("seeded builtin data methods remain writable and configurable through a flowing prototype", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const proto: any = Array.prototype;
          const key: any = "some";
          const original: any = proto[key];
          const before: any = Object.getOwnPropertyDescriptor(proto, key);
          const initial: number =
            (typeof original === "function" && before !== undefined &&
             before.writable === true && before.enumerable === false &&
             before.configurable === true) ? 1 : 0;

          proto[key] = 17;
          const replaced: number = (proto[key] === 17) ? 1 : 0;
          proto[key] = original;
          const restored: number = (proto[key] === original) ? 1 : 0;

          // Own-property queries must not confuse the inherited Object
          // companion entry with Array.prototype's deleted own method.
          const objectProto: any = Object.prototype;
          objectProto[key] = 99;
          const deleted: number = delete proto[key] ? 1 : 0;
          const absent: number =
            (!Object.prototype.hasOwnProperty.call(proto, key) &&
             !Object.hasOwn(proto, key) && Object.hasOwn(objectProto, key) &&
             Object.getOwnPropertyDescriptor(proto, key) === undefined &&
             proto[key] === 99) ? 1 : 0;

          // Brand-independent: the same mutable table owns Date methods.
          const dateProto: any = Date.prototype;
          const dateKey: any = "getDate";
          const dateOriginal: any = dateProto[dateKey];
          dateProto[dateKey] = 23;
          const dateReplaced: number = (dateProto[dateKey] === 23) ? 1 : 0;
          dateProto[dateKey] = dateOriginal;
          const dateRestored: number = (dateProto[dateKey] === dateOriginal) ? 1 : 0;
          const dateDeleted: number = delete dateProto[dateKey] ? 1 : 0;
          const dateAbsent: number = Object.hasOwn(dateProto, dateKey) ? 0 : 1;

          return (initial && replaced && restored && deleted && absent &&
                  dateReplaced && dateRestored && dateDeleted && dateAbsent) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("an IR-compiled dynamic reader observes a companion method replacement", async () => {
    const result = await compile(
      `
        export function getProto(): any { return Array.prototype; }
        export function replace(proto: any): void { proto["some"] = 17; }
        export function read(proto: any): any { return proto["some"]; }
      `,
      {
        fileName: "issue-2175-ir-reader.ts",
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );
    expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("read");

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as {
      getProto(): unknown;
      replace(proto: unknown): void;
      read(proto: unknown): unknown;
    };
    const proto = exports.getProto();
    exports.replace(proto);
    expect(exports.read(proto)).toBe(17);
  });

  it("brand-independent — Object.prototype behaves the same as Date.prototype", async () => {
    expect(
      await runStandalone(`
        function opaque(x: any): any { return x; }
        export function test(): number {
          Object.defineProperty(Object.prototype, "q", { value: 7, configurable: true });
          const op: any = opaque(Object.prototype);
          const read: number = (op.q === 7) ? 1 : 0;
          const hasOwn: number = Object.prototype.hasOwnProperty.call(op, "q") ? 1 : 0;
          return (read === 1 && hasOwn === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("ACCESSOR descriptors compile to valid Wasm and are visible to the own-views", async () => {
    // REGRESSION GUARD. The first cut of P2 baked `ctx.nativeProtoTypeIdx` into a
    // `ref.test` at object-runtime REGISTRATION time; a later type registration
    // shifted indices, so this exact program failed to instantiate:
    //   CompileError: Compiling function "__hasOwnProperty" failed: Invalid types
    //   for ref.test: any.convert_extern of type anyref has to be in the same
    //   reference type hierarchy as (ref 59)
    // Every P2 probe and test used VALUE descriptors, so the accessor arm was
    // never exercised and the battery reported green. The helper now resolves
    // that type index at FINALIZE (like every other proto-index arm).
    //
    // Both descriptor KINDS run on ONE binary here — descriptor kind is a
    // mandatory gate axis for this substrate, alongside receiver form and brand.
    expect(
      await runStandalone(`
        function opaque(x: any): any { return x; }
        export function test(): number {
          // accessor descriptor on a builtin prototype (the shape that broke)
          Object.defineProperty(Array.prototype, "acc", {
            get: function (): any { return 42; },
            set: function (v: any): void { /* no-op */ },
            configurable: true
          });
          // …and a value descriptor on the same binary
          Object.defineProperty(Date.prototype, "val", { value: 7, configurable: true });

          const ap: any = opaque(Array.prototype);
          const dp: any = opaque(Date.prototype);
          const accOwn: number = Object.prototype.hasOwnProperty.call(ap, "acc") ? 1 : 0;
          const accDesc: any = Object.getOwnPropertyDescriptor(ap, "acc");
          const accIsAccessor: number =
            (accDesc !== undefined && typeof accDesc.get === "function") ? 1 : 0;
          const valOwn: number = Object.prototype.hasOwnProperty.call(dp, "val") ? 1 : 0;
          const valDesc: any = Object.getOwnPropertyDescriptor(dp, "val");
          const valIsData: number = (valDesc !== undefined && valDesc.value === 7) ? 1 : 0;
          return (accOwn && accIsAccessor && valOwn && valIsData) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("ANTI-VACUITY: absent keys, inherited keys and unwritten brands are unaffected", async () => {
    // Without these an arm that answered "own" for everything would pass above.
    expect(
      await runStandalone(`
        function opaque(x: any): any { return x; }
        export function test(): number {
          Object.defineProperty(Date.prototype, "d1", { value: 99, configurable: true });
          const dp: any = opaque(Date.prototype);
          const absentDesc: number = (Object.getOwnPropertyDescriptor(Date.prototype, "nope") === undefined) ? 1 : 0;
          const absentOwn: number = Object.prototype.hasOwnProperty.call(dp, "nope") ? 0 : 1;
          const plain: any = { a: 1 };
          // an INHERITED key must still not be an own property
          const inherited: number = Object.prototype.hasOwnProperty.call(plain, "toString") ? 0 : 1;
          const ownStillOwn: number = Object.prototype.hasOwnProperty.call(plain, "a") ? 1 : 0;
          // a brand nobody wrote to has no companion at all
          const unwritten: number = (Object.getOwnPropertyDescriptor(Map.prototype, "zzz") === undefined) ? 1 : 0;
          return (absentDesc && absentOwn && inherited && ownStillOwn && unwritten) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
