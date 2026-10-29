// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7148 — the native `__object_assign` (object spread + Object.assign) walked an
// open `$Object` source's property table in HASH order, so `{ ...{ x, y }, z }`
// enumerated `y, x, z` on gc native-first and standalone (V8: `x, y, z`). It now
// copies in OrdinaryOwnPropertyKeys order: integer keys ascending, then string
// keys by insertion, then symbols. Pinned: each program's output equals V8's.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const PROGRAMS: Record<string, string> = {
  "corpus object/02-spread": `const a = { x: 1, y: 2 };
const b = { ...a, z: 3 };
console.log(Object.keys(b).join(","));
console.log(String(b.x) + " " + String(b.z));`,
  "spread first": `const a = { x: 1, y: 2 };\nconsole.log(Object.keys({ z: 3, ...a }).join(","));`,
  "copy only": `const a = { x: 1, y: 2 };\nconsole.log(Object.keys({ ...a }).join(","));`,
  "class instance": `class P { constructor() { this.q = 1; this.p = 2; } }\nconsole.log(Object.keys({ ...new P(), r: 3 }).join(","));`,
  "integer keys first": `const n = { b: 1, 2: 1, a: 1, 1: 1 };\nconsole.log(Object.keys({ ...n }).join(","));`,
  nested: `const inner = { m: 1, l: 2 };\nconsole.log(Object.keys({ ...{ ...inner, k: 3 }, j: 4 }).join(","));`,
  "JSON.stringify": `const a = { x: 1, y: 2 };\nconsole.log(JSON.stringify({ ...a, z: 3 }));`,
  // Bound first: an INLINE \`Object.entries({ ...a, z })\` takes a static
  // checker-shape path (TypeScript lists the spread type's own \`z\` first) that
  // never reaches the native copy, on every lane including host-assisted.
  "Object.entries": `const a = { x: 1, y: 2 };\nconst b = { ...a, z: 3 };\nconsole.log(Object.entries(b).map((e) => e[0] + "=" + e[1]).join(";"));`,
  "runtime-added keys": `const d = {}; d.d = 1; d.c = 2; d.b = 3; d.a = 4;\nconsole.log(Object.keys({ ...d }).join(","));`,
  "Object.assign": `const d = {}; d.d = 1; d.c = 2; d.b = 3;\nconsole.log(Object.keys(Object.assign({}, d, { e: 5 })).join(","));`,
  "symbol key copied": `const s = Symbol("s"); const o = JSON.parse("{}"); o.b = 1; o[s] = 2; o.a = 3;
const c = { ...o };
console.log(Object.keys(c).join(",") + " " + String(c[s]) + " " + String(Object.getOwnPropertySymbols(c).length));`,
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

describe("#7148 object spread preserves insertion order", () => {
  for (const target of ["gc", "standalone"] as const) {
    for (const [name, src] of Object.entries(PROGRAMS)) {
      it(`${target === "gc" ? "gc native-first" : "standalone"}: ${name}`, async () => {
        expect(await runWasm(src, target)).toEqual(runV8(src));
      });
    }
  }
});
