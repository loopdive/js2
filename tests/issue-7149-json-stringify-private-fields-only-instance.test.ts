// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7149 — on gc native-first and standalone, `JSON.stringify(new C())` printed
// `null` when `C` had no enumerable own field (`class C { #x = 1 }`, a
// methods-only class, an empty class): the closed-struct classifier the codec
// uses to recognise a class instance as an ordinary object only admitted shapes
// that had at least one enumerable field. It now admits every allocated user
// shape, so these serialise as `{}` (and `toJSON` on them is honoured). Pinned:
// each program's output equals V8's; private slots are never serialised.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const CORPUS = `class Counter {
  #count = 0;
  increment() {
    this.#count += 1;
  }
  get value() {
    return this.#count;
  }
}
const c = new Counter();
c.increment();
c.increment();
c.increment();
console.log(c.value);
console.log(JSON.stringify(c));`;

const PROGRAMS: Record<string, string> = {
  "corpus private-fields/01-fields": CORPUS,
  "private only": `class C { #x = 1 }\nconsole.log(JSON.stringify(new C()));`,
  "public and private": `class C { #x = 1; y = 2 }\nconsole.log(JSON.stringify(new C()));`,
  "empty class": `class C {}\nconsole.log(JSON.stringify(new C()));`,
  "methods only": `class C { m() { return 1; } }\nconsole.log(JSON.stringify(new C()));`,
  "inside an array": `class C { #x = 1 }\nconsole.log(JSON.stringify([new C(), 1, new C()]));`,
  "as a property": `class C { #x = 1 }\nconsole.log(JSON.stringify({ a: new C(), b: 2 }));`,
  "toJSON reads the private field": `class C { #x = 7; toJSON() { return { x: this.#x }; } }\nconsole.log(JSON.stringify(new C()));`,
  "private-only base, public subclass": `class A { #a = 1 }\nclass B extends A { b = 2 }\nconsole.log(JSON.stringify(new B()) + " " + JSON.stringify(new A()));`,
  "Object.keys stays empty": `class C { #x = 1 }\nconsole.log(Object.keys(new C()).length);`,
  "spread of a private-only instance": `class C { #x = 1 }\nconsole.log(JSON.stringify({ ...new C(), z: 1 }));`,
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

describe("#7149 JSON.stringify of an instance without enumerable fields", () => {
  for (const target of ["gc", "standalone"] as const) {
    for (const [name, src] of Object.entries(PROGRAMS)) {
      it(`${target === "gc" ? "gc native-first" : "standalone"}: ${name}`, async () => {
        expect(await runWasm(src, target)).toEqual(runV8(src));
      });
    }
  }
});
