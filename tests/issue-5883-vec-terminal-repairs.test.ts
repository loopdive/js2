// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { getFixupEvents } from "../src/codegen/stack-balance.js";

it("does not invent fallthrough results for Get or its inlined Pop use", async () => {
  const fileName = fileURLToPath(new URL("../website/playground/examples/benchmarks.ts", import.meta.url));
  const source = readFileSync(fileName, "utf8");
  const result = await compile(source, { fileName });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const events = getFixupEvents();
  // Positive telemetry control: unrelated existing repairs remain visible.
  expect(events.some((event) => event.func === "__vec_len" && event.kind === "default-value-lossy")).toBe(true);
  expect(
    events.filter(
      (event) => (event.func === "__vec_get" || event.func === "__vec_pop") && event.kind === "default-value-lossy",
    ),
  ).toEqual([]);
}, 30000);
