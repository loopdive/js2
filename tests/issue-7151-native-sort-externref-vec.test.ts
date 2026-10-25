// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7151 — a comparator-less `sort()` on a module-level array stored as the
// externref-element vec (`$__vec_externref`: a `const keys = []` filled by
// `push` / `for…in`) lowered to the #2502 no-op on gc native-first and
// standalone, so `keys.sort().join(",")` printed the unsorted order. It now
// runs SortCompare (§23.1.3.30.2) over the elements: undefined last, the rest by
// ToString in code-unit order. Pinned: each program's output equals V8's.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const show = `.map((v) => String(v)).join("|")`;

const PROGRAMS: Record<string, string> = {
  "for…in keys": `const keys = [];\nfor (const k in { b: 1, a: 2 }) keys.push(k);\nconsole.log(keys.sort().join(","));`,
  "pushed strings": `const s = []; s.push("c"); s.push("a"); s.push("b");\nconsole.log(s.sort().join());`,
  "pushed numbers": `const n = []; n.push(3); n.push(1); n.push(2);\nconsole.log(n.sort().join());`,
  "numbers compare as strings": `const n = []; n.push(10); n.push(9); n.push(1); n.push(100);\nconsole.log(n.sort().join());`,
  "reassigned to a literal": `let keys = [];\nfor (const k in { b: 1, a: 2 }) keys.push(k);\nkeys = ["z", "y"];\nconsole.log(keys.sort().join(","));`,
  "undefined sorts last": `const m = []; m.push(10); m.push(undefined); m.push("b"); m.push(9); m.push(undefined); m.push("a");\nconsole.log(m.sort()${show});`,
  "null sorts as 'null'": `const m = []; m.push("o"); m.push(null); m.push("m"); m.push(undefined); m.push("p");\nconsole.log(m.sort()${show});`,
  "booleans and signs": `const m = []; m.push(true); m.push(false); m.push(-1); m.push(0);\nconsole.log(m.sort()${show});`,
  "sorts in place": `const m = []; m.push("b"); m.push("a");\nm.sort();\nconsole.log(m.join());`,
  "empty and single": `const e = []; const o = []; o.push("x");\nconsole.log(String(e.sort().length) + o.sort().join());`,
  "inside a function (control)": `function f() { const s = []; s.push("c"); s.push("a"); return s.sort().join(); }\nconsole.log(f());`,
};

function runV8(src: string): string[] {
  const out: string[] = [];
  new Function("console", src)({ log: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out;
}

async function runWasm(src: string, target: "standalone" | "gc"): Promise<string[]> {
  const result = await compile(src, {
    fileName: "probe.js",
    deferTopLevelInit: true,
    ...(target === "standalone" ? { target: "standalone" as const, hostBridge: "always" as const } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const out: string[] = [];
  let exp: Record<string, (...a: number[]) => number>;
  if (target === "gc") {
    // The default (native-first) gc lane, run the way scripts/diff-test.ts runs it.
    const built = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    exp = instance.exports as typeof exp;
    const origLog = console.log;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    try {
      exp.__module_init?.();
    } finally {
      console.log = origLog;
    }
    return out;
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  exp = instance.exports as typeof exp;
  exp.__module_init?.();
  const len = exp.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < len; i++) sink += String.fromCharCode(exp.__stdout_char!(i) & 0xffff);
  for (const line of sink.split("\n")) if (line.length > 0) out.push(line);
  return out;
}

describe("#7151 comparator-less sort over an externref-element vec", () => {
  for (const target of ["gc", "standalone"] as const) {
    for (const [name, src] of Object.entries(PROGRAMS)) {
      it(`${target === "gc" ? "gc native-first" : "standalone"}: ${name}`, async () => {
        expect(await runWasm(src, target)).toEqual(runV8(src));
      });
    }
  }
});
