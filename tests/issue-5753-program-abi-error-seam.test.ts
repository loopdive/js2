// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProgramAbiInvariantError } from "../src/shared/contracts/program-abi-error.js";
import { ProgramAbiInvariantError as ProgramError, ProgramAbiMap } from "../src/ir/program/abi.js";
import { ProgramAbiInvariantError as LegacyError } from "../src/ir/program-abi.js";

const root = resolve(import.meta.dirname, "..");
const base = "b7521221b4b7ca22f95d28671314d785815cb4f0";
const path = "src/ir/program/abi.ts";
const original = execFileSync("git", ["show", `${base}:${path}`], { cwd: root, encoding: "utf8" });
const start = original.indexOf("export type ProgramAbiInvariantCode =");
const end = original.indexOf("\nconst indexKey", start);
const block = original.slice(start, end).trim();
const leaf = readFileSync(resolve(root, "src/shared/contracts/program-abi-error.ts"), "utf8");
const current = readFileSync(resolve(root, path), "utf8");

function verify(source: string, facade: string) {
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(source.trim()).toBe(original.split("\n")[0] + "\n\n" + block);
  const imports = 'import { ProgramAbiInvariantError } from "../../shared/contracts/program-abi-error.js";\n';
  const exports =
    'export { ProgramAbiInvariantError, type ProgramAbiInvariantCode } from "../../shared/contracts/program-abi-error.js";\n';
  expect(facade.split(imports)).toHaveLength(2);
  expect(facade.split(exports)).toHaveLength(2);
  const restored = facade
    .replace(imports, "")
    .replace(exports, "")
    .replace("\nconst indexKey", "\n" + block + "\n\nconst indexKey");
  expect(restored).toBe(original);
}

describe("program ABI error relocation", () => {
  it("keeps all three constructor routes identical and preserves thrown fields", () => {
    expect(ProgramError).toBe(ProgramAbiInvariantError);
    expect(LegacyError).toBe(ProgramAbiInvariantError);
    const abi = new ProgramAbiMap({ sources: [], allUnits: [], terminalUnits: [], classes: [] });
    let thrown: unknown;
    try {
      abi.finishBinding();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProgramAbiInvariantError);
    expect(thrown).toBeInstanceOf(ProgramError);
    expect(thrown).toBeInstanceOf(LegacyError);
    expect(thrown).toMatchObject({
      name: "ProgramAbiInvariantError",
      code: "planning-not-sealed",
      message: "cannot finish ABI binding before planning is sealed",
    });
  });

  it("exactly relocates the complete declaration and body, preserving all map operations", () => {
    verify(leaf, current);
  });

  it("rejects a duplicate constructor after a positive receipt", () => {
    verify(leaf, current);
    expect(() => verify(leaf, current + "\nclass ProgramAbiInvariantError extends Error {}\n")).toThrow();
  });

  it("rejects an upward dependency after a positive receipt", () => {
    verify(leaf, current);
    expect(() => verify(leaf + '\nimport "../ir/program/abi.js";\n', current)).toThrow();
  });
});
