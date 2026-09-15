// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyObservation, formatConsoleArguments, loadManifest } from "../scripts/audit-javascript-soundness.mjs";

const normal = (stdout = "", stderr = "") => ({ status: "normal", stdout, stderr });
const abrupt = (name: string, stdout = "") => ({
  status: "abrupt",
  stdout,
  stderr: "",
  thrown: {
    comparable: true,
    identity: { type: "error", name },
  },
});

describe("#5393: JavaScript audit observation integrity", () => {
  it("accepts completed identical empty output and preserves empty-line differences", () => {
    expect(classifyObservation(normal(), normal())).toBe("match");
    expect(classifyObservation(normal("\n"), normal())).toBe("output_mismatch");
    expect(classifyObservation(normal("x \n"), normal("x\n"))).toBe("output_mismatch");
    expect(classifyObservation(normal("x\n\n"), normal("x\n"))).toBe("output_mismatch");
  });

  it("distinguishes stderr and stdout rather than combining channels", () => {
    expect(classifyObservation(normal("", "x\n"), normal("x\n"))).toBe("output_mismatch");
  });

  it("uses exact primitive console formatting, including undefined and signed zero", () => {
    expect(formatConsoleArguments([undefined])).toBe("undefined\n");
    expect(formatConsoleArguments([-0])).toBe("-0\n");
    expect(formatConsoleArguments([NaN, Infinity, 1n, false])).toBe("NaN Infinity 1n false\n");
    expect(classifyObservation(normal(formatConsoleArguments([-0])), normal(formatConsoleArguments([0])))).toBe(
      "output_mismatch",
    );
    expect(classifyObservation(normal("undefined:undefined\n"), normal("string:undefined\n"))).toBe("output_mismatch");
    expect(classifyObservation(normal("undefined:undefined\n"), normal("object:null\n"))).toBe("output_mismatch");
  });

  it("distinguishes normal completion, throw category, and effects before a throw", () => {
    expect(classifyObservation(abrupt("TypeError"), normal())).toBe("completion_mismatch");
    expect(classifyObservation(abrupt("TypeError"), abrupt("RangeError"))).toBe("exception_mismatch");
    expect(classifyObservation(abrupt("TypeError", "before\n"), abrupt("TypeError"))).toBe("output_mismatch");
    expect(classifyObservation(abrupt("TypeError", "before\n"), abrupt("TypeError", "before\n"))).toBe("match");
  });

  it("distinguishes thrown primitive types and signed zero", () => {
    const thrown = (type: string, value: string) => ({
      ...abrupt("unused"),
      thrown: { comparable: true, identity: { type, value } },
    });
    expect(classifyObservation(thrown("number", "-0"), thrown("number", "0"))).toBe("exception_mismatch");
    expect(classifyObservation(thrown("undefined", "undefined"), thrown("string", "undefined"))).toBe(
      "exception_mismatch",
    );
  });

  it.each(["timeout", "inconclusive", "observation_error", "worker_error"])("never counts %s as a match", (status) => {
    expect(classifyObservation(normal(), { ...normal(), status })).toBe("inconclusive");
    expect(classifyObservation({ ...normal(), status }, normal())).toBe("oracle_inconclusive");
  });

  it("keeps refusals, invalid modules, opaque exceptions, and missing observations distinct", () => {
    expect(classifyObservation(normal(), { ...normal(), status: "compile_error" })).toBe("diagnostic_refusal");
    expect(classifyObservation(normal(), { ...normal(), status: "invalid_wasm" })).toBe("invalid_wasm");
    expect(classifyObservation(normal(), { ...normal(), status: "link_error" })).toBe("link_error");
    expect(classifyObservation(abrupt("Error"), { ...abrupt("Error"), thrown: { comparable: false } })).toBe(
      "inconclusive",
    );
    expect(classifyObservation(normal(), { status: "normal" })).toBe("inconclusive");
  });

  it("rejects empty, miscounted, duplicate, and empty-filter inventories", () => {
    const directory = mkdtempSync(join(tmpdir(), "js2-audit-observation-"));
    const path = join(directory, "manifest.json");
    const entry = { id: "one", category: "control", source: "console.log(1)" };
    const write = (manifest: object) => writeFileSync(path, JSON.stringify(manifest));
    try {
      write({ version: 1, expectedCount: 0, cases: [] });
      expect(() => loadManifest(path)).toThrow("Inventory mismatch");
      write({ version: 1, expectedCount: 2, cases: [entry] });
      expect(() => loadManifest(path)).toThrow("Inventory mismatch");
      write({ version: 1, expectedCount: 2, cases: [entry, entry] });
      expect(() => loadManifest(path)).toThrow("duplicate");
      write({ version: 1, expectedCount: 1, cases: [entry] });
      expect(loadManifest(path).cases).toHaveLength(1);
      expect(() => loadManifest(path, "absent")).toThrow("zero cases");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("hashes module file contents and validates module entry", () => {
    const directory = mkdtempSync(join(tmpdir(), "js2-audit-modules-"));
    const path = join(directory, "manifest.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          expectedCount: 1,
          cases: [{ id: "module", category: "modules", files: { "a.js": "export const x=1" }, entry: "a.js" }],
        }),
      );
      expect(loadManifest(path).cases[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
