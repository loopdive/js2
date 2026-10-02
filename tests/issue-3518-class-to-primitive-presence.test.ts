// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import * as classDriver from "../src/codegen/class-to-primitive.js";
import * as dispatch from "../src/codegen/to-primitive-dispatch-presence.js";
import type { CodegenContext } from "../src/codegen/context/types.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});

type Completion = { kind: "return"; value: number } | { kind: "throw"; name: string };
type NumericExports = Record<string, (seed?: number) => number>;
function nativeExports(source: string): NumericExports {
  const exports = {};
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(js, { exports });
  return exports;
}
const observer = `
let observedValue=0;
export function observe(seed:number):number {
  try { observedValue=run(seed);return 1; }
  catch(error) { if(error instanceof TypeError)return 2;throw error; }
}
export function observation():number { return observedValue; }
`;
function completion(exports: NumericExports): Completion {
  const kind = exports.observe!(7);
  if (kind === 1) return { kind: "return", value: exports.observation!() };
  if (kind === 2) return { kind: "throw", name: "TypeError" };
  throw new Error(`unrecognized class completion ${kind}`);
}
async function execute(body: string) {
  const source = `export function run(seed:number):number { ${body} }`;
  let expected: Completion;
  try {
    expected = { kind: "return", value: nativeExports(source).run!(7) };
  } catch (error) {
    expected = { kind: "throw", name: String((error as Error).name) };
  }
  expect(completion(nativeExports(source + observer))).toEqual(expected);
  const result = await compile(source + observer, { target: "standalone", emitWat: true });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const actual = completion(new WebAssembly.Instance(module, {}).exports as NumericExports);
  console.info("class primitive completion", JSON.stringify({ sourceSha256: sha(source), expected, actual }));
  expect(actual).toEqual(expected);
  return result;
}

const cases: [string, string][] = [
  [
    "real null returns without the fallback call",
    `
    const x:any={};let first=0;let second=0;
    x.valueOf=function():any{first++;return null;};
    x.toString=function():any{second++;return "wrong";};
    return x*seed===0 && first===1 && second===0 ? 1:0;`,
  ],
  [
    "canonical undefined returns without the fallback call",
    `
    const x:any={};let first=0;let second=0;
    x.valueOf=function():any{first++;return undefined;};
    x.toString=function():any{second++;return "wrong";};
    const v=x*seed;return v!==v && first===1 && second===0 ? 1:0;`,
  ],
  [
    "a completed void method returns undefined",
    `
    const x:any={};let first=0;let second=0;
    x.valueOf=function():void{first++;};
    x.toString=function():any{second++;return "wrong";};
    const v=x*seed;return v!==v && first===1 && second===0 ? 1:0;`,
  ],
  [
    "a missing first method advances to the second",
    `
    const x:any={};let calls=0;x.toString=function():any{calls++;return "13";};
    return x*seed+calls;`,
  ],
  [
    "a null method field is skipped instead of called",
    `
    const x:any={};let calls=0;x.valueOf=function():any{return 99;};x.valueOf=null;
    x.toString=function():any{calls++;return "13";};return x*seed+calls;`,
  ],
  [
    "an undefined method field is skipped instead of called",
    `
    const x:any={};let calls=0;x.valueOf=function():any{return 99;};x.valueOf=undefined;
    x.toString=function():any{calls++;return "13";};return x*seed+calls;`,
  ],
  [
    "a numeric noncallable field is skipped",
    `
    const x:any={};let calls=0;x.valueOf=42;
    x.toString=function():any{calls++;return "13";};return x*seed+calls;`,
  ],
  [
    "an object return advances exactly once",
    `
    const x:any={};let first=0;let second=0;
    x.valueOf=function():any{first++;return {};};
    x.toString=function():any{second++;return "13";};
    return x*seed+first*10+second;`,
  ],
  [
    "two object returns still throw TypeError",
    `
    const x:any={};x.valueOf=function():any{return {};};
    x.toString=function():any{return {};};return x*seed;`,
  ],
  [
    "a nested no-match cannot overwrite the outer matched null",
    `
    const x:any={};let first=0;let second=0;let innerCalls=0;
    x.valueOf=function():any{first++;const inner:any={pad:seed};
      const value=inner*seed;if(value!==value)innerCalls++;return null;};
    x.toString=function():any{second++;return "wrong";};
    return x*seed===0 && first===1 && second===0 && innerCalls===1 ? 1:0;`,
  ],
  [
    "the original receiver is visible once inside the method",
    `
    const x:any={};let calls=0;let receivers=0;
    x.valueOf=function():any{calls++;if(this===x)receivers++;return null;};
    x.toString=function():any{throw new Error("unexpected fallback");};
    return x*seed===0 && calls===1 && receivers===1 ? 1:0;`,
  ],
  [
    "throwing the caller's exact object stays abrupt",
    `
    const x:any={};const token:any={id:seed};let calls=0;let fallback=0;
    x.valueOf=function():any{calls++;throw token;};
    x.toString=function():any{fallback++;return "wrong";};
    try { const value=x*seed;return value; }
    catch(error) { return error===token && calls===1 && fallback===0 ? 1:0; }`,
  ],
];

describe("nominal method completion preserves presence separately from value", () => {
  it.each(cases)("%s", async (_name, body) => {
    await execute(body);
  });
  it("positive first: the emitted presence-marked callable arm really executes", async () => {
    await execute(cases[0]![1]);
    const original = dispatch.markToPrimitiveDispatchCall;
    vi.spyOn(dispatch, "markToPrimitiveDispatchCall").mockImplementation(() => [{ op: "unreachable" }, ...original()]);
    await expect(execute(cases[0]![1])).rejects.toThrow(/unreachable/);
  });
});

/** Export existing actual functions for observation; no substitute dependencies. */
function exposeActualDriver(predicate?: string): void {
  const original = classDriver.fillClassToPrimitive;
  vi.spyOn(classDriver, "fillClassToPrimitive").mockImplementation((ctx: CodegenContext) => {
    original(ctx);
    for (const name of [
      classDriver.CLASS_TO_PRIMITIVE,
      dispatch.toPrimitivePresenceName("__call_valueOf"),
      ...(predicate ? [predicate] : []),
    ]) {
      const index = ctx.funcMap.get(name);
      if (index === undefined) throw new Error(`missing actual class observation target ${name}`);
      if (!ctx.mod.exports.some((entry) => entry.name === name))
        ctx.mod.exports.push({ name, desc: { kind: "func", index } });
    }
  });
}
const primitiveCases = [
  { label: "null", expression: "null", predicate: undefined },
  { label: "undefined", expression: "undefined", predicate: "__typeof_undefined" },
  { label: "number", expression: "17", predicate: "__typeof_number" },
  { label: "boolean", expression: "true", predicate: "__typeof_boolean" },
  { label: "string", expression: '"kept"', predicate: "__typeof_string" },
  { label: "BigInt", expression: "17n", predicate: "__typeof_bigint" },
  { label: "Symbol", expression: 'Symbol("kept")', predicate: undefined },
];
it.each(primitiveCases)(
  "the real class driver accepts the $label carrier",
  async ({ label, expression, predicate }) => {
    exposeActualDriver(predicate);
    const source = `
    let calls=0;let fallback=0;const wanted:any=${expression};
    export function operand():any {
      const x:any={};x.valueOf=function():any{calls++;return wanted;};
      x.toString=function():any{fallback++;return "wrong";};return x;
    }
    export function counts():number{return calls*10+fallback;}
    export function run(seed:number):number{return operand()*seed;}
  `;
    const result = await compile(source, { target: "standalone", emitWat: true });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const ex = new WebAssembly.Instance(module, {}).exports as Record<string, (...args: unknown[]) => unknown>;
    const operand = ex.operand!();
    const value = ex.__class_to_primitive!(operand, 0);
    expect(ex.counts!()).toBe(10);
    if (predicate) expect(ex[predicate]!(value)).toBe(1);
    else if (label === "null") expect(value).toBeNull();
    else {
      // Symbol interning preserves the actual carrier returned by the method.
      expect(Object.is(value, ex.__call_valueOf!(operand))).toBe(true);
      expect(ex.counts!()).toBe(20);
    }
  },
);

it("public one-result ABI preserves null while the private ABI distinguishes a miss", async () => {
  exposeActualDriver("__typeof_undefined");
  const result = await compile(
    `
    export function operand():any { const x:any={};x.valueOf=function():any{return null;};return x; }
    class Missing { pad:number=3; }
    export function missing():any { return new Missing(); }
    export function run(seed:number):number { return operand()*seed; }
  `,
    { target: "standalone", emitWat: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const ex = new WebAssembly.Instance(module, {}).exports as Record<string, (...args: unknown[]) => unknown>;
  const operand = ex.operand!();
  expect(ex.__call_valueOf!(operand)).toBeNull();
  expect(ex.__call_valueOf_with_presence!(operand)).toEqual([1, null]);
  const missing = ex.missing!();
  expect(ex.__call_valueOf!(missing)).toBeNull();
  expect(ex.__call_valueOf_with_presence!(missing)).toEqual([0, null]);
  expect(Object.is(ex.__class_to_primitive!(missing, 0), missing)).toBe(true);
});

const read = readBeforeResumeMain;
const refNumberText = read("tests/fixtures/issue-3518-runtime-ref-number-forward.json");
function refNumberReceipt(text: string) {
  if (sha(text) !== "69fc2f126cd05f4c6ae4b6e9f35ae22cddb53c8d17b4210259f4aadbea014bb8")
    throw new Error("changed runtime-ref-number forward receipt");
  const record = JSON.parse(text) as {
    base: string;
    sourcePath: string;
    sourceSha256: string;
    nativeStringBranch: string;
    nativeStringBranchSha256: string;
    helperPath: string;
    spans: { before: string; after: string }[];
  };
  if (
    record.base !== "0ef8e0ea4c23829a4eba37dca6dd6822aa95265e" ||
    record.spans.length !== 2 ||
    sha(record.nativeStringBranch) !== record.nativeStringBranchSha256
  )
    throw new Error("foreign runtime-ref-number source");
  return record;
}
const refNumber = refNumberReceipt(refNumberText);
function inverseRefNumber(source: string): string {
  let priorEnd = -1;
  for (const span of refNumber.spans) {
    const at = source.indexOf(span.after);
    if (at < priorEnd || at < 0 || source.indexOf(span.after, at + 1) >= 0)
      throw new Error("changed runtime-ref-number span or order");
    priorEnd = at + span.after.length;
  }
  for (const span of [...refNumber.spans].reverse()) source = source.replace(span.after, span.before);
  if (sha(source) !== refNumber.sourceSha256) throw new Error("changed retained numeric coercion source");
  return source;
}
it("runtime ref extraction restores the exact original source and native string branch", () => {
  expect(sha(inverseRefNumber(read(refNumber.sourcePath)))).toBe(refNumber.sourceSha256);
  const extracted = refNumber.nativeStringBranch
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n")
    .replaceAll("      return;", "      return true;")
    .replaceAll("    return;", "    return true;");
  expect(read(refNumber.helperPath)).toContain(extracted);
});
it("positive first: numeric coercion receipt rejects span, retained-source and fixture corruption", () => {
  const source = read(refNumber.sourcePath);
  inverseRefNumber(source);
  for (const span of refNumber.spans) {
    expect(() => inverseRefNumber(source.replace(span.after, ""))).toThrow();
    expect(() => inverseRefNumber(source.replace(span.after, span.after + span.after))).toThrow();
    expect(() =>
      inverseRefNumber(source.replace(span.after, span.after.replace("tryRuntimeRefToNumber", "wrongHelper"))),
    ).toThrow();
  }
  expect(() => inverseRefNumber(source + "\n")).toThrow("changed retained");
  expect(() => refNumberReceipt(refNumberText + "\n")).toThrow("changed runtime-ref-number forward receipt");
});
it("positive first: the numeric dispatcher requires its actually acquired boxer", async () => {
  const source = `class C {valueOf():number{return 42;}}
    export function main():number{return Number(new C() as any);}`;
  const positive = await compile(source, { target: "standalone" });
  expect(positive.success, JSON.stringify(positive.errors)).toBe(true);
  const module = new WebAssembly.Module(positive.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect((new WebAssembly.Instance(module, {}).exports.main as () => number)()).toBe(42);
  const original = dispatch.ensureToPrimitiveDispatchBoxing;
  vi.spyOn(dispatch, "ensureToPrimitiveDispatchBoxing").mockImplementation((ctx) => {
    original(ctx);
    expect(ctx.funcMap.has("__box_number")).toBe(true);
    ctx.funcMap.delete("__box_number");
  });
  const refused = await compile(source, { target: "standalone" });
  expect(refused.success).toBe(false);
  expect(
    refused.errors.some((error) => error.message.includes("ToPrimitive method result requires __box_number")),
  ).toBe(true);
});
