import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeSource, buildNodeEnvDtsForSource } from "../src/checker/index.js";

// #2603 follow-ups to `--emulate node`:
//  1. identical Node/builtin "Cannot find name 'X'" warnings collapse to one line.
//  2. a `node:` import auto-enables Node API emulation (with a note + a disable flag).
// Driven through the real CLI (cli.ts) since both live in the arg/print layer.

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "js2-2603-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runCli(file: string, src: string, extraArgs: string[] = []): string {
  const input = join(dir, file);
  writeFileSync(input, src);
  // spawnSync gives us stdout AND stderr on both success and failure (warnings
  // are on stderr, and the compile exits 0 — execFileSync would drop them).
  const r = spawnSync("npx", ["tsx", "src/cli.ts", input, "--target", "wasi", "-o", dir, ...extraArgs], {
    encoding: "utf8",
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

const procWarnLines = (out: string) => out.split("\n").filter((l) => l.includes("Cannot find name 'process'"));

describe("#2603 warning dedup + node:-import auto-emulate", () => {
  it("collapses repeated `process` warnings to a single line with a count", () => {
    const src = `process.stdout.write("a");\nprocess.stderr.write("b");\nprocess.stdout.write("c");\n`;
    const out = runCli("dedup.js", src);
    const lines = procWarnLines(out);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/\(3\D*\)/); // "(3×)" — count of 3, char-agnostic
    expect(lines[0]).toContain("--emulate node");
  });

  it("auto-enables Node emulation on a `node:` import (note printed, no process warning)", () => {
    const src = `import { readFileSync } from "node:fs";\nvoid readFileSync;\nprocess.stdout.write("x");\n`;
    const out = runCli("auto.js", src);
    expect(out).toContain("auto-enabled Node API emulation");
    expect(procWarnLines(out).length).toBe(0);
  });

  it("--emulate none disables the node:-import auto-enable (process warns again)", () => {
    const src = `import { readFileSync } from "node:fs";\nvoid readFileSync;\nprocess.stdout.write("x");\n`;
    const out = runCli("noemu.js", src, ["--emulate", "none"]);
    expect(out).not.toContain("auto-enabled Node API emulation");
    expect(procWarnLines(out).length).toBeGreaterThanOrEqual(1);
  });
});

// #2624 — the injected Node typing is IMPORT-SCOPED, not blanket. The synthetic
// `.d.ts` declares ONLY the surface the source touches: the `process` global is
// injected ONLY for a bare `process` reference, and a `node:<mod>` import injects
// ONLY that module (just its imported member names), never the whole Node surface.
// Asserted directly against `buildNodeEnvDtsForSource` (the exact injected text).
describe("#2624 import-scoped Node emulation typing", () => {
  it("a node:fs-only program does NOT inject the `process` global", () => {
    const dts = buildNodeEnvDtsForSource(
      `import { readFileSync } from "node:fs";\nconst f = readFileSync;\nexport const z = 1;\n`,
    );
    expect(dts).toBeDefined();
    // node:fs is declared, scoped to the imported member...
    expect(dts).toContain('declare module "node:fs"');
    expect(dts).toContain("export const readFileSync: any;");
    // ...but the `process` global / interfaces are NOT pulled in.
    expect(dts).not.toContain("declare var process");
    expect(dts).not.toContain("NodeJS_Process");
    expect(dts).not.toContain('declare module "node:process"');
  });

  it("a bare `process` reference injects ONLY the process global, no unrelated modules", () => {
    const dts = buildNodeEnvDtsForSource(`process.stdout.write("x");\nprocess.exit(0);\n`);
    expect(dts).toBeDefined();
    expect(dts).toContain("declare var process: NodeJS_Process;");
    expect(dts).toContain("NodeJS_WritableStream");
    // No module declarations leak in for a program that imports nothing.
    expect(dts).not.toContain("declare module");
  });

  it("a node:process import injects the process module but NOT unrelated node:* modules", () => {
    const dts = buildNodeEnvDtsForSource(`import process from "node:process";\nprocess.exit(0);\n`);
    expect(dts).toBeDefined();
    expect(dts).toContain('declare module "node:process"');
    expect(dts).toContain("export default process;");
    expect(dts).toContain("NodeJS_Process");
    // Only node:process — no node:fs / node:path leaked.
    expect(dts).not.toContain('declare module "node:fs"');
    expect(dts).not.toContain('declare module "node:path"');
    // The import binds `process`, so we do NOT also emit the ambient global.
    expect(dts).not.toContain("declare var process");
  });

  it("multiple node:* imports each declare only their own imported members", () => {
    const dts = buildNodeEnvDtsForSource(
      `import { readFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nvoid readFileSync; void writeFileSync; void join;\n`,
    );
    expect(dts).toBeDefined();
    expect(dts).toContain('declare module "node:fs"');
    expect(dts).toContain("export const readFileSync: any;");
    expect(dts).toContain("export const writeFileSync: any;");
    expect(dts).toContain('declare module "node:path"');
    expect(dts).toContain("export const join: any;");
    // No process surface for a program that never touches process.
    expect(dts).not.toContain("NodeJS_Process");
  });

  it("a program that touches NO Node surface injects nothing (undefined)", () => {
    expect(buildNodeEnvDtsForSource(`export const z: number = 1;\n`)).toBeUndefined();
  });

  it("end-to-end: node:process import + named member resolve under emulateNode (no TS2307/TS2580)", () => {
    const ast = analyzeSource(`import { stdout } from "node:process";\nstdout.write("x");\n`, "e2e-proc.ts", {
      emulateNode: true,
    });
    const msgs = ast.diagnostics.map((d) =>
      typeof d.messageText === "string" ? d.messageText : d.messageText.messageText,
    );
    expect(
      msgs.filter((m) => /Cannot find module|Cannot find name 'process'|Cannot find name 'stdout'/.test(m)),
    ).toEqual([]);
  });

  it("scriptKind defaults are sane for a .ts source with a default import", () => {
    // sanity: namespace import resolves too (the whole-module `any` shape).
    const dts = buildNodeEnvDtsForSource(`import * as fs from "node:fs";\nvoid fs;\n`, ts.ScriptKind.TS);
    expect(dts).toBeDefined();
    expect(dts).toContain('declare module "node:fs"');
    expect(dts).toContain("export default");
  });
});
