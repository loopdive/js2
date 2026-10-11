// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";

describe("nonempty runtime support replays without source compiler loads", () => {
  it.each(["replay", "probe"] as const)(
    "fresh process: %s",
    (mode) => {
      const source = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
      const program = requireProgram(
        prepareWholeIrProgram({
          ...sourceInput({ "./entry.ts": source }),
          policy: {
            backend: "wasmgc",
            target: "standalone",
            stringConst: { storage: "native" },
            stringConcat: { concat: "native" },
          },
          promiseDelayProjection: "standalone-native",
          asyncFamilyProjection: "standalone-native",
        }),
      );
      expect(program.runtimeSupport?.batches).toHaveLength(1);
      const directory = mkdtempSync(join(tmpdir(), "js2-runtime-support-replay-"));
      const packet = join(directory, "program.json"),
        census = join(directory, "loads.jsonl");
      writeFileSync(packet, encodePreparedIrProgram(program));
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "tests/helpers/runtime-support-source-free.mjs", packet, census, mode],
        {
          cwd: resolve(import.meta.dirname, ".."),
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.signal, child.stderr).toBeNull();
      const report = JSON.parse(child.stdout.trim());
      expect(report.decoded, JSON.stringify(report)).toBe(true);
      expect(report.batches).toBe(1);
      expect(report.calls).toBeGreaterThan(0);
      expect(report.literals).toBeGreaterThan(0);
      const rows = readFileSync(census, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((row) => row.url.includes("/src/ir/program-validation."))).toBe(true);
      if (mode === "replay") {
        expect(child.status, JSON.stringify(report)).toBe(0);
        expect(report.ok).toBe(true);
        expect(rows.filter((row) => row.denied)).toEqual([]);
      } else {
        expect(child.status).toBe(1);
        expect(report.ok).toBe(false);
        expect(report.error).toMatch(/forbidden runtime-support replay load/);
        expect(rows.some((row) => row.denied && row.url.includes("/src/ir/from-ast."))).toBe(true);
      }
      // Preserve the exact packet and load census for failure attribution.
    },
    90000,
  );
});
