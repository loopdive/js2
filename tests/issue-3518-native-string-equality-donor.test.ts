// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { expect, it } from "vitest";
import {
  buildStringEqualityBody,
  buildStringEqualityDefinition,
} from "../src/runtime/wasmgc/values/string-equality-body.js";
import type { Instr, LocalDef } from "../src/wasm/model/instructions.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/issue-3518-native-string-equality-donor.json", import.meta.url), "utf8"),
);
const hashes = [
  "41a6e96853fd21ab580829a6324b6c232babb2c410b5b58fac567d597d6ccf17",
  "738f50b49831d4c11d397f7555c58be5d5f9eb65733cbfd37d0d70a2745d56ab",
  "a308856e567093f3fb50131600fa2f581ac563db68ec5a4bc3fe75f495a1f2ca",
];
function donor(index: number): string {
  const text = fixture.records[index].text as string;
  expect(createHash("sha256").update(text).digest("hex")).toBe(hashes[index]);
  return text;
}
function live(file: string, name: string): string {
  const text = readFileSync(new URL("../src/codegen/" + file, import.meta.url), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw Error("missing live declaration: " + name);
  return text.slice(declaration.getStart(source), declaration.end);
}
function factory(text: string, name: string, bindings: Record<string, unknown> = {}): Function {
  const js = ts.transpileModule(text.replace(/^export /, ""), {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText;
  return new Function(...Object.keys(bindings), js + "\nreturn " + name)(...Object.values(bindings));
}
interface Definition {
  name: string;
  locals: LocalDef[];
  body: Instr[];
}
function record(text: string, lazy: boolean, varyingHandles: boolean) {
  const trace: string[] = [];
  const definitions: Definition[] = [];
  let reads = 0;
  const helpers = new Map<string, number>();
  helpers.get = (name) => {
    if (name !== "__str_flatten") throw Error("unexpected helper read");
    trace.push("flatten:" + reads);
    const handle = 901 + (varyingHandles ? reads : 0);
    reads++;
    return handle;
  };
  const ctx = { nativeStrHelpers: helpers, hashedStrTypeIdx: 49 };
  const shared = factory(donor(1), "makeNativeStrShared")(ctx, 17, 18, 16, 19);
  const emit = factory(text, "emitStrCompareHelpers", {
    lazyStrFlattenEnabled: () => lazy,
    relocatedFlattenPreamble: factory(donor(2), "relocatedFlattenPreamble"),
    buildStringEqualityBody,
    addFuncType: () => {
      trace.push("signature");
      return 70;
    },
    mintDefinedFunc: () => {
      trace.push("mint");
      ctx.hashedStrTypeIdx = 51;
      return 100 + definitions.length;
    },
    pushDefinedFunc: (_ctx: unknown, handle: number, definition: Definition) => {
      trace.push("push:" + handle);
      definitions.push(definition);
    },
  });
  emit(shared);
  expect(definitions.map((value) => value.name)).toEqual(["__str_equals", "__str_compare"]);
  return { trace, definitions };
}
it("pins the original complete donor functions and leaves the ordering helper untouched", () => {
  expect(fixture.commit).toBe("9dd54aff748b62b7417e7b0d4b0bf95e172bb4b3");
  const current = live("native-strings-basics.ts", "emitStrCompareHelpers");
  const marker = "  // --- $__str_compare";
  expect(current.indexOf(marker)).toBeGreaterThan(0);
  expect(current.slice(current.indexOf(marker))).toBe(donor(0).slice(donor(0).indexOf(marker)));
  expect(live("native-strings-shared.ts", "makeNativeStrShared")).toBe(donor(1));
  expect(live("lazy-str-flatten.ts", "relocatedFlattenPreamble")).toBe(donor(2));
});
for (const lazy of [false, true]) {
  it(`preserves donor instructions, locals and acquisition order with changing handles, lazy=${lazy}`, () => {
    const original = record(donor(0), lazy, true);
    const current = record(live("native-strings-basics.ts", "emitStrCompareHelpers"), lazy, true);
    expect(current).toEqual(original);
    expect(original.trace.slice(0, 5)).toEqual(
      lazy
        ? ["flatten:0", "flatten:1", "signature", "mint", "push:100"]
        : ["signature", "mint", "flatten:0", "flatten:1", "push:100"],
    );
  });
  it(`native definition matches complete historical equality body and locals, lazy=${lazy}`, () => {
    const original = record(donor(0), lazy, false).definitions[0]!;
    expect(
      buildStringEqualityDefinition(
        { nativeStrTypeIdx: 17, nativeStrDataTypeIdx: 18, anyStrTypeIdx: 16, hashedStrTypeIdx: 51 },
        901,
        lazy,
      ),
    ).toEqual({ body: original.body, locals: original.locals });
  });
}
