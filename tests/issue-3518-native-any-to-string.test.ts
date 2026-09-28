// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as recipe from "../src/runtime/wasmgc/values/any-to-string-body.js";
import { compile } from "../src/index.js";
import { buildAnyToStringBody } from "../src/runtime/wasmgc/values/any-to-string-body.js";
import type {
  AnyToStringBindings,
  AnyToStringRequest,
  AnyToStringResponse,
} from "../src/runtime/wasmgc/values/any-to-string-types.js";
import type { Instr } from "../src/wasm/model/instructions.js";

const bindings: AnyToStringBindings = {
  anyStrTypeIdx: 1,
  anyValueTypeIdx: 2,
  numToStrIdx: 10,
  errToStrIdx: 11,
  errStructTypeIdx: 3,
  dateToStrIdx: 12,
  dateStructTypeIdx: 4,
  classToPrimIdx: 13,
  boxNumTerminalIdx: 5,
  boxBoolTerminalIdx: 6,
  argumentsVecTypeIdx: 7,
  toPrimitiveIdx: 14,
  objectRuntimePresent: true,
  boxNumIdxEarly: 5,
  boxBoolIdxEarly: 6,
};
function answer(
  request: AnyToStringRequest,
  instructions: Instr[] = [{ op: "global.get", index: 0 }],
): AnyToStringResponse {
  switch (request.kind) {
    case "literal":
      return { ...request, instructions };
    case "arguments-brand":
      return { ...request, index: 15 };
    case "object-type":
      return { ...request, index: 8 };
    case "residual-box-types":
      return { ...request, boxNumIdx: 5, boxBoolIdx: 6 };
  }
}
it("every repeated literal response receives fresh nested instruction ownership", () => {
  const shared: Instr[] = [{ op: "block", blockType: { kind: "empty" }, body: [{ op: "i64.const", value: 3n }] }];
  const before = structuredClone(shared),
    build = buildAnyToStringBody(bindings);
  let step = build.next(),
    count = 0;
  while (!step.done) {
    if (step.value.kind === "literal") count++;
    step = build.next(answer(step.value, shared));
  }
  expect(count).toBeGreaterThan(5);
  const nodes = new Set<object>();
  let instructions = 0;
  function visit(value: unknown) {
    if (value === null || typeof value !== "object") return;
    if ("op" in value) {
      expect(nodes.has(value)).toBe(false);
      nodes.add(value);
      instructions++;
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(step.value);
  expect(instructions).toBeGreaterThan(100);
  expect(nodes.has(shared[0]!)).toBe(false);
  expect(shared).toEqual(before);
});
it.each(["literal", "arguments-brand", "object-type", "residual-box-types"] as const)(
  "refuses a mismatched %s response",
  (kind) => {
    const build = buildAnyToStringBody(bindings);
    let step = build.next();
    while (!step.done && step.value.kind !== kind) step = build.next(answer(step.value));
    expect(step.done).toBe(false);
    const wrong: AnyToStringResponse =
      kind === "literal" ? { kind: "object-type", index: 8 } : { kind: "literal", value: "null", instructions: [] };
    expect(() => build.next(wrong)).toThrow(/wrong .* response/);
  },
);
it("refuses a literal response for a different requested value", () => {
  const build = buildAnyToStringBody(bindings);
  let step = build.next();
  while (!step.done && step.value.kind !== "literal") step = build.next(answer(step.value));
  if (step.done || step.value.kind !== "literal") throw Error("literal request missing");
  expect(() =>
    build.next({ kind: "literal", value: step.value.value === "null" ? "true" : "null", instructions: [] }),
  ).toThrow(/wrong literal response/);
});

const cases = [
  {
    name: "dynamic scalars and nullish values",
    setup: "",
    expression: `render(null) + ":" + render(undefined) + ":" + render(seed) + ":" + render(seed > 0)`,
  },
  {
    name: "boxed primitive wrappers",
    setup: "",
    expression: `render(new Number(seed)) + ":" + render(new Boolean(seed)) + ":" + render(new String("xy"))`,
  },
  {
    name: "own wrapper override",
    setup: "",
    expression: `(() => { const wrapped: any = new String("xy"); wrapped.toString = function() { return "own" + seed; }; return render(wrapped); })()`,
  },
  {
    name: "open object method reduction",
    setup: "",
    expression: `render({ toString: function() { return "object" + seed; } })`,
  },
  {
    name: "nominal class method reduction",
    setup: `class Named { value: number; constructor(value: number) { this.value = value; } toString(): string { return "class" + this.value; } }`,
    expression: `render(new Named(seed))`,
  },
  { name: "error rendering", setup: "", expression: `render(new TypeError("bad" + seed))` },
  { name: "arguments brand", setup: `function args(): string { return render(arguments); }`, expression: `args()` },
  { name: "date rendering", setup: "", expression: `render(new Date(seed))` },
] as const;
it.each(cases)("real compiler and native Node agree for $name", async (row) => {
  const source = `function render(value: any): string { return "" + value; }\n${row.setup}\nexport function run(seed: number): number { const text = ${row.expression}; let result = 0; for(let i = 0; i < text.length; i++) result = (result * 31 + text.charCodeAt(i)) | 0; return result; }`;
  // Native oracle erases only the explicitly written TS annotations in this fixture.
  const js = source.replace(/:\s*(any|string|number)\b/g, "").replace(/^export /gm, "");
  const oracle = new Function(js + "\nreturn run;")() as (seed: number) => number;
  // Standalone's documented local Date environment is UTC. Keep the source and
  // seeds identical, and isolate the reference environment instead of mutating
  // this process's timezone or hard-coding a renderer-specific expected hash.
  const utcRows: { seed: number; hash: number; text: string }[] | undefined =
    row.name === "date rendering"
      ? JSON.parse(
          execFileSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `const {run, render} = new Function(${JSON.stringify(js)} + "\\nreturn {run, render};")(); console.log(JSON.stringify([2,7].map(seed => ({seed, hash:run(seed), text:render(new Date(seed))}))));`,
            ],
            { env: { ...process.env, TZ: "UTC" }, encoding: "utf8", timeout: 5000 },
          ),
        )
      : undefined;
  if (utcRows) console.info("AnyToString isolated Node UTC oracle", JSON.stringify(utcRows));
  const result = await compile(source, { target: "standalone" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.imports).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  for (const seed of [2, 7]) {
    const expected = utcRows ? utcRows.find((item) => item.seed === seed)!.hash : oracle(seed);
    expect((instance.exports.run as (n: number) => number)(seed)).toBe(expected);
  }
});

it("the real emitted AnyToString body executes, with a fresh test-only poison prefix", async () => {
  const source = `function render(value: any): string { return "" + value; } export function run(seed: number): number { return render(seed).charCodeAt(0); }`;
  const control = await compile(source, { target: "standalone" });
  expect(control.success, JSON.stringify(control.errors)).toBe(true);
  expect(control.imports).toEqual([]);
  const live = await WebAssembly.instantiate(control.binary, {});
  expect((live.instance.exports.run as (n: number) => number)(7)).toBe("7".charCodeAt(0));
  const original = recipe.buildAnyToStringBody;
  const spy = vi.spyOn(recipe, "buildAnyToStringBody").mockImplementation(function* (resources) {
    const body = yield* original(resources);
    return [{ op: "unreachable" }, ...body];
  });
  try {
    const poisoned = await compile(source, { target: "standalone" });
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(poisoned.success, JSON.stringify(poisoned.errors)).toBe(true);
    expect(poisoned.imports).toEqual([]);
    const instance = await WebAssembly.instantiate(poisoned.binary, {});
    expect(() => (instance.instance.exports.run as (n: number) => number)(7)).toThrow(/unreachable/);
  } finally {
    spy.mockRestore();
  }
});
