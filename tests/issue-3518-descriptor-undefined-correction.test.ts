// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  applyDescriptorUndefinedCorrection,
  beforeDescriptorUndefinedCorrection,
  descriptorUndefinedPaths,
  descriptorUndefinedReceipt,
  descriptorUndefinedReceiptPath,
} from "./helpers/descriptor-undefined-correction.js";
import {
  authenticateWriteExtraction,
  captureWriteDonor,
  invertObjectWriteSource,
  originalWriteDonors,
  readWriteSource,
  writeRegisterScope,
  writeSourceHash,
} from "./helpers/native-object-write-donor.js";
import { buildOrdinaryObjectDataDescriptorBody } from "../src/runtime/wasmgc/values/ordinary-object-descriptor-data.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "../src/runtime/wasmgc/values/ordinary-object-descriptor-common.js";
import type { Instr } from "../src/wasm/model/instructions.js";

const records = descriptorUndefinedReceipt().records;
function positive(path: string) {
  const current = readWriteSource(path),
    historical = beforeDescriptorUndefinedCorrection(path, current);
  expect(applyDescriptorUndefinedCorrection(path, historical, false)).toBe(current);
  expect(writeSourceHash(historical)).toBe(records.find((row) => row.path === path)!.beforeSHA256);
  return { current, historical };
}
describe("authenticated canonical undefined forward correction", () => {
  it.each(records)("reconstructs and replays the whole signed $path", ({ path }) => {
    const { historical } = positive(path);
    const receipt = authenticateWriteExtraction();
    if (path === descriptorUndefinedPaths[0])
      expect(invertObjectWriteSource(path, historical)).toBe(
        originalWriteDonors().find((row) => row.file === path)!.source,
      );
    else expect(writeSourceHash(historical)).toBe(receipt.modules[path]);
  });
  it.each(records)("positive first: damaged, missing and duplicate spans fail for $path", ({ path, spans }) => {
    const { current } = positive(path);
    for (const span of spans) {
      expect(current.split(span.after)).toHaveLength(2);
      for (const replacement of ["", span.after + span.after, span.after.replace(/\S/, "!")]) {
        const changed = current.replace(span.after, replacement);
        expect(changed).not.toBe(current);
        expect(() => beforeDescriptorUndefinedCorrection(path, changed)).toThrow("source mismatch");
      }
    }
  });
  it.each(records)("positive first: reordered and outside edits fail for $path", ({ path, spans }) => {
    const { current, historical } = positive(path);
    expect(spans.length).toBeGreaterThan(1);
    const first = spans[0]!.after,
      last = spans.at(-1)!.after,
      marker = "__descriptor_reorder__";
    expect(current).not.toContain(marker);
    const reversed = current.replace(first, marker).replace(last, first).replace(marker, last);
    expect(reversed).not.toBe(current);
    for (const changed of [reversed, current + "\n// outside correction\n", historical])
      expect(() => beforeDescriptorUndefinedCorrection(path, changed)).toThrow("source mismatch");
  });
  it("rejects changed receipt authority and unknown paths after a positive reconstruction", () => {
    positive(descriptorUndefinedPaths[0]);
    const text = readWriteSource(descriptorUndefinedReceiptPath);
    expect(() => descriptorUndefinedReceipt(text + "\n")).toThrow("receipt mismatch");
    expect(() => applyDescriptorUndefinedCorrection("unknown", "", true)).toThrow("unknown descriptor undefined path");
  });
  it.each([false, true])("preserves acquisition order and changes only the data default, changing=%s", (changing) => {
    const { current, historical } = positive(descriptorUndefinedPaths[0]);
    const options = { symbol: true, own: true, carrier: true, offset: 29, changing };
    const old = captureWriteDonor(writeRegisterScope(historical, "__defineProperty_value"), options);
    const next = captureWriteDonor(writeRegisterScope(current, "__defineProperty_value"), options);
    expect(next.trace).toStrictEqual([...old.trace.slice(0, -1), ["undefined"], old.trace.at(-1)]);
    const expected = structuredClone(old.definition);
    const target = [
      { op: "local.get", index: 11 },
      { op: "ref.as_non_null" },
      { op: "ref.null", typeIdx: -18 },
      { op: "struct.set", typeIdx: 8, fieldIdx: 1 },
    ];
    let replacements = 0;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        if (JSON.stringify(node) === JSON.stringify(target)) {
          replacements++;
          node.splice(
            2,
            1,
            { op: "block", blockType: { kind: "val", type: { kind: "externref" } }, body: [{ op: "ref.null.extern" }] },
            { op: "any.convert_extern" },
          );
        } else node.forEach(visit);
      } else if (node && typeof node === "object") Object.values(node).forEach(visit);
    };
    visit(expected.body);
    expect(replacements).toBe(1);
    expect(next.definition).toStrictEqual(expected);
    expect(next.definition).not.toStrictEqual(old.definition);
  });
  it("owns each nested undefined operand graph independently", () => {
    const literal: Instr[] = [
      { op: "block", blockType: { kind: "val", type: { kind: "anyref" } }, body: [{ op: "ref.null", typeIdx: -18 }] },
    ];
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
    const first = buildOrdinaryObjectDataDescriptorBody(resources, literal);
    const second = buildOrdinaryObjectDataDescriptorBody(resources, literal);
    const before = structuredClone(first);
    (literal[0] as Extract<Instr, { op: "block" }>).body.push({ op: "nop" });
    expect(first).toStrictEqual(before);
    expect(second).toStrictEqual(before);
    const findBlock = (node: unknown): Instr[] | undefined => {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findBlock(child);
          if (found) return found;
        }
      } else if (node && typeof node === "object") {
        const value = node as { op?: string; body?: Instr[]; blockType?: { kind: string; type?: { kind: string } } };
        if (value.op === "block" && value.blockType?.type?.kind === "anyref") return value.body;
        for (const child of Object.values(node)) {
          const found = findBlock(child);
          if (found) return found;
        }
      }
    };
    const nested = findBlock(first);
    expect(nested).toBeDefined();
    nested!.push({ op: "nop" });
    expect(first).not.toStrictEqual(before);
    expect(second).toStrictEqual(before);
  });
});
