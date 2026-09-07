// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const forbidden =
  /(?:\/typescript\/|\/ts-api\.|\/checker\/|\/codegen\/expressions(?:\/|\.)|\/codegen\/statements(?:\/|\.)|\/shared\.|\/async-cps\.|\/async-frame\.|\/async-scheduler\.|\/ir-async-runtime-adapters\.|\/native-promise-number-boundary\.)/;

function census(modules: string[]) {
  const script = `
    import {registerHooks} from 'node:module';
    const loaded=new Set();
    registerHooks({load(url,context,next){const result=next(url,context);loaded.add(url);return result;}});
    let failure;
    try {for(const url of ${JSON.stringify(modules)}) await import(url);} catch(error){failure=String(error);}
    console.log('FRAME_CENSUS:'+JSON.stringify({loaded:[...loaded],failure}));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`census process failed: ${result.error ?? result.stderr}`);
  const marker = result.stdout.split("\n").find((line) => line.startsWith("FRAME_CENSUS:"));
  if (!marker) throw new Error("census instrumentation emitted no record");
  const row = JSON.parse(marker.slice("FRAME_CENSUS:".length)) as { loaded: string[]; failure?: string };
  if (!row.loaded.length) throw new Error("census instrumentation emitted no modules");
  return row;
}

function assertBoundary(row: ReturnType<typeof census>) {
  const violations = row.loaded.filter((url) => forbidden.test(url));
  if (violations.length) throw new Error(`forbidden runtime modules: ${violations.join(",")}`);
  if (row.failure) throw new Error(`module load failed: ${row.failure}`);
}

describe("prepared frame loaded-module boundary", () => {
  it("loads the actual physical engine without AST/checker/direct dispatch", () => {
    const row = census(["./src/codegen/prepared-async-frame-engine.ts"]);
    expect(row.loaded.some((url) => url.endsWith("/prepared-async-frame-engine.ts"))).toBe(true);
    expect(row.loaded.some((url) => url.endsWith("/prepared-native-async-await.ts"))).toBe(true);
    expect(() => assertBoundary(row)).not.toThrow();
  });
  it("loads the actual IR adapter with a nonempty engine dependency census", () => {
    const row = census(["./src/codegen/prepared-async-frame-adapter.ts"]);
    expect(row.loaded.some((url) => url.endsWith("/prepared-async-frame-adapter.ts"))).toBe(true);
    expect(row.loaded.some((url) => url.endsWith("/prepared-async-frame-engine.ts"))).toBe(true);
    expect(() => assertBoundary(row)).not.toThrow();
  });
  it("detects restoring the legacy engine import in an isolated process", () => {
    const row = census(["./src/codegen/prepared-async-frame-engine.ts", "./src/codegen/async-frame.ts"]);
    expect(() => assertBoundary(row)).toThrow("forbidden runtime modules");
  });
  it("detects a forbidden import injected through a temporary module", () => {
    const imported = new URL("../src/ts-api.ts", import.meta.url).href;
    const fixture = `data:text/javascript,${encodeURIComponent(`import ${JSON.stringify(imported)};`)}`;
    expect(() => assertBoundary(census([fixture]))).toThrow("forbidden runtime modules");
  });
  it("does not call an unavailable module a successful empty census", () => {
    expect(() => assertBoundary(census(["./src/codegen/prepared-frame-missing-control.ts"]))).toThrow();
  });
  it.each(["ir-async-runtime-adapters", "ir-async-frame"])("keeps the unconnected %s dependency visible", (module) => {
    expect(() => assertBoundary(census([`./src/codegen/${module}.ts`]))).toThrow("forbidden runtime modules");
  });
});
