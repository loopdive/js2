import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IrCutoverAuditEnvelope } from "../src/compiler/ir-cutover-invocation.js";

describe("standalone physical route audit subprocess sink", () => {
  it("records an audit without requiring the public tracking option", () => {
    const directory = mkdtempSync(join(tmpdir(), "js2-standalone-route-audit-"));
    const sink = join(directory, "audit.jsonl");
    const source = `
export class Box {
  method(): number { return 1; }
}
export function main(): number {
  setTimeout(() => {}, 0);
  return 1;
}
`;
    const script = `
      import { compile } from "./src/index.ts";
      const result = await compile(
        ${JSON.stringify(source)},
        { fileName: "subprocess-audit.ts", target: "standalone", experimentalIR: false },
      );
      if (!result.success) throw new Error(result.errors.map((error) => error.message).join("\\n"));
      if (result.irBodyRouteAudit === undefined) throw new Error("missing in-process route audit");
    `;

    try {
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, JS2WASM_IR_CUTOVER_AUDIT: sink },
        timeout: 30_000,
      });
      expect(child.status, child.stderr || child.stdout).toBe(0);

      const lines = readFileSync(sink, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const envelope = JSON.parse(lines[0]!) as IrCutoverAuditEnvelope;
      expect(envelope.schema).toBe("js2-ir-cutover-audit-v1");
      expect(envelope.success).toBe(true);
      const audit = envelope.audit;
      expect(audit.route).toBe("compile");
      expect(audit.target).toBe("standalone");
      expect(audit.graph).toBe("single");
      expect(audit.generator).toBe("generateModule");
      expect(audit.allUnitCount).toBeGreaterThan(0);
      expect(audit.dispositions).toHaveLength(audit.allUnitCount);
      expect(audit.dispositions.some((row) => row.unitId.includes("compiler-unit%3Atimer-shim%3Aset-timeout"))).toBe(
        true,
      );
      expect(audit.legacyEntries.length).toBeGreaterThan(0);
      expect(audit.legacyEntries).toContainEqual(
        expect.objectContaining({
          entryPoint: "compileFunctionBody",
          bodyName: "main",
          file: "subprocess-audit.ts",
          line: 5,
          column: 1,
        }),
      );
      expect(audit.classes).toContainEqual(
        expect.objectContaining({
          displayName: "Box",
          line: 2,
          column: 1,
          declarationStart: source.indexOf("export class Box"),
          declarationEnd: source.indexOf("\nexport function main"),
        }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats an empty sink path as disabled", () => {
    const script = `
      import { compile } from "./src/index.ts";
      const result = await compile(
        "export function main(): number { return 1; }",
        { fileName: "empty-subprocess-audit.ts", target: "standalone", experimentalIR: false },
      );
      if (!result.success) throw new Error(result.errors.map((error) => error.message).join("\\n"));
      if (result.irBodyRouteAudit !== undefined) throw new Error("empty sink unexpectedly enabled the audit");
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, JS2WASM_IR_CUTOVER_AUDIT: "" },
      timeout: 30_000,
    });
    expect(child.status, child.stderr || child.stdout).toBe(0);
  });

  it("reports sink write failures to the subprocess caller", () => {
    const directory = mkdtempSync(join(tmpdir(), "js2-standalone-route-error-"));
    const sink = join(directory, "missing", "audit.jsonl");
    const script = `
      import { compile } from "./src/index.ts";
      await compile(
        "export function main(): number { return 1; }",
        { fileName: "failed-subprocess-audit.ts", target: "standalone", experimentalIR: false },
      );
    `;
    try {
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, JS2WASM_IR_CUTOVER_AUDIT: sink },
        timeout: 30_000,
      });
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain("JS2WASM_IR_CUTOVER_AUDIT could not append");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails loudly when the requested runtime has no synchronous filesystem", () => {
    const script = `
      import { emitIrCutoverAudit } from "./src/compiler/ir-cutover-invocation.ts";
      import { setDefaultEnvironment } from "./src/env.ts";
      setDefaultEnvironment({ fs: null, path: null, url: null, module: null });
      emitIrCutoverAudit({ irBodyRouteAudit: {} });
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, JS2WASM_IR_CUTOVER_AUDIT: "audit.jsonl" },
      timeout: 30_000,
    });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("requires synchronous Environment.fs");
    expect(child.stderr).toContain("available in Node 20 from 20.16 and Node 22 from 22.3");
  });
});
