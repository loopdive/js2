// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Current source custody and reciprocal DATA proofs; no runtime execution credit.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  captureSourceMapValidatorCurrentSuccessor,
  createSourceMapValidatorCurrentSuccessorReader,
} from "./helpers/ir-source-map-validator-current-successor.js";

type Pin = { bytes: number; sha256: string };
type Span = {
  beforeStart: number;
  beforeEnd: number;
  currentStart: number;
  currentEnd: number;
  beforeText: string;
  currentText: string;
};
type Entry = { path: string; before: Pin; current: Pin; spans: Span[] };
const root = fileURLToPath(new URL("../", import.meta.url));
const receiptPath = "tests/helpers/ir-source-map-validator-current-successor.json";
const helperPath = "tests/helpers/ir-source-map-validator-current-successor.ts";
const receiptPin = { bytes: 41469, sha256: "0c6bf6f0bd24a2fb4ab23d44102acc38f7ad441dba056a7c13728fc1d62b9d22" };
const helperPin = { bytes: 7275, sha256: "1a949ce63e0fe01f873c76bd40f4a6af6056496686907d356af5f66c3f41b61a" };
const disk = (path: string): string => readFileSync(resolve(root, path), "utf8");
const hash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
function pin(text: string | Buffer, expected: Pin): void {
  expect(Buffer.byteLength(text)).toBe(expected.bytes);
  expect(hash(text)).toBe(expected.sha256);
}
function receipt() {
  pin(disk(helperPath), helperPin);
  const raw = disk(receiptPath);
  pin(raw, receiptPin);
  return JSON.parse(raw) as {
    schema: string;
    coordinateUnit: string;
    sources: Entry[];
    anchors: { path: string; current: Pin }[];
    caller: Entry;
  };
}
function reader(overrides = new Map<string, unknown>()) {
  const trace: string[] = [];
  const read = (path: string): string => {
    trace.push(path);
    return (overrides.has(path) ? overrides.get(path) : disk(path)) as string;
  };
  return { read, trace, overrides };
}
function requests(): string[] {
  const data = receipt();
  return [
    receiptPath,
    ...data.sources.map((entry) => entry.path),
    ...data.anchors.map((entry) => entry.path),
    data.caller.path,
  ];
}
function invert(current: string, entry: Entry): string {
  pin(current, entry.current);
  const bytes = Buffer.from(current),
    parts: Buffer[] = [];
  let currentEnd = 0,
    beforeEnd = 0;
  for (const span of entry.spans) {
    expect([span.currentStart, span.currentEnd, span.beforeStart, span.beforeEnd].every(Number.isSafeInteger)).toBe(
      true,
    );
    expect(span.currentStart).toBeGreaterThanOrEqual(currentEnd);
    expect(span.beforeStart).toBeGreaterThanOrEqual(beforeEnd);
    expect(span.currentEnd).toBeGreaterThanOrEqual(span.currentStart);
    expect(span.beforeEnd).toBeGreaterThanOrEqual(span.beforeStart);
    expect(span.currentStart - currentEnd).toBe(span.beforeStart - beforeEnd);
    expect(Buffer.byteLength(span.currentText)).toBe(span.currentEnd - span.currentStart);
    expect(Buffer.byteLength(span.beforeText)).toBe(span.beforeEnd - span.beforeStart);
    expect(bytes.subarray(span.currentStart, span.currentEnd).toString("utf8")).toBe(span.currentText);
    parts.push(bytes.subarray(currentEnd, span.currentStart), Buffer.from(span.beforeText));
    currentEnd = span.currentEnd;
    beforeEnd = span.beforeEnd;
  }
  expect(bytes.length - currentEnd).toBe(entry.before.bytes - beforeEnd);
  parts.push(bytes.subarray(currentEnd));
  const old = Buffer.concat(parts);
  pin(old, entry.before);
  const forward: Buffer[] = [];
  let start = 0;
  for (const span of entry.spans) {
    expect(old.subarray(span.beforeStart, span.beforeEnd).toString("utf8")).toBe(span.beforeText);
    forward.push(old.subarray(start, span.beforeStart), Buffer.from(span.currentText));
    start = span.beforeEnd;
  }
  forward.push(old.subarray(start));
  expect(Buffer.concat(forward).equals(bytes)).toBe(true);
  return old.toString("utf8");
}

describe("current source-map validator reciprocal source successor", () => {
  it("authenticates twenty actual sources, three old anchors and caller in exactly twenty-five physical reads", () => {
    const data = receipt();
    expect(data.sources).toHaveLength(20);
    expect(data.sources.filter((entry) => entry.spans.length)).toHaveLength(9);
    expect(data.sources.reduce((count, entry) => count + entry.spans.length, 0)).toBe(57);
    const supplied = reader(),
      captured = captureSourceMapValidatorCurrentSuccessor(supplied.read);
    expect(supplied.trace).toEqual(requests());
    expect(supplied.trace).toHaveLength(25);
    for (const path of requests()) expect(captured.readActual(path)).toBe(disk(path));
    for (const entry of data.sources) {
      pin(disk(entry.path), entry.current);
      expect(captured.readHistoricalCurrent(entry.path)).toBe(invert(disk(entry.path), entry));
    }
    expect(supplied.trace).toHaveLength(25);
    expect(Buffer.byteLength(captured.readActual("src/ir/program/validation.ts"))).toBe(49504);
    expect(Buffer.byteLength(captured.readHistoricalCurrent("src/ir/program/validation.ts"))).toBe(45816);
  });
  it("independently proves the complete current-to-source-map-to-relocated-to-donor chain for all five pairs", () => {
    const data = receipt();
    const before = new Map(data.sources.map((entry) => [entry.path, invert(disk(entry.path), entry)]));
    const epoch = JSON.parse(disk("tests/helpers/ir-source-map-schema-source-epoch.json")) as { entries: Entry[] };
    expect(epoch.entries).toHaveLength(11);
    for (const entry of epoch.entries) invert(before.get(entry.path)!, entry);
    const validator = "src/ir/program/validation.ts";
    before.set(validator, invert(before.get(validator)!, epoch.entries.find((entry) => entry.path === validator)!));
    expect(Buffer.byteLength(before.get(validator)!)).toBe(19448);
    const historical = JSON.parse(disk("tests/helpers/ir-program-validator-relocation.json"));
    expect(historical.pairs).toHaveLength(5);
    for (const pair of historical.pairs) {
      const current = Buffer.from(before.get(pair.implementationPath)!);
      pin(current, pair.implementation);
      pin(before.get(pair.donorPath)!, pair.facade);
      const original = Buffer.concat(
        pair.segments.map((segment: { kind: string; afterStart: number; afterEnd: number; beforeText?: string }) =>
          segment.kind === "unchanged"
            ? current.subarray(segment.afterStart, segment.afterEnd)
            : Buffer.from(segment.beforeText!),
        ),
      );
      pin(original, pair.before);
      const replay = Buffer.concat(
        pair.segments.map((segment: { kind: string; beforeStart: number; beforeEnd: number; afterText?: string }) =>
          segment.kind === "unchanged"
            ? original.subarray(segment.beforeStart, segment.beforeEnd)
            : Buffer.from(segment.afterText!),
        ),
      );
      expect(replay.equals(current)).toBe(true);
      if (pair.implementationPath === validator) expect(original).toHaveLength(19427);
    }
  });
  it("retains the whole historical caller and every original callback byte through an exact two-span inverse", () => {
    const entry = receipt().caller,
      current = disk(entry.path),
      old = invert(current, entry);
    expect(entry.spans).toHaveLength(2);
    pin(old, { bytes: 13408, sha256: "447e36da40ea03643d69ebd4b0314c40731e7a24e096548b375cf88eefa17436" });
    expect(current.slice(current.indexOf("function pin("))).toBe(old.slice(old.indexOf("function pin(")));
    for (const anchor of receipt().anchors) pin(disk(anchor.path), anchor.current);
  });
  for (const path of requests().slice(1))
    it(`rejects actual source or anchor drift and fresh restoration at ${path}`, () => {
      const supplied = reader(),
        original = disk(path),
        first = captureSourceMapValidatorCurrentSuccessor(supplied.read);
      supplied.overrides.set(path, original + "\n// changed physical operand\n");
      expect(() => captureSourceMapValidatorCurrentSuccessor(supplied.read)).toThrow(/complete operand pin mismatch/);
      expect(first.readActual(path)).toBe(original);
      supplied.overrides.delete(path);
      expect(captureSourceMapValidatorCurrentSuccessor(supplied.read).readActual(path)).toBe(original);
    });
  for (const mutation of [
    "json",
    "metadata",
    "duplicate",
    "missing",
    "foreign",
    "coordinate",
    "text",
    "hole",
    "overlap",
    "suffix",
  ])
    it(`refuses actual changed receipt ${mutation} without replacing the operand`, () => {
      const value = receipt();
      if (mutation === "metadata") value.coordinateUnit = "character";
      if (mutation === "duplicate") value.sources.push(value.sources[0]!);
      if (mutation === "missing") value.sources.pop();
      if (mutation === "foreign") value.sources[0]!.path = "src/outsider.ts";
      const changed = value.sources.find((entry) => entry.spans.length)!;
      if (mutation === "coordinate") changed.spans[0]!.currentStart++;
      if (mutation === "text") changed.spans[0]!.currentText += " ";
      if (mutation === "hole") changed.spans.splice(0, 1);
      if (mutation === "overlap") changed.spans.splice(1, 0, changed.spans[0]!);
      const raw =
        mutation === "json"
          ? disk(receiptPath) + "{"
          : mutation === "suffix"
            ? disk(receiptPath) + "\n"
            : JSON.stringify(value);
      const supplied = reader(new Map([[receiptPath, raw]]));
      expect(() => captureSourceMapValidatorCurrentSuccessor(supplied.read)).toThrow(/complete operand pin mismatch/);
      expect(supplied.trace).toEqual([receiptPath]);
      // Fixed raw-DATA authority denies these before parsing/span execution.
    });
  for (const target of [receiptPath, "src/ir/program/validation.ts"])
    it(`rejects boxed actual text at ${target} without executing conversion hooks`, () => {
      let conversions = 0;
      const boxed = Object(disk(target));
      Object.defineProperty(boxed, Symbol.toPrimitive, {
        get: () => {
          conversions++;
          return () => {
            conversions++;
            return "";
          };
        },
      });
      expect(() => captureSourceMapValidatorCurrentSuccessor(reader(new Map([[target, boxed]])).read)).toThrow(
        /primitive text/,
      );
      expect(conversions).toBe(0);
    });
  it("rejects missing physical DATA and propagates the genuine missing-path error", () => {
    expect(() =>
      captureSourceMapValidatorCurrentSuccessor(reader(new Map([["src/ir/core/nodes.ts", undefined]])).read),
    ).toThrow(/primitive text/);
    const read = createSourceMapValidatorCurrentSuccessorReader(disk);
    expect(() => read("tests/independent-current-successor-missing-path")).toThrow(/ENOENT/);
  });
  it("captures lazily once, maps all known operands and reads an unknown path only once", () => {
    const supplied = reader(),
      read = createSourceMapValidatorCurrentSuccessorReader(supplied.read);
    expect(supplied.trace).toEqual([]);
    expect(Buffer.byteLength(read("src/ir/program/validation.ts"))).toBe(45816);
    expect(supplied.trace).toEqual(requests());
    for (const path of requests().slice(1)) read(path);
    expect(supplied.trace).toHaveLength(25);
    expect(read(helperPath)).toBe(disk(helperPath));
    expect(read(helperPath)).toBe(disk(helperPath));
    expect(supplied.trace).toEqual([...requests(), helperPath]);
    supplied.overrides.set("src/ir/program/validation.ts", disk("src/ir/program/validation.ts") + " ");
    expect(Buffer.byteLength(read("src/ir/program/validation.ts"))).toBe(45816);
    expect(() => createSourceMapValidatorCurrentSuccessorReader(supplied.read)("src/ir/program/validation.ts")).toThrow(
      /pin mismatch/,
    );
  });
  it("denies nonprimitive or empty paths before lazy capture, Map lookup, physical IO or coercion", () => {
    let conversions = 0;
    const outsider = Object.defineProperty({}, Symbol.toPrimitive, {
      get: () => {
        conversions++;
        return () => "src/ir/program/validation.ts";
      },
    });
    for (const value of [outsider, Object("src/ir/program/validation.ts"), "", undefined, null, 1, Symbol("path")]) {
      const supplied = reader(),
        read = createSourceMapValidatorCurrentSuccessorReader(supplied.read);
      expect(() => read(value as string)).toThrow(/primitive text/);
      expect(supplied.trace).toEqual([]);
      const captured = captureSourceMapValidatorCurrentSuccessor(supplied.read);
      const count = supplied.trace.length;
      expect(() => captured.readActual(value as string)).toThrow(/primitive text/);
      expect(() => captured.readHistoricalCurrent(value as string)).toThrow(/primitive text/);
      expect(supplied.trace).toHaveLength(count);
    }
    expect(conversions).toBe(0);
  });
});
