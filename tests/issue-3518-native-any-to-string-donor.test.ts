// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { expect, it } from "vitest";
import { buildAnyToStringBody } from "../src/runtime/wasmgc/values/any-to-string-body.js";
import {
  inverseAnyToStringGroups,
  anyToStringScaffoldHashes,
  type AnyToStringInverseInputs,
} from "./helpers/issue-3518-any-to-string-inverse.js";
import type { Instr } from "../src/wasm/model/instructions.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/issue-3518-native-any-to-string-donor.json", import.meta.url), "utf8"),
);
const original = fixture.source as string;
const current = readBeforeResumeMain("src/codegen/native-strings.ts");
const adapterImports = [
  'import { buildAnyToStringBody } from "../runtime/wasmgc/values/any-to-string-body.js";\n',
  'import type { AnyToStringResponse } from "../runtime/wasmgc/values/any-to-string-types.js";\n',
];
function stripAdapterImports(source: string): string {
  for (const text of adapterImports) {
    if (source.split(text).length !== 2) throw Error("wrong or duplicate AnyToString adapter import");
    source = source.replace(text, "");
  }
  return source;
}
it("rejects redirected runtime imports even with the same imported name", () => {
  expect(() =>
    stripAdapterImports(current.replace("../runtime/wasmgc/values/any-to-string-body.js", "./fake-any-to-string.js")),
  ).toThrow(/adapter import/);
});
function declaration(source: string): ts.FunctionDeclaration {
  const parsed = ts.createSourceFile("native-strings.ts", source, ts.ScriptTarget.Latest, true);
  const fn = parsed.statements.find(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "ensureAnyToStringHelper",
  );
  if (!fn) throw Error("missing donor function");
  return fn;
}
// Recording-only dependency seam; actual Wasm behavior is tested separately.
function compileRecorder(source: string, bindings: Record<string, unknown>): Function {
  const fn = declaration(source);
  const js = ts.transpileModule(fn.getText().replace(/^export /, ""), {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText;
  return new Function(...Object.keys(bindings), js + "\nreturn ensureAnyToStringHelper;")(...Object.values(bindings));
}
interface Selection {
  native: boolean;
  formatter: boolean;
  boxes: boolean;
  error: boolean;
  date: boolean;
  arguments: boolean;
  class: boolean;
  primitive: boolean;
  object: boolean;
  drift: boolean;
  cached?: boolean;
}
const all: Selection = {
  native: true,
  formatter: true,
  boxes: true,
  error: true,
  date: true,
  arguments: true,
  class: true,
  primitive: true,
  object: true,
  drift: false,
};
function record(source: string, selected: Selection) {
  const events: unknown[] = [],
    definitions: unknown[] = [];
  let literals = 0;
  function map(label: string, values: [string, number][]) {
    const result = new Map(values);
    const get = result.get.bind(result),
      set = result.set.bind(result),
      has = result.has.bind(result);
    result.get = (key) => {
      const value = get(key);
      events.push([label, "get", key, value]);
      return value;
    };
    result.has = (key) => {
      const value = has(key);
      events.push([label, "has", key, value]);
      return value;
    };
    result.set = (key, value) => {
      events.push([label, "set", key, value]);
      return set(key, value);
    };
    return result;
  }
  const functions: [string, number][] = [];
  if (selected.formatter) functions.push(["number_toString", 81]);
  if (selected.arguments) functions.push(["__args_is_branded", 82]);
  if (selected.class) functions.push(["__class_to_primitive", 83]);
  if (selected.primitive) functions.push(["__to_primitive", 84]);
  const object = { objectTypeIdx: 25 };
  const objectView = new Proxy(object, {
    get(target, key) {
      const value = Reflect.get(target, key);
      events.push(["object", key, value]);
      return value;
    },
  });
  const state = {
    nativeStrings: selected.native,
    anyStrTypeIdx: 20,
    anyValueTypeIdx: 21,
    nativeBoxNumberTypeIdx: selected.boxes ? 22 : -1,
    nativeBoxBooleanTypeIdx: selected.boxes ? 23 : -1,
    errorStructTypeIdx: 24,
    objectRuntimeTypes: selected.object ? objectView : undefined,
    nativeStrHelpers: map("strings", selected.cached ? [["__any_to_string", 90]] : []),
    funcMap: map("functions", functions),
    structMap: map("structs", [["__Date", 26]]),
  };
  const ctx = new Proxy(state, {
    get(target, key) {
      const value = Reflect.get(target, key);
      events.push(["ctx", key, typeof value === "object" ? "object" : value]);
      return value;
    },
  });
  const bindings = {
    buildAnyToStringBody,
    ensureNativeStringHelpers: () => events.push(["ensure-strings"]),
    ensureAnyValueType: () => events.push(["ensure-any-value"]),
    emitNativeNumberFormat: (_ctx: unknown, names: Set<string>) => {
      events.push(["ensure-format", [...names]]);
      state.funcMap.set("number_toString", 81);
    },
    addUnionImports: () => {
      events.push(["ensure-union"]);
    },
    ensureErrorToStringHelper: () => {
      events.push(["ensure-error"]);
      return selected.error ? 85 : undefined;
    },
    ensureDateAnyToStringHelper: () => {
      events.push(["ensure-date"]);
      return selected.date ? 86 : undefined;
    },
    getArgumentsVecTypeIdx: () => {
      events.push(["arguments-type"]);
      return selected.arguments ? 27 : -1;
    },
    nativeStringLiteralInstrs: (_ctx: unknown, value: string): Instr[] => {
      events.push(["literal", value, literals++]);
      if (selected.drift) {
        state.nativeBoxNumberTypeIdx += 2;
        state.nativeBoxBooleanTypeIdx += 2;
        object.objectTypeIdx += 1;
        state.funcMap.set("__args_is_branded", 100 + literals);
      }
      return [{ op: "global.get", index: 200 + literals }];
    },
    addFuncType: (_ctx: unknown, params: unknown, results: unknown) => {
      events.push(["signature", params, results]);
      return 91;
    },
    mintDefinedFunc: () => {
      events.push(["mint"]);
      return 92;
    },
    pushDefinedFunc: (_ctx: unknown, index: number, definition: unknown) => {
      events.push(["push", index]);
      definitions.push(definition);
    },
  };
  const result = compileRecorder(source, bindings)(ctx);
  return { result, events, definitions };
}
it("pins the complete signed donor source and untouched surrounding compiler", () => {
  expect(fixture.commit).toBe("0ef8e0ea4c23829a4eba37dca6dd6822aa95265e");
  expect(createHash("sha256").update(original).digest("hex")).toBe(
    "234d016944b8597b53ae735af814785e16b5f98915bf52dc0a2f79ec859b041c",
  );
  const stripImports = stripAdapterImports(current);
  const live = declaration(stripImports),
    old = declaration(original);
  expect(stripImports.slice(0, live.getStart())).toBe(original.slice(0, old.getStart()));
  expect(stripImports.slice(live.end)).toBe(original.slice(old.end));
});
const selections: [string, Selection][] = [
  ["full", all],
  ["changing acquisition results", { ...all, drift: true }],
  ["cache hit", { ...all, cached: true }],
  [
    "host missing providers",
    {
      native: false,
      formatter: false,
      boxes: false,
      error: false,
      date: false,
      arguments: false,
      class: false,
      primitive: false,
      object: false,
      drift: false,
    },
  ],
  ...(["formatter", "boxes", "error", "date", "arguments", "class", "primitive", "object"] as const).map(
    (name): [string, Selection] => ["without " + name, { ...all, native: false, [name]: false }],
  ),
];
it.each(selections)("retains complete definitions and acquisition order: %s", (_name, selection) => {
  const donor = record(original, selection),
    actual = record(current, selection);
  expect(actual).toEqual(donor);
  expect(donor.definitions.length).toBe(selection.cached ? 0 : 1);
  if (!selection.cached)
    expect(donor.events.filter((event) => Array.isArray(event) && event[0] === "literal").length).toBeGreaterThan(0);
});

const recipeSources: AnyToStringInverseInputs = Object.fromEntries(
  [
    ["object", "object-bodies"],
    ["recovery", "recovery-bodies"],
    ["body", "body"],
    ["types", "types"],
  ].map(([key, file]) => [
    key,
    readFileSync(new URL(`../src/runtime/wasmgc/values/any-to-string-${file}.ts`, import.meta.url), "utf8"),
  ]),
) as unknown as AnyToStringInverseInputs;
// Complementary scaffold pins cover every byte outside the inverse donor ranges.
const scaffoldPins = {
  object: "7f824f1a31985b7b07f407c9096de6b4cb4144f2d76df93d13967c63ddc3e93e",
  recovery: "9107113dca1d4de846c30756e1ae558a244611617b1a6012d8718a258fc6ce20",
  body: "ef0a0d866b0ccd86357982a14ee362e4bfdd32ed02a59665aecc13473a8ed2c7",
  types: "db09b3da28117a416e6012014932e31bd6dfa766d058e52af7ede62b57405863",
};
function reconstructedSource(inputs: AnyToStringInverseInputs): string {
  expect(anyToStringScaffoldHashes(inputs)).toEqual(scaffoldPins);
  const live = stripAdapterImports(current);
  const start = live.indexOf("  // Preserve donor capture order");
  const end = live.indexOf("  const typeIdx = addFuncType(ctx, [anyref]", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(createHash("sha256").update(live.slice(start, end)).digest("hex")).toBe(
    "5b1a16bfaa5f656b928c42ea30c016436650d428a079122bafabc53246f33431",
  );
  return live.slice(0, start) + inverseAnyToStringGroups(original, inputs) + live.slice(end);
}
it("reconstructs the entire signed source from every moved code/comment token", () => {
  const inverse = reconstructedSource(recipeSources);
  expect(inverse).toBe(original);
  expect(createHash("sha256").update(inverse).digest("hex")).toBe(
    "234d016944b8597b53ae735af814785e16b5f98915bf52dc0a2f79ec859b041c",
  );
});
it("inverse refuses a changed donor operation while the scaffold is intact", () => {
  expect(recipeSources.body).toContain('op: "i32.eq"');
  expect(() =>
    reconstructedSource({ ...recipeSources, body: recipeSources.body.replace('op: "i32.eq"', 'op: "i32.ne"') }),
  ).toThrow();
});
it("inverse refuses changed donor comments and an unreviewed wrapper", () => {
  expect(recipeSources.object).toContain("OrdinaryToPrimitive");
  expect(() =>
    reconstructedSource({
      ...recipeSources,
      object: recipeSources.object.replace("OrdinaryToPrimitive", "AlteredPrimitive"),
    }),
  ).toThrow();
  expect(() =>
    reconstructedSource({ ...recipeSources, types: recipeSources.types + "\n// extra wrapper\n" }),
  ).toThrow();
});
