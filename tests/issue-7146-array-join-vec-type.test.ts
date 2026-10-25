// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7146 — the native-strings `join` skips its receiver probe for a `.sort()`
// receiver (closure registration is not transactional), and then took the
// checker's `string[]` vec for `keys.sort().join(",")` while `keys` — filled by
// `for…in` — is stored as an externref-element vec:
//   local.tee[0] expected type (ref null 42), found ref.as_non_null of type (ref 2)
// `x.sort()` returns `x`, so the join now reads the vec type off `x`'s slot.
// Pinned: the join's `__njoin_vec` local has the receiver global's storage type.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const CORPUS = `const o = { a: 1, b: 2 };
const keys = [];
for (const k in o) keys.push(k);
console.log(keys.sort().join(","));
`;

const PROGRAMS: [string, string, string][] = [
  ["for…in (corpus control/12)", CORPUS, "keys"],
  [
    "for…in inside a function",
    `const keys = [];\nexport function f() { for (const k in { b: 1, a: 2 }) keys.push(k); return keys.sort().join("-"); }\n`,
    "keys",
  ],
  [
    "for…in, comparator sort",
    `const keys = [];\nfor (const k in { b: 1, a: 2 }) keys.push(k);\nconsole.log(keys.sort((x, y) => (x < y ? -1 : 1)).join(","));\n`,
    "keys",
  ],
  ["push-grown", `const a = [];\na.push("y");\na.push("z");\nconsole.log(a.sort().join());\n`, "a"],
  ["literal", `const l = ["c", "a", "b"];\nconsole.log(l.sort().join("|"));\n`, "l"],
  // `.sort()` over a non-identifier receiver: the sort/filter layers are peeled
  // and the remainder probed (#7146 review).
  ...[
    `keys.slice().sort().join(",")`,
    `keys.sort().sort().join()`,
    `keys.reverse().sort().join()`,
    `keys.concat([]).sort().join()`,
    `keys.sort((x, y) => (x < y ? -1 : 1)).sort().join()`,
    `keys.filter((x) => x !== "b").sort().join(",")`,
    `keys.filter((x) => x !== "b").join(",")`,
  ].map((e): [string, string, string] => [
    `chain ${e}`,
    `const keys = [];\nfor (const k in { c: 1, a: 2, b: 3 }) keys.push(k);\nconsole.log(${e});\n`,
    "keys",
  ]),
];

function typeOf(wat: string, re: RegExp): string | undefined {
  return wat.match(re)?.[1];
}

describe("#7146 native join takes the storage vec type", () => {
  for (const target of [undefined, "standalone"] as const) {
    for (const [name, src, recv] of PROGRAMS) {
      it(`${target ?? "gc native-first"}: ${name}`, async () => {
        const r = await compile(src, { fileName: "probe.js", emitWat: true, ...(target ? { target } : {}) });
        expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(r.binary)).toBe(true);
        const storage = typeOf(r.wat, new RegExp(`\\(global \\$__mod_${recv} \\(mut (\\(ref null \\d+\\))\\)`));
        const joinVec = typeOf(r.wat, /\(local \$__njoin_vec_\d+ (\(ref null \d+\))\)/);
        expect(storage, "receiver global").toBeDefined();
        expect(joinVec, "__njoin_vec local").toBe(storage);
      });
    }
  }
});
