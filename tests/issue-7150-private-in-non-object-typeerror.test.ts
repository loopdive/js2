// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7150 — §13.10.1 `#x in v` step 1: a TypeError when `v` is not an Object. On
// gc native-first and standalone the brand check answered `false` for `null`,
// `undefined` and every primitive and never threw (only the host-assisted lane
// asked the host). The no-host lanes now test Object-ness with the module's own
// `typeof` classifiers. Pinned: every program's output equals V8's, and the
// thrown message is the host lane's text on all three lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const CORPUS = `class Box {
  #v;
  constructor(v) {
    this.#v = v;
  }
  static isBox(obj) {
    return #v in obj;
  }
}
const b = new Box(1);
console.log(Box.isBox(b));
console.log(Box.isBox({}));
try {
  Box.isBox(null);
} catch (e) {
  console.log(e instanceof TypeError);
}`;

const HARNESS = `class C { #v; static has(o) { return #v in o; } }
class D { #v; }
function t(label, o) {
  try {
    console.log(label + " " + String(C.has(o)));
  } catch (e) {
    console.log(label + " threw " + String(e instanceof TypeError));
  }
}
`;

const OPERANDS = [
  "null",
  "undefined",
  "1",
  '"s"',
  '""',
  "true",
  "NaN",
  "10n",
  'Symbol("x")',
  "{}",
  "new C()",
  "new D()",
  "[1, 2]",
  "function () {}",
  "() => 1",
  "Object.create(null)",
];

// Standalone `console.log(<boolean>)` prints an empty line once the module has
// an untyped function (pre-existing, outside #7150), so the standalone lane
// runs the corpus program with each value passed through `String(...)`.
const CORPUS_STRING = CORPUS.replace(/console\.log\((.*)\);/g, "console.log(String($1));");

const PROGRAMS: Record<string, string> = {
  ...Object.fromEntries(OPERANDS.map((op) => [`#v in ${op}`, `${HARNESS}t(${JSON.stringify(op)}, ${op});`])),
  "the brand is checked before the throw": `${HARNESS}const c = new C();\nt("c", c);\nt("null", null);\nt("c again", c);`,
};

const MESSAGE_PROGRAM = `class C { #v; static has(o) { return #v in o; } }
try { C.has(1); } catch (e) { console.log(e.message); }`;
const MESSAGE = "Cannot use 'in' operator to search for private field in a non-object";

type Lane = "host-assisted" | "gc" | "standalone";

function runV8(src: string): string[] {
  const out: string[] = [];
  new Function("console", src)({ log: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out;
}

async function runWasm(src: string, lane: Lane): Promise<string[]> {
  const result = await compile(src, {
    fileName: "probe.js",
    deferTopLevelInit: true,
    ...(lane === "standalone" ? { target: "standalone" as const, hostBridge: "always" as const } : {}),
    ...(lane === "host-assisted" ? { semanticProviders: "host-assisted" as const } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const out: string[] = [];
  if (lane !== "standalone") {
    // The default (native-first) gc lane, run the way scripts/diff-test.ts runs it.
    const built = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    const exp = instance.exports as Record<string, () => void>;
    const origLog = console.log;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    try {
      exp.__module_init?.();
    } finally {
      console.log = origLog;
    }
    return out;
  }
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exp = instance.exports as Record<string, (...a: number[]) => number>;
  exp.__module_init?.();
  const len = exp.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < len; i++) sink += String.fromCharCode(exp.__stdout_char!(i) & 0xffff);
  for (const line of sink.split("\n")) if (line.length > 0) out.push(line);
  return out;
}

describe("#7150 `#x in v` throws a TypeError for a non-object v", () => {
  it("gc native-first: corpus private-fields/05-brand-checks", async () => {
    expect(await runWasm(CORPUS, "gc")).toEqual(runV8(CORPUS));
  });
  it("standalone: corpus private-fields/05-brand-checks (String-wrapped)", async () => {
    expect(CORPUS_STRING).toContain("console.log(String(e instanceof TypeError));");
    expect(await runWasm(CORPUS_STRING, "standalone")).toEqual(runV8(CORPUS_STRING));
  });
  for (const lane of ["gc", "standalone"] as const) {
    const name = lane === "gc" ? "gc native-first" : "standalone";
    for (const [label, src] of Object.entries(PROGRAMS)) {
      it(`${name}: ${label}`, async () => {
        expect(await runWasm(src, lane)).toEqual(runV8(src));
      });
    }
  }
  for (const lane of ["host-assisted", "gc", "standalone"] as const) {
    it(`${lane}: message text`, async () => {
      expect(await runWasm(MESSAGE_PROGRAM, lane)).toEqual([MESSAGE]);
    });
  }
});
