// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
interface TextRange {
  pos: number;
  end: number;
}

interface ReadonlyTextRange {
  readonly pos: number;
  readonly end: number;
}

interface A extends ReadonlyTextRange {
  marker: number;
}

function setTextRangePos<T extends ReadonlyTextRange>(range: T, pos: number): T {
  (range as TextRange).pos = pos;
  return range;
}

function setTextRangeEnd<T extends ReadonlyTextRange>(range: T, end: number): T {
  (range as TextRange).end = end;
  return range;
}

function setTextRangePosEnd<T extends ReadonlyTextRange>(range: T, pos: number, end: number): T {
  return setTextRangeEnd(setTextRangePos(range, pos), end);
}

function setTextRangePosWidth<T extends ReadonlyTextRange>(range: T, pos: number, width: number): T {
  return setTextRangePosEnd(range, pos, pos + width);
}

export function test(): number {
  const range: A = { pos: 1, end: 2, marker: 7 };
  setTextRangePos(range, 10);
  setTextRangeEnd(range, 20);
  setTextRangePosEnd(range, 30, 35);
  setTextRangePosWidth(range, 40, 6);
  return range.pos * 1000 + (range.end - range.pos) * 100 + range.marker;
}
`;

describe("#1058 generic asserted structural write-through", () => {
  it("keeps nested TextRange assertion writes on the original generic object", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-1058-generic-asserted-write-through.ts",
      target: "gc",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    const exports = instance.exports as unknown as { test(): number };
    expect(exports.test()).toBe(40607);
  });
});
