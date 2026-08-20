// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4230) Dynamic descriptor bags in `--target standalone`:
// `Object.defineProperties(O, props)` / `Object.create(proto, props)` where
// `props` is not a plain `$Object`.
//
// Two root causes, one file:
//
//   1. A VEC `Properties` map (Array / `arguments`) was refused with
//      `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]` because its own named properties
//      are split across TWO stores — assignments land in the #3537 bag,
//      `Object.defineProperty` lands in the #3251 overlay companion — and
//      neither alone is a complete key source. #4230's finding is that
//      COMPLETENESS is the precondition, not singularity: the union of the two
//      is exactly as complete, and `__vec_props_keysrc` builds it.
//   2. The receiver-carrier refusal `[SITE-O-NO-CARRIER]` fired before the key
//      walk, so `Object.defineProperties(closedStruct, -12)` threw where the
//      spec says "return O" — a receiver needs a store for a descriptor, not
//      for the absence of one.
//
// Every expectation below is the value **Node** produces for the identical
// source. The indexed-vec refusal row is the other half of the contract: what
// has no complete key source must keep refusing LOUDLY rather than defining
// nothing.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(source: string): Promise<Record<string, number>> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  const exports = instance.exports as Record<string, () => number>;
  const out: Record<string, number> = {};
  for (const name of Object.keys(exports)) {
    if (typeof exports[name] === "function" && name.startsWith("t_")) out[name] = exports[name]!();
  }
  return out;
}

/** `1` when the body threw, `0` when it completed. */
const threw = (body: string): string => `try {\n${body}\nreturn 0;\n} catch (e) {\nreturn 1;\n}`;

// name -> [body, expected]. `expected` is Node's answer for the identical source.
const CASES: Array<[string, string, number]> = [
  // ── 1. vec Properties, descriptor in the #3251 OVERLAY ────────────────────
  [
    "t_overlay_data",
    `const obj: any = {};
     const props: any = [];
     Object.defineProperty(props, "prop", { value: { value: 8 }, enumerable: true });
     Object.defineProperties(obj, props);
     return obj.prop;`,
    8,
  ],
  [
    "t_overlay_getter_runs",
    // The getter must actually RUN (§20.1.2.3.1 step 3.b is a real [[Get]]) and
    // its RESULT must be used as the descriptor — 100 proves the side effect,
    // 5 proves the value.
    `let ran = 0;
     const obj: any = {};
     const props: any = [];
     Object.defineProperty(props, "prop", {
       get: function () { ran = 1; return { value: 5 }; },
       enumerable: true,
     });
     Object.defineProperties(obj, props);
     return ran * 100 + obj.prop;`,
    105,
  ],
  // ── 2. vec Properties, descriptor in the #3537 BAG ────────────────────────
  [
    "t_bag_data",
    `const obj: any = {};
     const props: any = [];
     props.prop = { value: 9 };
     Object.defineProperties(obj, props);
     return obj.prop;`,
    9,
  ],
  [
    "t_bag_accessor",
    // The `set` half of a bag-stored descriptor must install a live setter.
    `let data = 0;
     const obj: any = {};
     const props: any = [];
     props.prop = { set: function (v: any) { data = v; } };
     Object.defineProperties(obj, props);
     obj.prop = 7;
     return data;`,
    7,
  ],
  // ── 3. BOTH stores at once — the union is the whole point ─────────────────
  [
    "t_union_of_both_stores",
    `const obj: any = {};
     const props: any = [];
     props.a = { value: 1 };
     Object.defineProperty(props, "b", { value: { value: 2 }, enumerable: true });
     Object.defineProperties(obj, props);
     return obj.a + obj.b;`,
    3,
  ],
  // ── 4. `arguments` is a vec too ───────────────────────────────────────────
  [
    "t_arguments_props",
    `const obj: any = {};
     let arg: any;
     (function fun() { arg = arguments; }());
     Object.defineProperty(arg, "prop", { value: { value: 17 }, enumerable: true });
     Object.defineProperties(obj, arg);
     return obj.prop;`,
    17,
  ],
  // ── 5. enumerability of the PROPERTIES map is honoured ────────────────────
  [
    "t_nonenumerable_props_entry_skipped",
    // §20.1.2.3.1 walks own ENUMERABLE keys only. A non-enumerable entry in the
    // map must define nothing — the discriminator that proves the key source
    // filters rather than dumping every entry it finds.
    `const obj: any = {};
     const props: any = [];
     Object.defineProperty(props, "prop", { value: { value: 8 }, enumerable: false });
     Object.defineProperties(obj, props);
     return obj.hasOwnProperty("prop") ? 1 : 0;`,
    0,
  ],
  // ── 6. Object.create routes through the same gate ─────────────────────────
  [
    "t_create_with_vec_props",
    `const props: any = [];
     props.prop = { value: 12, enumerable: true };
     const newObj: any = Object.create({}, props);
     return newObj.hasOwnProperty("prop") ? newObj.prop : -1;`,
    12,
  ],
  // ── 7. the deferred receiver-carrier gate (#4230 RC2) ─────────────────────
  [
    "t_primitive_props_returns_O",
    // `Properties` is a number: ToObject yields a fresh wrapper with no own
    // enumerable properties, so the key walk is empty and "return O" is the
    // complete answer — for ANY receiver, including a closed struct with no
    // descriptor store.
    `const obj: any = { "123": 100 };
     const obj1: any = Object.defineProperties(obj, (-12) as any);
     return obj1 === obj ? 1 : 0;`,
    1,
  ],
  [
    "t_empty_string_props_returns_O",
    `const obj: any = { "123": 100 };
     const obj1: any = Object.defineProperties(obj, "" as any);
     return obj1 === obj ? 1 : 0;`,
    1,
  ],
  // ── 8. carrier coverage and the remaining loud refusal ───────────────────
  [
    "t_indexed_vec_props_refuses",
    // An array WITH elements has own index keys living in `$data`, which is in
    // neither side table. No complete key source ⇒ keep refusing
    // ([SITE-PROPS-VEC-INDEXED]) rather than silently dropping them.
    `const obj: any = {};
     const props: any = [{ value: 1 }];
     ${threw(`Object.defineProperties(obj, props);`)}`,
    1,
  ],
  [
    "t_error_props_defines",
    // #4098 gives native Error instances an authoritative own-property store,
    // so they are valid Properties maps and the descriptor must be copied.
    `const obj: any = {};
     const props: any = new Error("test");
     props.prop = { value: 16 };
     Object.defineProperties(obj, props);
     return obj.prop;`,
    16,
  ],
  // ── 9. controls — the untouched `$Object` path ────────────────────────────
  [
    "t_control_plain_object_props",
    `const obj: any = {};
     Object.defineProperties(obj, { a: { value: 1 }, b: { value: 2 } });
     return obj.a + obj.b;`,
    3,
  ],
  [
    "t_control_array_length_define",
    // #3984 / #4227's ArraySetLength routing must be unaffected.
    `const a: any = [1, 2, 3];
     Object.defineProperties(a, { length: { value: 2 } });
     return a.length;`,
    2,
  ],
  [
    "t_control_vec_receiver_index_define",
    // A vec RECEIVER (not Properties) still routes to the #3251 overlay.
    `const arr: any = [0];
     const props: any = {};
     Object.defineProperty(props, "0", {
       value: { value: 42, enumerable: true, configurable: true },
       enumerable: true,
     });
     Object.defineProperties(arr, props);
     return arr[0];`,
    42,
  ],
];

describe("#4230 — dynamic descriptor bags (standalone)", () => {
  const source = CASES.map(([name, body]) => `export function ${name}(): number {\n${body}\n}`).join("\n");

  it("matches Node on every descriptor-bag shape", async () => {
    const got = await run(source);
    const expected = Object.fromEntries(CASES.map(([name, , want]) => [name, want]));
    expect(got).toEqual(expected);
  }, 240_000);
});
