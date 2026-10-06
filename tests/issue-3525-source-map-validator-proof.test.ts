// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Proof-only source witnesses; no source→codec or physical runtime credit.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  captureSourceMapProgramValidatorRelocation,
  captureSourceMapSchemaSourceEpoch,
} from "./helpers/ir-program-validator-relocation.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const epochPath = "tests/helpers/ir-source-map-schema-source-epoch.json";
const helperPath = "tests/helpers/ir-program-validator-relocation.ts";
const receiptPath = "tests/helpers/ir-program-validator-relocation.json";
const validatorPath = "src/ir/program/validation.ts";
const facadePath = "src/ir/program-validation.ts";
// Fixed outside the component's returned report. Root authenticates the new
// helper/recipe epoch separately before releasing these proof-only tests.
const helperPin = { bytes: 46642, sha256: "6e32ca208775e8eeae765bf3345cdd3cb1e0f40a1784f684afd9c4dff3a4cfe0" };
const epochPin = { bytes: 49534, sha256: "7dda716408c18981a48dc6fba90834aa0e7fb95f3f8900b7c4c16e1545f38f3c" };
const currentPin = { bytes: 45816, sha256: "33cba90b606278805766b4eb739214c31dd84babafb873773f3e92f60c470231" };
const relocatedPin = { bytes: 19448, sha256: "572aab2d72f9eabf322347e90c3d13e25f690a44fa3cede1ac5666dcd1674354" };
const donorPin = { bytes: 19427, sha256: "816c404e96f8e9a5782d5c51714f0aec0592967bb13f1e09ca50f3f29c2c3299" };
const oldReceiptPin = { bytes: 27069, sha256: "816848c32744e8ec3e2c414a27420b4a0339e35d815b5002db4754f11104ff92" };
const facadePin = { bytes: 236, sha256: "b64454a7c97179e8efdab677049fb0f231ba3b6ce731bff602b231406d2dd098" };
const currentPaths = [
  "src/ir/program-runtime-demands.ts",
  "src/ir/program/runtime-demands.ts",
  "src/ir/program-runtime-abi.ts",
  "src/ir/program/runtime-abi.ts",
  "src/ir/runtime-program-manifest.ts",
  "src/ir/program/runtime-manifest.ts",
  "src/ir/program-runtime-validation.ts",
  "src/ir/program/runtime-validation.ts",
  facadePath,
  validatorPath,
];
const requests = [epochPath, helperPath, receiptPath, ...currentPaths];
const physical = (path: string): string => readFileSync(resolve(root, path), "utf8");
const sha = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
function pin(text: string, expected: { bytes: number; sha256: string }): void {
  expect(typeof text).toBe("string");
  expect(Buffer.byteLength(text)).toBe(expected.bytes);
  expect(sha(text)).toBe(expected.sha256);
}
function reader(overrides = new Map<string, unknown>()) {
  const trace: string[] = [],
    actual = new Map<string, string>(),
    supplied = new Map<string, unknown>();
  const read = (path: string): string => {
    trace.push(path);
    const value = physical(path);
    actual.set(path, value);
    const operand = overrides.has(path) ? overrides.get(path) : value;
    supplied.set(path, operand);
    return operand as string;
  };
  return { read, trace, actual, supplied, overrides };
}
function healthy() {
  pin(physical(helperPath), helperPin);
  pin(physical(epochPath), epochPin);
  pin(physical(receiptPath), oldReceiptPin);
  pin(physical(validatorPath), currentPin);
  pin(physical(facadePath), facadePin);
  const oldReceipt = JSON.parse(physical(receiptPath));
  for (const pair of oldReceipt.pairs) {
    pin(physical(pair.donorPath), pair.facade);
    if (pair.implementationPath !== validatorPath) pin(physical(pair.implementationPath), pair.implementation);
  }
  const retained = reader();
  const captured = captureSourceMapProgramValidatorRelocation(retained.read);
  expect(retained.trace).toEqual(requests);
  expect(retained.trace).toHaveLength(13);
  for (const path of requests) {
    expect(retained.supplied.get(path)).toBe(retained.actual.get(path));
    expect(retained.trace.filter((request) => request === path)).toHaveLength(1);
  }
  expect(captured.readCurrent(validatorPath)).toBe(retained.actual.get(validatorPath));
  pin(captured.readRelocationCurrent(validatorPath), relocatedPin);
  pin(captured.readBefore(facadePath), donorPin);
  return { retained, captured };
}
type Span = {
  beforeStart: number;
  beforeEnd: number;
  currentStart: number;
  currentEnd: number;
  beforeText: string;
  currentText: string;
};
function inverse(current: string, spans: Span[]): string {
  const bytes = Buffer.from(current),
    parts: Buffer[] = [];
  let cursor = 0;
  for (const span of spans) {
    expect(bytes.subarray(span.currentStart, span.currentEnd).toString("utf8")).toBe(span.currentText);
    parts.push(bytes.subarray(cursor, span.currentStart), Buffer.from(span.beforeText));
    cursor = span.currentEnd;
  }
  parts.push(bytes.subarray(cursor));
  return Buffer.concat(parts).toString("utf8");
}
function replay(before: string, spans: Span[]): string {
  const bytes = Buffer.from(before),
    parts: Buffer[] = [];
  let cursor = 0;
  for (const span of spans) {
    expect(bytes.subarray(span.beforeStart, span.beforeEnd).toString("utf8")).toBe(span.beforeText);
    parts.push(bytes.subarray(cursor, span.beforeStart), Buffer.from(span.currentText));
    cursor = span.beforeEnd;
  }
  parts.push(bytes.subarray(cursor));
  return Buffer.concat(parts).toString("utf8");
}

describe("B3 current validator component proof-only independent operands", () => {
  it("reads thirteen actual primitive operands and independently replays current→relocated→historical validation", () => {
    const { retained, captured } = healthy();
    const epoch = JSON.parse(retained.actual.get(epochPath)!);
    const entry = epoch.entries.find((row: { path: string }) => row.path === validatorPath);
    const current = retained.actual.get(validatorPath)!;
    const relocated = inverse(current, entry.spans);
    pin(relocated, relocatedPin);
    expect(replay(relocated, entry.spans)).toBe(current);
    expect(captured.readRelocationCurrent(validatorPath)).toBe(relocated);
    const receipt = JSON.parse(retained.actual.get(receiptPath)!);
    const pair = receipt.pairs.find((row: { implementationPath: string }) => row.implementationPath === validatorPath);
    const bytes = Buffer.from(relocated);
    const donor = Buffer.concat(
      pair.segments.map((segment: { kind: string; afterStart: number; afterEnd: number; beforeText?: string }) =>
        segment.kind === "unchanged"
          ? bytes.subarray(segment.afterStart, segment.afterEnd)
          : Buffer.from(segment.beforeText!),
      ),
    ).toString("utf8");
    pin(donor, donorPin);
    expect(captured.readBefore(facadePath)).toBe(donor);
    const donorBytes = Buffer.from(donor);
    expect(
      Buffer.concat(
        pair.segments.map((segment: { kind: string; beforeStart: number; beforeEnd: number; afterText?: string }) =>
          segment.kind === "unchanged"
            ? donorBytes.subarray(segment.beforeStart, segment.beforeEnd)
            : Buffer.from(segment.afterText!),
        ),
      ).toString("utf8"),
    ).toBe(relocated);
    console.info(
      "B3 validator proof-only",
      JSON.stringify({
        requests: retained.trace.length,
        physicalCurrent: Buffer.byteLength(current),
        relocated: Buffer.byteLength(relocated),
        donor: Buffer.byteLength(donor),
        facade: facadePin.bytes,
        immutableReceipt: oldReceiptPin.bytes,
      }),
    );
  });
  it("inverts all eleven fixed recipe paths from actual supplied current DATA without expanding component read scope", () => {
    healthy();
    const retained = reader();
    const epoch = captureSourceMapSchemaSourceEpoch(retained.read);
    expect(retained.trace).toEqual([epochPath, helperPath]);
    const recipe = JSON.parse(retained.actual.get(epochPath)!);
    expect(recipe.entries).toHaveLength(11);
    for (const entry of recipe.entries) {
      const current = physical(entry.path);
      pin(current, entry.current);
      const before = inverse(current, entry.spans);
      pin(before, entry.before);
      expect(epoch.before(entry.path, current)).toBe(before);
      expect(replay(before, entry.spans)).toBe(current);
    }
    console.info(
      "B3 recipe DATA",
      JSON.stringify({ authorityRequests: retained.trace.length, actualSuppliedPaths: recipe.entries.length }),
    );
  });
  it("refuses the actual changed current source operand after a healthy capture and accepts exact restoration", () => {
    const { retained, captured } = healthy();
    const original = retained.actual.get(validatorPath)!;
    const mutable = reader(new Map([[validatorPath, original + "\n// changed supplied source\n"]]));
    expect(() => captureSourceMapProgramValidatorRelocation(mutable.read)).toThrow(/complete source pin mismatch/);
    expect(mutable.supplied.get(validatorPath)).toBe(mutable.overrides.get(validatorPath));
    expect(mutable.trace).toEqual(requests);
    expect(captured.readCurrent(validatorPath)).toBe(original);
    mutable.overrides.delete(validatorPath);
    mutable.trace.length = 0;
    expect(captureSourceMapProgramValidatorRelocation(mutable.read).readCurrent(validatorPath)).toBe(original);
    expect(mutable.trace).toEqual(requests);
    healthy();
  });
  it("keeps the captured epoch bound to the caller's changed mutable source operand without re-reading a replacement", () => {
    healthy();
    const retained = reader(),
      epoch = captureSourceMapSchemaSourceEpoch(retained.read);
    const original = physical(validatorPath);
    let operand = original;
    expect(epoch.before(validatorPath, operand)).toHaveLength(relocatedPin.bytes);
    operand += "\n// warm caller mutation\n";
    expect(() => epoch.before(validatorPath, operand)).toThrow(/complete source pin mismatch/);
    expect(retained.trace).toEqual([epochPath, helperPath]);
    operand = original;
    pin(epoch.before(validatorPath, operand), relocatedPin);
    healthy();
  });
  for (const target of [validatorPath, epochPath])
    it(`rejects boxed/getter operand at ${target} without executing conversion hooks`, () => {
      healthy();
      let getters = 0,
        conversions = 0;
      const boxed = Object(physical(target));
      Object.defineProperty(boxed, Symbol.toPrimitive, {
        get() {
          getters++;
          return () => {
            conversions++;
            return physical(target);
          };
        },
      });
      const retained = reader(new Map([[target, boxed]]));
      expect(() => captureSourceMapProgramValidatorRelocation(retained.read)).toThrow(/primitive text required/);
      expect(retained.supplied.get(target)).toBe(boxed);
      expect([getters, conversions]).toEqual([0, 0]);
      healthy();
    });
  it("rejects a boxed direct current operand without calling its getter or coercion", () => {
    healthy();
    const retained = reader(),
      epoch = captureSourceMapSchemaSourceEpoch(retained.read);
    let calls = 0;
    const boxed = Object(physical(validatorPath));
    Object.defineProperty(boxed, "valueOf", {
      get() {
        calls++;
        return () => {
          calls++;
          return physical(validatorPath);
        };
      },
    });
    expect(() => epoch.before(validatorPath, boxed as string)).toThrow(/primitive text required/);
    expect(calls).toBe(0);
    healthy();
  });
  it("rejects a supplied helper suffix mutation through independent full-file authority (prefix capture alone does not authenticate it)", () => {
    healthy();
    const operand = physical(helperPath) + "\n// changed supplied component suffix\n";
    const retained = reader(new Map([[helperPath, operand]]));
    expect(() => captureSourceMapProgramValidatorRelocation(retained.read)).not.toThrow();
    expect(retained.supplied.get(helperPath)).toBe(operand);
    expect(() => pin(retained.supplied.get(helperPath) as string, helperPin)).toThrow();
    healthy();
  });
  it("propagates an actual readFileSync missing epoch operand error and restores a fresh healthy read", () => {
    healthy();
    expect(() =>
      captureSourceMapProgramValidatorRelocation((path) =>
        path === epochPath ? physical(path + ".missing-independent-control") : physical(path),
      ),
    ).toThrow(/ENOENT/);
    healthy();
  });
  for (const corruption of ["invalid JSON", "changed actual recipe span", "unrelated side field"] as const)
    it(`refuses ${corruption} at the fixed epoch digest guard, then accepts restoration`, () => {
      healthy();
      const text = physical(epochPath),
        recipe = JSON.parse(text);
      if (corruption === "changed actual recipe span")
        recipe.entries.find((row: { path: string }) => row.path === validatorPath).spans[0].currentText += " ";
      if (corruption === "unrelated side field") recipe.unrelated = true;
      const operand = corruption === "invalid JSON" ? text + "{" : JSON.stringify(recipe);
      const retained = reader(new Map([[epochPath, operand]]));
      expect(() => captureSourceMapProgramValidatorRelocation(retained.read)).toThrow(
        /source map schema receipt bytes mismatch/,
      );
      expect(retained.trace).toEqual([epochPath]);
      expect(retained.supplied.get(epochPath)).toBe(operand);
      // These are digest refusals, not independently reached recipe-row guards.
      healthy();
    });
});
