// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const repo = process.cwd();
const script = "scripts/check-ir-kind-neutrality.mjs";
const baseline = "scripts/ir-kind-neutrality-baseline.json";
const classes = "src/ir/core/class-nodes.ts";
const nodes = "src/ir/core/nodes.ts";
const lowering = "src/ir/backend/class-allocation.ts";
let sandbox: string;
let refreshed: string;
const read = (file: string) => readFileSync(path.join(sandbox, file), "utf8");
const write = (file: string, value: string) => writeFileSync(path.join(sandbox, file), value);
function gate(args: string[] = []) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [script, ...args], { cwd: sandbox, encoding: "utf8", stdio: "pipe" }),
    };
  } catch (error) {
    const result = error as { status: number; stdout: string; stderr: string };
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }
}
beforeAll(() => {
  const root = path.join(repo, ".tmp");
  mkdirSync(root, { recursive: true });
  sandbox = mkdtempSync(path.join(root, "7139-class-kinds-"));
  cpSync(path.join(repo, "src/ir"), path.join(sandbox, "src/ir"), { recursive: true });
  mkdirSync(path.join(sandbox, "scripts"));
  for (const file of [script, baseline]) cpSync(path.join(repo, file), path.join(sandbox, file));
  const before = JSON.parse(read(baseline));
  // Only the disposable copy is refreshed. Main owns the committed record.
  const update = gate(["--update-on-decrease"]);
  expect(update.code, update.out).toBe(0);
  refreshed = read(baseline);
  expect(JSON.parse(refreshed).ratchet).toEqual(before.ratchet);
});
beforeEach(() => {
  for (const file of [classes, nodes, lowering]) cpSync(path.join(repo, file), path.join(sandbox, file));
  write(baseline, refreshed);
});
afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});
it("includes the canonical class source and allocation kind without increasing semantic ratchets", () => {
  const result = gate(["--json"]);
  expect(result.code, result.out).toBe(0);
  const record = JSON.parse(result.out);
  expect(record.counts.total).toBeGreaterThanOrEqual(98);
  expect(record.kinds["class.value.new"].declaredAt).toBe(`${classes}#IrInstrClassValueNew`);
  expect(record.kinds["class.value.new"].verdict).toBe("neutral");
  expect(record.kinds["class.new"].declaredAt).toBe(`${classes}#IrInstrClassNew`);
  expect(record.kinds["class.value.new"].evidence.some((cite: string) => cite.startsWith(`${lowering}#`))).toBe(true);
});
it("fails when canonical class declarations are unavailable", () => {
  rmSync(path.join(sandbox, classes));
  const result = gate();
  expect(result.code).toBe(1);
  expect(result.out).toContain(`${classes}: required kind-population source is missing or unreadable`);
});
it("rejects duplicate class declarations in a facade", () => {
  const declaration = read(classes).match(/export interface IrInstrClassValueNew\b[\s\S]*?\n}/)![0];
  write(nodes, `${read(nodes)}\n${declaration}\n`);
  const result = gate();
  expect(result.code).toBe(1);
  expect(result.out).toContain("duplicate kind-bearing interface `IrInstrClassValueNew`");
});
it("rejects an unclassified new instruction in the class source", () => {
  write(
    classes,
    `${read(classes)}\nexport interface IrInstrUnclassifiedClassProbe {\n  readonly kind: "class.unclassified_probe";\n}\n`,
  );
  const source = read(nodes);
  expect(source).toContain("export type IrInstr =");
  write(nodes, source.replace("export type IrInstr =", "export type IrInstr = IrInstrUnclassifiedClassProbe |"));
  const result = gate();
  expect(result.code).toBe(1);
  expect(result.out).toContain("class.unclassified_probe");
  expect(result.out).toContain("unclassified");
});
it("requires actual allocator lowering evidence", () => {
  const quote = "emitter.emitCall(resolver.resolveFunc(instruction.allocator), out);";
  expect(read(lowering)).toContain(quote);
  write(lowering, read(lowering).replace(quote, "/* removed allocator lowering evidence */"));
  const result = gate();
  expect(result.code).toBe(1);
  expect(result.out).toContain("the cited evidence is gone");
  expect(result.out).toContain("class.value.new");
});
