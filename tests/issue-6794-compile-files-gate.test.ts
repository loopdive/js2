// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6794 part 6 — `compileFiles()` ran its own TS-diagnostic gate: no
// TOLERATED_SYNTAX_CODES and no allowJs exemption. A JavaScript project that
// compiles through `compile()` / `compileProject()` failed through
// `compileFiles()` on sloppy-mode syntax such as a legacy octal literal. Both
// multi-file adapters now share one gate.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileFiles, compileProject } from "../src/index.ts";

const dir = mkdtempSync(path.join(tmpdir(), "issue-6794-cf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fatal = (r: { errors: Array<{ severity: string; message: string }> }) =>
  r.errors.filter((e) => e.severity === "error").map((e) => e.message);

describe("#6794 — compileFiles shares the compileMulti diagnostic gate", () => {
  it("accepts a sloppy-mode octal literal in a JavaScript entry (allowJs)", async () => {
    const entry = path.join(dir, "octal.js");
    writeFileSync(entry, "export function f() {\n  return 010;\n}\n");
    const viaFiles = await compileFiles(entry, { allowJs: true });
    const viaProject = await compileProject(entry, { allowJs: true, packageLinking: false });
    expect(viaProject.success, fatal(viaProject).join("\n")).toBe(true);
    expect(viaFiles.success, fatal(viaFiles).join("\n")).toBe(true);
    expect(WebAssembly.validate(viaFiles.binary)).toBe(true);
  }, 60_000);

  it("accepts the same literal in an imported JavaScript dependency", async () => {
    const dep = path.join(dir, "dep.js");
    const entry = path.join(dir, "main.js");
    writeFileSync(dep, "export function f() {\n  return 010;\n}\n");
    writeFileSync(entry, 'import { f } from "./dep.js";\nexport function g() {\n  return f();\n}\n');
    const r = await compileFiles(entry, { allowJs: true });
    expect(r.success, fatal(r).join("\n")).toBe(true);
  }, 60_000);

  it("still rejects a real syntax error in a TypeScript entry", async () => {
    const entry = path.join(dir, "bad.ts");
    writeFileSync(entry, "export function f(): number {\n  return 1;\n})\n");
    const r = await compileFiles(entry);
    expect(r.success).toBe(false);
  }, 60_000);
});
