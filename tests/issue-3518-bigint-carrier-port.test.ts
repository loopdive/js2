// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  applyBigIntCarrierPort,
  authenticateBigIntCarrierPort,
  beforeBigIntCarrierPort,
  bigintPortBase,
  bigintPortFixture,
  bigintPortHash,
  bigintPortPaths,
  readBigIntPortSource,
} from "./helpers/bigint-carrier-port.js";
import { buildBigIntCarrierEqualityDefinition } from "../src/runtime/wasmgc/values/bigint-carrier-body.js";
import {
  buildBigIntLimbsType,
  buildOpenBigIntType,
  buildWideBigIntType,
} from "../src/runtime/wasmgc/values/bigint-carrier-layouts.js";
import { buildBigIntPrimitiveType } from "../src/runtime/wasmgc/values/bigint-primitive-bodies.js";
import { buildObjectSameValueBody } from "../src/runtime/wasmgc/values/object-same-value-body.js";
import { readBeforeResumeMain, applyResumeMainComposition } from "./helpers/resume-main-composition.js";
import type { Instr, LocalDef } from "../src/wasm/model/instructions.js";
import { beforeDescriptorAdapterRelocation } from "./helpers/descriptor-adapter-relocation.js";
import { beforeDeliveryMainRefresh } from "./helpers/delivery-main-refresh-port.js";

const receipt = authenticateBigIntCarrierPort();
function positive(path: string) {
  const current = beforeDescriptorAdapterRelocation(path, beforeDeliveryMainRefresh(path, readBigIntPortSource(path))),
    prior = applyBigIntCarrierPort(path, current, true);
  expect(prior).not.toBe(current);
  expect(applyBigIntCarrierPort(path, prior, false)).toBe(current);
  expect(beforeBigIntCarrierPort(path, current)).toBe(prior);
  return { current, prior };
}
const damage = (text: string) => text.replace(/\S/, (c) => (c === "~" ? "!" : "~"));
describe("authenticated exact-main BigInt carrier extraction and SameValue correction", () => {
  it("pins four actual sources and two actual relocated modules", () => {
    expect(receipt.base).toBe(bigintPortBase);
    expect(receipt.records.map((r) => r.path)).toEqual(bigintPortPaths);
    expect(receipt.modules).toHaveLength(2);
    expect(receipt.records.every((r) => r.spans.length > 0)).toBe(true);
  });
  for (const row of receipt.records) {
    it("reconstructs and replays the whole " + row.path, () => {
      const { prior } = positive(row.path);
      expect(bigintPortHash(prior)).toBe(row.beforeSHA256);
    });
    for (const [index, span] of row.spans.entries())
      it(`${row.path}:${index} rejects damaged, missing and duplicate spans after a positive control`, () => {
        const { current, prior } = positive(row.path);
        for (const [source, from, inverse] of [
          [current, span.after, true],
          [prior, span.before, false],
        ] as const) {
          expect(source.split(from)).toHaveLength(2);
          for (const replacement of [damage(from), "", from + from]) {
            const changed = source.replace(from, () => replacement);
            expect(changed).not.toBe(source);
            expect(() => applyBigIntCarrierPort(row.path, changed, inverse)).toThrow("BigInt carrier span");
          }
        }
      });
    it("rejects outside edits and historical substitution for " + row.path, () => {
      const { current, prior } = positive(row.path);
      expect(() => applyBigIntCarrierPort(row.path, current + "\n// outside port\n", true)).toThrow(
        "retained source mismatch",
      );
      expect(() => applyBigIntCarrierPort(row.path, prior, true)).toThrow("BigInt carrier span");
      expect(() => applyBigIntCarrierPort(row.path, current, false)).toThrow("BigInt carrier span");
    });
    it("rejects reordered spans for " + row.path, () => {
      const { current } = positive(row.path);
      expect(row.spans.length).toBeGreaterThan(1);
      const first = row.spans[0]!.after,
        last = row.spans.at(-1)!.after,
        marker = "__bigint_span_swap__";
      expect(current).not.toContain(marker);
      const changed = current.replace(first, marker).replace(last, first).replace(marker, last);
      expect(changed).not.toBe(current);
      expect(() => applyBigIntCarrierPort(row.path, changed, true)).toThrow("order or offset mismatch");
    });
  }
  it("keeps the existing main-merge inverse after the authenticated new correction", () => {
    const path = "src/codegen/registry/imports.ts",
      { prior } = positive(path);
    expect(readBeforeResumeMain(path)).toBe(applyResumeMainComposition(path, prior, true));
  });
  it("refuses changed receipt authority and unknown source paths", () => {
    positive(bigintPortPaths[0]);
    const text = readBigIntPortSource(bigintPortFixture);
    expect(() => authenticateBigIntCarrierPort(text + "\n")).toThrow("receipt mismatch");
    expect(() => applyBigIntCarrierPort("unowned", "", true)).toThrow("unrecorded");
    expect(beforeBigIntCarrierPort(bigintPortFixture, text)).toBe(text);
  });
  it.each(receipt.modules)("authenticates the actual relocated $path", ({ path }) => {
    authenticateBigIntCarrierPort();
    const reader = (file: string) => readBigIntPortSource(file) + (file === path ? "\n// changed recipe\n" : "");
    expect(() => authenticateBigIntCarrierPort(undefined, reader)).toThrow("relocated module mismatch");
  });
});

function declaration(source: string, name: string): string {
  const file = ts.createSourceFile("donor.ts", source, ts.ScriptTarget.Latest, true);
  const functions = file.statements.filter(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  expect(functions).toHaveLength(1);
  return functions[0]!.getText(file);
}
function evaluate<T>(source: string, name: string, bindings: Record<string, unknown>): T {
  const text = ts.transpileModule(declaration(source, name), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(bindings), "exports", text + "\nreturn " + name)(
    ...Object.values(bindings),
    {},
  ) as T;
}
describe("actual canonical donor definitions and acquisition", () => {
  it.each([false, true])("captures live provider handles after equality acquisition, missing=%s", (missing) => {
    positive("src/codegen/object-runtime-enumeration.ts");
    const names = ["__typeof_number", "__typeof_boolean", "__typeof_bigint", "__unbox_number", "__unbox_boolean"];
    const ctx = {
      targetProfile: { semanticProviders: "native-first" },
      funcMap: new Map(names.map((name, i) => [name, i])),
    };
    const trace: unknown[] = [];
    const register = evaluate<(context: typeof ctx, bindings: unknown) => void>(
      readBigIntPortSource("src/codegen/object-same-value.ts"),
      "registerObjectSameValueHelper",
      {
        addUnionImportsViaRegistry: () => {
          trace.push("union");
        },
        ensureBigIntCarrierEq: () => {
          trace.push("equality");
          names.forEach((name, i) => ctx.funcMap.set(name, i + 100));
          return missing ? undefined : 71;
        },
        buildObjectSameValueBody,
      },
    );
    const definitions: unknown[][] = [];
    const bindings = {
      anyStrTypeIdx: 12,
      strFlattenIdx: 13,
      strEqualsIdx: 14,
      registerNative: (...args: unknown[]) => {
        trace.push("register");
        definitions.push(args);
      },
    };
    if (missing) {
      expect(() => register(ctx, bindings)).toThrow("requires canonical BigInt carrier equality");
      expect(definitions).toEqual([]);
      expect(trace).toEqual(["union", "equality"]);
    } else {
      register(ctx, bindings);
      expect(trace).toEqual(["union", "equality", "register"]);
      expect(definitions).toHaveLength(1);
      expect(definitions[0]![4]).toStrictEqual(
        buildObjectSameValueBody({
          typeofNumIdx: 100,
          typeofBoolIdx: 101,
          typeofBigIdx: 102,
          unboxNumIdx: 103,
          unboxBoolIdx: 104,
          bigint: { kind: "carrier", equalIdx: 71 },
          anyStrTypeIdx: 12,
          strFlattenIdx: 13,
          strEqualsIdx: 14,
        }),
      );
    }
  });
  it.each([0, 17])("retains exact ordered subtype registration at offset %s", (offset) => {
    const { current, prior } = positive("src/codegen/bigint-wide.ts");
    const capture = (source: string) => {
      const ctx = {
        mod: { types: Array.from({ length: offset + 1 }, () => ({})) },
        nativeBigIntLimbsTypeIdx: -1,
        nativeBigIntWideTypeIdx: -1,
      };
      evaluate<(context: typeof ctx, index: number) => void>(source, "registerWideBigIntTypes", {
        buildBigIntLimbsType,
        buildWideBigIntType,
      })(ctx, offset);
      return ctx;
    };
    const before = capture(prior),
      after = capture(current);
    expect(after).toStrictEqual(before);
    expect(after.mod.types.slice(offset + 1)).toStrictEqual([
      buildBigIntLimbsType(),
      buildWideBigIntType(offset, offset + 1),
    ]);
    expect(buildOpenBigIntType()).toStrictEqual({ ...buildBigIntPrimitiveType(), superTypeIdx: -1 });
  });
  it.each([false, true])("retains exact equality helper definition and idempotence, missing=%s", (missing) => {
    const { current, prior } = positive("src/codegen/bigint-wide.ts");
    const capture = (source: string) => {
      const calls: unknown[] = [],
        ctx = { funcMap: new Map<string, number>() };
      const types = { narrow: 11, limbs: 12, wide: 13 };
      const ensure = evaluate<(context: typeof ctx) => number | undefined>(source, "ensureBigIntCarrierEq", {
        WIDE_FIELD_SIGN: 1,
        WIDE_FIELD_MAG: 2,
        buildBigIntCarrierEqualityDefinition,
        wideTypes: () => {
          calls.push("types");
          return missing ? undefined : types;
        },
        pushHelper: (
          c: typeof ctx,
          name: string,
          params: unknown,
          results: unknown,
          locals: LocalDef[],
          body: Instr[],
        ) => {
          calls.push({ name, params, results, locals, body });
          c.funcMap.set(name, 27);
          return 27;
        },
      });
      const first = ensure(ctx),
        second = ensure(ctx);
      return { calls, first, second };
    };
    const before = capture(prior),
      after = capture(current);
    expect(after).toStrictEqual(before);
    expect(after.first).toBe(missing ? undefined : 27);
    expect(after.calls).toHaveLength(2);
  });
});
