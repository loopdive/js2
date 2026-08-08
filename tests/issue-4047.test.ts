/**
 * #4047 — the `unsupported descriptor shape in standalone mode (#1906)` family
 * is a RECEIVER-REPRESENTATION refusal, not a descriptor-shape one. Measured
 * over all 952 files under `built-ins/Object/{defineProperties,create}` on the
 * CI path: 53 refusals (50 goal-scope), and ZERO of them reach either
 * per-descriptor site.
 *
 * Every case pins an EXACT outcome code, never merely "does not throw":
 *   0 defined-ok · 1 silent-noop · 2 THREW · 3 other · 4 defined-wrong
 * Distinguishing 0 from 1 is the whole point — a silent no-op is what this
 * gate exists to prevent, and it is invisible to a does-not-throw assertion.
 *
 * The NEGATIVE cases are as load-bearing as the positive ones.
 * `__defineProperty_value`'s terminal arm for a carrier-less receiver is a
 * LENIENT no-op that returns O unchanged, so relaxing one refusal too far
 * reads as a pure win while manufacturing vacuous passes — exactly the trap
 * #3957 measured and rejected.
 *
 * B1/B2/C1/F3 (Function and Array `Properties`) are here as refusals ON
 * PURPOSE, and the history matters. A carrier-bag arm that resolved those
 * receivers through the #4032 `__integrity_bag` resolver was implemented and
 * measured at +6 more test262 files — then REVERTED, because #3957's own
 * invariant tests proved it unsound: the bag holds `props.p = v` but NOT
 * `Object.defineProperty(props, "p", …)`, which for an Array lands in the
 * separate #3251 overlay companion and for a Function lands nowhere. Nothing
 * distinguishes the two at runtime, so the arm answered "no own properties"
 * for a receiver that had them. Do not re-add it before #4010 makes one store
 * authoritative.
 *
 * G1–G4 guard the gains this sits on top of: #3957 RC1 (descriptor read via
 * [[Get]]), #3957 RC2 (closed-struct map via identifier), the static
 * object-literal expansion, and #4032 integrity predicates on an Array.
 *
 * Kill-switch: restore the `ref.test $Object` gate on either receiver in
 * `__defineProperties` and A1–A3, D1 and F1–F2 revert to code 2.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: { name: string }[] };

async function run(src: string): Promise<string> {
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as Compiled;
  if (!r.success) return `COMPILE_ERROR: ${JSON.stringify(r.errors).slice(0, 240)}`;
  const imports = (r.imports ?? []).map((i) => i.name);
  try {
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const v = (instance.exports as { test?: () => unknown }).test?.();
    return `v=${String(v)} imports=${imports.length}`;
  } catch (e) {
    return `HOSTERR ${String(e).slice(0, 200)} imports=${imports.length}`;
  }
}

// 0 defined-ok / 1 silent-noop / 2 THREW / 3 other / 4 defined-wrong
const CASES: Record<string, [string, number]> = {
  "POSCTRL $Object Properties [0]": [
    `export function test(): number {
      const obj: any = {};
      const props: any = {};
      Object.defineProperty(props, "prop", { value: { value: 42, enumerable: true }, enumerable: true });
      try { Object.defineProperties(obj, props); return obj.hasOwnProperty("prop") ? 0 : 1; } catch (e) { return 2; }
    }`,
    0,
  ],
  "NEGCTRL primitive descriptor entry still THROWS [2]": [
    `export function test(): number {
      const obj: any = {};
      const props: any = {};
      props.prop = 5;
      try { Object.defineProperties(obj, props); return obj.hasOwnProperty("prop") ? 0 : 1; } catch (e) { return 2; }
    }`,
    2,
  ],
  "A1 primitive Properties false -> no-op, returns O [0]": [
    `export function test(): number {
      const obj: any = {};
      try { const o1 = Object.defineProperties(obj, false as any); return o1 === obj ? 0 : 3; } catch (e) { return 2; }
    }`,
    0,
  ],
  "A2 primitive Properties -12 -> no-op [0]": [
    `export function test(): number {
      const obj: any = {};
      try { const o1 = Object.defineProperties(obj, -12 as any); return o1 === obj ? 0 : 3; } catch (e) { return 2; }
    }`,
    0,
  ],
  "A3 empty-string Properties -> no-op [0]": [
    `export function test(): number {
      const obj: any = {};
      try { const o1 = Object.defineProperties(obj, "" as any); return o1 === obj ? 0 : 3; } catch (e) { return 2; }
    }`,
    0,
  ],
  "A4 NON-empty string Properties -> still refuses loudly [2]": [
    `export function test(): number {
      const obj: any = {};
      try { Object.defineProperties(obj, "ab" as any); return 3; } catch (e) { return 2; }
    }`,
    2,
  ],
  "A5 undefined Properties -> TypeError [2]": [
    `export function test(): number {
      try { Object.defineProperties({} as any, undefined as any); return 3; } catch (e) { return 2; }
    }`,
    2,
  ],
  "A6 null Properties -> TypeError [2]": [
    `export function test(): number {
      try { Object.defineProperties({} as any, null as any); return 3; } catch (e) { return 2; }
    }`,
    2,
  ],
  // (#4161) B1/B2 flipped DELIBERATELY from the [2] refusal pins: the closure
  // bag is now authoritative for a FUNCTION Properties map (defines land in the
  // same #3468 bag assignments do, via the #4161 applier arms), so the gate
  // enumerates the bag instead of refusing. (#4230 later moved C1 too, by a
  // different route — see the note there; C2 still holds.)
  "B1 FUNCTION Properties -> bag enumerated, define lands (#4161) [0]": [
    `export function test(): number {
      const obj: any = {};
      const props: any = function () {};
      props.prop = { value: 1, enumerable: true };
      try { Object.defineProperties(obj, props); return obj.hasOwnProperty("prop") ? (obj.prop === 1 ? 0 : 4) : 1; } catch (e) { return 2; }
    }`,
    0,
  ],
  "B2 FUNCTION Properties accessor descriptor -> setter installed (#4161) [0]": [
    `let data = "data";
    export function test(): number {
      const obj: any = {};
      const descFun: any = function () {};
      descFun.prop = { set: function (v: any) { data = v; } };
      try {
        Object.defineProperties(obj, descFun);
        if (!obj.hasOwnProperty("prop")) return 1;
        obj.prop = "funData";
        return data === "funData" ? 0 : 4;
      } catch (e) { return 2; }
    }`,
    0,
  ],
  // (#4230) C1 flipped DELIBERATELY from its [2] refusal pin, on the same
  // grounds B1/B2 flipped for closures — but reached differently. A vec's own
  // named properties are split across TWO stores (assignments → the #3537 bag,
  // defines → the #3251 overlay companion), so no single store is
  // authoritative and the C1 comment above was right to say so. #4230's
  // finding is that the gate needs a COMPLETE key source, not a single one:
  // `__vec_props_keysrc` unions the two, which is exactly as complete.
  // C2 must still NOT move — an INDEXED vec has own keys in `$data`, which is
  // in neither side table, so it keeps refusing under [SITE-PROPS-VEC-INDEXED].
  "C1 empty ARRAY Properties with expando -> bag ∪ overlay enumerated (#4230) [0]": [
    `export function test(): number {
      const obj: any = {};
      const props: any = [];
      props.prop = { value: 8, enumerable: true };
      try { Object.defineProperties(obj, props); return obj.hasOwnProperty("prop") ? (obj.prop === 8 ? 0 : 4) : 1; } catch (e) { return 2; }
    }`,
    0,
  ],
  "C2 NON-empty ARRAY Properties -> still refuses loudly [2]": [
    `export function test(): number {
      const obj: any = {};
      const props: any = [{ value: 1 }];
      props.prop = { value: 8, enumerable: true };
      try { Object.defineProperties(obj, props); return obj.hasOwnProperty("prop") ? 0 : 1; } catch (e) { return 2; }
    }`,
    2,
  ],
  "D1 ARRAY receiver O with $Object Properties [0]": [
    `export function test(): number {
      try {
        const arr: any = [0];
        const props: any = {};
        Object.defineProperty(props, "0", { value: { value: 42, enumerable: true, configurable: true }, enumerable: true });
        Object.defineProperties(arr, props);
        return arr[0] === 42 ? 0 : 4;
      } catch (e) { return 2; }
    }`,
    0,
  ],
  // Flipped from the [2] refusal pin: Date GAINED a substrate when
  // `builtinInstanceCarrierTypeIdxs` (src/codegen/closure-props.ts) added
  // `__Date`/`__StandaloneRegExp` to the closure-bag carrier chain. The define
  // now lands and the read-back is correct, so the old "(no substrate)" premise
  // has expired — same shape as F3 below.
  "D2 DATE receiver O -> bag carrier, define lands [0]": [
    `export function test(): number {
      try {
        const d: any = new Date(0);
        const props: any = {};
        Object.defineProperty(props, "p", { value: { value: 1, enumerable: true }, enumerable: true });
        Object.defineProperties(d, props);
        return d.p === 1 ? 0 : 1;
      } catch (e) { return 2; }
    }`,
    0,
  ],
  "D3 primitive receiver O -> TypeError [2]": [
    `export function test(): number {
      try { Object.defineProperties(5 as any, {} as any); return 3; } catch (e) { return 2; }
    }`,
    2,
  ],
  // Flipped from the [2] refusal pin, same mechanism as D2: a Date used AS the
  // `Properties` map is now a bag carrier, so its own properties enumerate and
  // the define lands on the target.
  "E1 DATE Properties -> bag enumerated, define lands [0]": [
    `export function test(): number {
      const obj: any = {};
      const props: any = new Date(0);
      props.prop = { value: 1, enumerable: true };
      try { Object.defineProperties(obj, props); return obj.hasOwnProperty("prop") ? 0 : 1; } catch (e) { return 2; }
    }`,
    0,
  ],
  "F1 Object.create(proto, undefined) -> skips, returns obj [0]": [
    `export function test(): number {
      try { const o: any = Object.create({}, undefined as any); return o !== null && o !== undefined ? 0 : 1; } catch (e) { return 2; }
    }`,
    0,
  ],
  "F2 Object.create(proto, void 0) -> skips [0]": [
    `export function test(): number {
      try { const o: any = Object.create({}, void 0 as any); return o !== null && o !== undefined ? 0 : 1; } catch (e) { return 2; }
    }`,
    0,
  ],
  // (#4161) Flipped from the [2] refusal pin — same mechanism as B1 above;
  // Object.create shares the __defineProperties gate.
  "F3 Object.create(proto, fnProps) -> bag enumerated, define lands (#4161) [0]": [
    `export function test(): number {
      const props: any = function () {};
      props.prop = { value: 3, enumerable: true };
      try { const o: any = Object.create({}, props); return o.hasOwnProperty("prop") ? (o.prop === 3 ? 0 : 4) : 1; } catch (e) { return 2; }
    }`,
    0,
  ],
  "G1 REGRESSION GUARD: static object-literal Properties still works [0]": [
    `export function test(): number {
      const obj: any = {};
      try {
        Object.defineProperties(obj, { a: { value: 100, enumerable: true, writable: true, configurable: true } });
        return obj.a === 100 ? 0 : 4;
      } catch (e) { return 2; }
    }`,
    0,
  ],
  "G2 REGRESSION GUARD: closed-struct map via identifier (#3957 RC2) [0]": [
    `export function test(): number {
      const obj: any = {};
      const properties = {
        a: { value: 100, enumerable: true, writable: true, configurable: true },
        c: { value: 200, enumerable: true, writable: true, configurable: true },
      };
      try { Object.defineProperties(obj, properties); return obj.a === 100 && obj.c === 200 ? 0 : 4; } catch (e) { return 2; }
    }`,
    0,
  ],
  "G3 REGRESSION GUARD: accessor-defined descriptor entry (#3957 RC1) [0]": [
    `export function test(): number {
      const obj: any = {};
      const props: any = {};
      Object.defineProperty(props, "prop", { get: function () { return { value: 42, enumerable: true }; }, enumerable: true });
      try { Object.defineProperties(obj, props); return obj.hasOwnProperty("prop") ? (obj.prop === 42 ? 0 : 4) : 1; } catch (e) { return 2; }
    }`,
    0,
  ],
  "G4 REGRESSION GUARD: Object.freeze/isFrozen on array (#4032) [0]": [
    `export function test(): number {
      try {
        const arr: any = [1, 2];
        if (Object.isFrozen(arr)) return 3;
        Object.freeze(arr);
        return Object.isFrozen(arr) ? 0 : 4;
      } catch (e) { return 2; }
    }`,
    0,
  ],
};

describe("#4047 receiver resolution", () => {
  for (const [name, [src, want]] of Object.entries(CASES)) {
    it(
      name,
      async () => {
        const got = await run(src);
        expect(got, name).toBe(`v=${want} imports=0`);
      },
      180000,
    );
  }
});
