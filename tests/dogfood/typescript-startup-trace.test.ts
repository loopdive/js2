import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["startup", "invoke"])(
  "traces a %s exception without accepting the failing module",
  (phase) => {
    const root = mkdtempSync(join(tmpdir(), "typescript-startup-trace-"));
    try {
      writeFileSync(
        join(root, "entry.ts"),
        phase === "startup"
          ? 'throw new Error("startup marker"); export function run(): number { return 7; }'
          : 'export function run(): number { throw new Error("invocation marker"); }',
      );
      const child = spawnSync(
        process.execPath,
        [
          "--experimental-wasm-exnref",
          fileURLToPath(new URL("./typescript-upstream-build-probe.mjs", import.meta.url)),
          "--root",
          root,
          "--mode",
          "source",
          "--entry",
          "entry.ts",
          "--target",
          "standalone",
          "--require-invocations",
          "1",
          "--invoke-zero-case",
          "run=7",
          "--timeout-ms",
          "60000",
          "--json",
        ],
        {
          encoding: "utf8",
          timeout: 65000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            JS2WASM_TYPESCRIPT_PROBE_TRACE_STARTUP: phase === "startup" ? "1" : "0",
            JS2WASM_TYPESCRIPT_PROBE_TRACE_INVOKE: phase === "invoke" ? "1" : "0",
            JS2WASM_TYPESCRIPT_PROBE_DIAGNOSTIC: "0",
          },
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stdout).toContain(phase === "startup" ? '"__module_init"' : '"run"');
      expect(child.stdout).toContain('"__new_Error"');
      const line = child.stdout.split("\n").find((value) => value.startsWith('{"mode":'));
      expect(line).toBeDefined();
      const report = JSON.parse(line!);
      expect(report.timedOut).toBe(false);
      expect(report.result.compileSuccess).toBe(true);
      expect(report.result.validates).toBe(true);
      expect(report.result.moduleImports).toEqual([]);
      expect(report.result.success).toBe(false);
      expect(report.result.invocations).toHaveLength(1);
      expect(report.result.invocations[0]).toMatchObject({
        phase: phase === "startup" ? "instantiate" : "invoke:run",
        matches: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  70000,
);
