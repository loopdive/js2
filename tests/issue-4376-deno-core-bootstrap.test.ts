// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("#4376 — unchanged deno_core bootstrap graph", () => {
  // The exact graph needs more than Vitest's deliberately small 512 MiB fork
  // heap. Compile it in a bounded child so an infrastructure OOM cannot be
  // mistaken for a compiler verdict and the parent releases all compiler state.
  it("boots primordials, infra, and core in one isolated Wasm program", () => {
    const probe = fileURLToPath(new URL("./helpers/deno-core-bootstrap-probe.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--max-old-space-size=2048", "--experimental-wasm-exnref", "--import", "tsx", probe],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout) as {
      bytes: number;
      calls: string[];
      hashes: Record<string, string>;
      imports: string[];
      probes: number[];
    };
    expect(report.hashes).toEqual({
      "00_infra.js": "33984000be930f3b02a2d1149ac0319724e8d95891623c8cc74699da4ce97287",
      "00_primordials.js": "5a2dfbdc4bb81412575d035901a11788001c7e0110e3f736d16289891af44a52",
      "01_core.js": "6e67972322cc5385a2b642a4f7e941fccb6f992c9de662a5111d11fd0aaf1a3a",
    });
    expect(report.bytes).toBeGreaterThan(2_000_000);
    expect(report.imports).toEqual([
      "env::Promise_all",
      "env::Promise_allSettled",
      "env::Promise_any",
      "env::Promise_new",
      "env::Promise_race",
      "js2wasm:runtime-eval::__runtime_apply_interpreted",
      "js2wasm:runtime-eval::__runtime_indirect_eval",
    ]);
    expect(report.probes).toEqual([42, 42]);
    expect(report.calls).toEqual([]);
  }, 30_000);
});
