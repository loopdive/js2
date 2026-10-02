// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  applyDescriptorAdapterRelocation,
  authenticateDescriptorAdapterRelocation,
  beforeDescriptorAdapterRelocation,
  descriptorAdapterFixture,
  descriptorAdapterHash,
  descriptorAdapterPaths,
  readDescriptorAdapterSource,
} from "./helpers/descriptor-adapter-relocation.js";
import { applyBigIntCarrierPort } from "./helpers/bigint-carrier-port.js";
import { applyDescriptorUndefinedCorrection } from "./helpers/descriptor-undefined-correction.js";
import { buildOrdinaryObjectDataDescriptorBody } from "../src/runtime/wasmgc/values/ordinary-object-descriptor-data.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "../src/runtime/wasmgc/values/ordinary-object-descriptor-common.js";
import type { Instr } from "../src/wasm/model/instructions.js";

const receipt = authenticateDescriptorAdapterRelocation();
function positive(path: string) {
  const current = readDescriptorAdapterSource(path),
    prior = applyDescriptorAdapterRelocation(path, current, true);
  expect(prior).not.toBe(current);
  expect(applyDescriptorAdapterRelocation(path, prior, false)).toBe(current);
  expect(beforeDescriptorAdapterRelocation(path, current)).toBe(prior);
  return { current, prior };
}
const damage = (text: string) => text.replace(/\S/, (value) => (value === "~" ? "!" : "~"));
describe("descriptor adapter structural relocation", () => {
  for (const row of receipt.records) {
    it("reconstructs and replays the actual " + row.path, () => {
      const { prior } = positive(row.path);
      expect(descriptorAdapterHash(prior)).toBe(row.beforeSHA256);
      const transform =
        row.path === descriptorAdapterPaths[0] ? applyBigIntCarrierPort : applyDescriptorUndefinedCorrection;
      const historical = transform(row.path, prior, true);
      expect(historical).not.toBe(prior);
      expect(transform(row.path, historical, false)).toBe(prior);
    });
    for (const [index, span] of row.spans.entries())
      it(`${row.path}:${index} refuses damaged, missing and duplicate spans after both positive directions`, () => {
        const { current, prior } = positive(row.path);
        for (const [source, from, inverse] of [
          [current, span.after, true],
          [prior, span.before, false],
        ] as const) {
          expect(source.split(from)).toHaveLength(2);
          for (const replacement of [damage(from), "", from + from]) {
            const changed = source.replace(from, () => replacement);
            expect(changed).not.toBe(source);
            expect(() => applyDescriptorAdapterRelocation(row.path, changed, inverse)).toThrow(
              "descriptor adapter span",
            );
          }
        }
      });
    it("refuses unrelated edits and historical substitution for " + row.path, () => {
      const { current, prior } = positive(row.path);
      expect(() => applyDescriptorAdapterRelocation(row.path, current + "\n// unrelated\n", true)).toThrow(
        "retained source mismatch",
      );
      expect(() => applyDescriptorAdapterRelocation(row.path, prior, true)).toThrow("descriptor adapter span");
      expect(() => applyDescriptorAdapterRelocation(row.path, current, false)).toThrow("descriptor adapter span");
    });
    it("refuses reordered declared spans for " + row.path, () => {
      const { current } = positive(row.path);
      expect(row.spans.length).toBeGreaterThan(1);
      const first = row.spans[0]!.after,
        last = row.spans.at(-1)!.after,
        marker = "__descriptor_adapter_reorder__";
      expect(current).not.toContain(marker);
      const changed = current.replace(first, marker).replace(last, first).replace(marker, last);
      expect(changed).not.toBe(current);
      expect(() => applyDescriptorAdapterRelocation(row.path, changed, true)).toThrow("order or offset mismatch");
    });
  }
  it("refuses changed receipt authority and unknown paths", () => {
    positive(descriptorAdapterPaths[0]);
    const text = readDescriptorAdapterSource(descriptorAdapterFixture);
    expect(() => authenticateDescriptorAdapterRelocation(text + "\n")).toThrow("receipt mismatch");
    expect(() => applyDescriptorAdapterRelocation("unowned", "", true)).toThrow("unrecorded");
    expect(beforeDescriptorAdapterRelocation(descriptorAdapterFixture, text)).toBe(text);
  });
  it.each(receipt.modules)("authenticates the actual relocated helper $path", ({ path }) => {
    positive(descriptorAdapterPaths[0]);
    for (const change of [(source: string) => source + "\n// changed\n", () => ""])
      expect(() =>
        authenticateDescriptorAdapterRelocation(undefined, (file) => {
          const source = readDescriptorAdapterSource(file);
          return file === path ? change(source) : source;
        }),
      ).toThrow("actual helper mismatch");
  });
  it.each(receipt.priorReceipts)("keeps the original receipt bytes for $path", ({ path }) => {
    positive(descriptorAdapterPaths[1]);
    expect(() =>
      authenticateDescriptorAdapterRelocation(
        undefined,
        (file) => readDescriptorAdapterSource(file) + (file === path ? "\n" : ""),
      ),
    ).toThrow("prior receipt mismatch");
  });
});

function declaration(source: string, name: string): string {
  const file = ts.createSourceFile("adapter.ts", source, ts.ScriptTarget.Latest, true);
  const rows = file.statements.filter(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.getText(file);
}
describe("actual relocated adapter definitions and acquisition", () => {
  it("retains the entire SameValue registration body and comments", () => {
    const { prior } = positive(descriptorAdapterPaths[0]);
    const actual = declaration(
      readDescriptorAdapterSource("src/codegen/object-same-value.ts"),
      "registerObjectSameValueHelper",
    );
    expect(actual).toBe("export " + declaration(prior, "registerObjectSameValueHelper"));
  });
  it.each([false, true])("retains undefined acquisition timing before the data recipe, changing=%s", (changing) => {
    const { prior } = positive(descriptorAdapterPaths[1]);
    const file = ts.createSourceFile("old.ts", prior, ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "buildOrdinaryObjectDataDescriptorBody"
      )
        calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(calls).toHaveLength(1);
    const actual = ts.transpileModule(
      declaration(
        readDescriptorAdapterSource("src/codegen/object-descriptor-data.ts"),
        "buildObjectDataDescriptorBody",
      ).replace(/^export /, ""),
      { compilerOptions: { target: ts.ScriptTarget.ESNext } },
    ).outputText;
    const run = (relocated: boolean) => {
      const resources = {
        objectTypeIdx: 1,
        propEntryTypeIdx: 2,
        objFindIdx: 3,
        objInsertIdx: 4,
        objGrowIdx: 5,
        sameValueIdx: 6,
        flags: ORDINARY_OBJECT_DESCRIPTOR_ENCODING,
        errors: {
          constructorIdx: 7,
          tagIdx: 0,
          messages: Array.from({ length: 6 }, (): Instr[] => [{ op: "ref.null.extern" }]),
        },
      };
      const trace: unknown[] = [];
      const undefinedOperand = (): Instr[] => {
        trace.push("undefined");
        if (changing) resources.sameValueIdx = 61;
        return [
          { op: "block", blockType: { kind: "val", type: { kind: "externref" } }, body: [{ op: "ref.null.extern" }] },
        ];
      };
      const recipe = (data: typeof resources, operand: Instr[]) => {
        expect(Object.is(data, resources)).toBe(true);
        trace.push(["body", data.sameValueIdx]);
        return buildOrdinaryObjectDataDescriptorBody(data, operand);
      };
      const body = new Function(
        "ctx",
        "s4DescriptorResources",
        "canonicalUndefinedExternInstrs",
        "buildOrdinaryObjectDataDescriptorBody",
        relocated
          ? actual + "\nreturn buildObjectDataDescriptorBody(ctx, s4DescriptorResources);"
          : "return " + calls[0]!.getText(file),
      )({}, resources, undefinedOperand, recipe) as Instr[];
      return { trace, body };
    };
    const old = run(false),
      next = run(true);
    expect(next).toStrictEqual(old);
    expect(next.trace).toStrictEqual(["undefined", ["body", changing ? 61 : 6]]);
  });
});
