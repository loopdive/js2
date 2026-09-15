// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Separate file/process from poisoned independent candidate execution.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compileSourceSync } from "../src/compiler.js";
import { buildCompiledImports } from "../src/runtime.js";

it("diagnoses the exact pinned legacy main-call failure, not async conformance", async () => {
  const source = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
  const hash = createHash("sha256").update(source).digest("hex");
  expect(hash).toBe("6bc4fc96cc65881c9919a39b840afaf1001dfd3d0e05ef0cc141441a051f7915");
  const result = compileSourceSync(source, {
    fileName: "website/playground/examples/js/async.ts",
    target: "standalone",
    experimentalIR: false,
    emitWat: true,
    trackFallbacks: true,
    trackIrOutcomes: true,
  });
  console.log(
    "SPIKE_LEGACY",
    JSON.stringify({
      hash,
      success: result.success,
      errors: result.errors,
      bytes: result.binary?.length,
      outcomes: result.irOutcomes,
    }),
  );
  expect(result.success, "The pinned reference must reach actual execution, not pass on a new compile failure").toBe(
    true,
  );
  if (!result.success) throw new Error(JSON.stringify(result.errors));
  expect(WebAssembly.validate(result.binary)).toBe(true);
  console.log(
    "SPIKE_LEGACY_IMPORTS",
    JSON.stringify(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))),
  );
  const jobs: { delay: number | undefined; fire: () => void }[] = [];
  const events: { kind: "register" | "fire"; ordinal: number; delay?: number }[] = [];
  const setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const ordinal = jobs.length;
    events.push({ kind: "register", ordinal, delay });
    jobs.push({
      delay,
      fire: () => {
        events.push({ kind: "fire", ordinal });
        callback(...args);
      },
    });
    return ordinal + 1;
  }) as unknown as typeof globalThis.setTimeout;
  const imports = buildCompiledImports(result, { setTimeout });
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const exports = instance.exports;
  console.log(
    "SPIKE_LEGACY_EXPORTS",
    JSON.stringify(WebAssembly.Module.exports(new WebAssembly.Module(result.binary))),
  );
  function callable(name: string): (...args: any[]) => any {
    const value = exports[name];
    expect(value, `missing actual legacy export ${name}`).toBeTypeOf("function");
    return value as (...args: any[]) => any;
  }
  const main = callable("main");
  callable("__promise_boundary_state");
  callable("__promise_boundary_value");
  const prepare = exports.__stdout_prepare as (() => number) | undefined;
  const char = exports.__stdout_char as ((index: number) => number) | undefined;
  callable("__dynamic_boundary_tag");
  const stdoutAvailable = typeof prepare === "function" && typeof char === "function";
  console.log(
    "SPIKE_LEGACY_STDOUT_CAPABILITY",
    JSON.stringify({
      available: stdoutAvailable,
      limitation: stdoutAvailable
        ? null
        : "Unchanged compile options do not export stdout readers; output is unobserved, not empty or verified.",
    }),
  );
  function stdout(): string | null {
    if (typeof prepare !== "function" || typeof char !== "function") return null;
    const length = prepare();
    let output = "";
    for (let index = 0; index < length; index++) output += String.fromCharCode(char(index));
    return output;
  }
  // The original throwing driver and its failed-run log are retained in
  // plan/agent-context. This test is an exact negative diagnostic, not a repair.
  let observedError: unknown;
  let returned = false;
  try {
    main();
    returned = true;
  } catch (error) {
    observedError = error;
  }
  console.log(
    "SPIKE_LEGACY_TRAP",
    JSON.stringify({
      phase: "main-call",
      events,
      delays: jobs.map((job) => job.delay),
      promiseReturned: returned,
      finalPromiseState: "unavailable",
      finalPromiseValue: "unavailable",
      stdoutAvailable,
      output: stdout(),
      error:
        observedError instanceof Error
          ? { name: observedError.name, message: observedError.message, stack: observedError.stack }
          : String(observedError),
    }),
  );
  expect(returned, "Successful execution needs a new real comparison, not this negative diagnostic").toBe(false);
  expect(observedError).toBeInstanceOf(WebAssembly.RuntimeError);
  expect(observedError).toMatchObject({ name: "RuntimeError", message: "dereferencing a null pointer" });
  expect((observedError as Error).stack).toContain("__async_resume_fmain");
  expect(events).toEqual(Array.from({ length: 10 }, (_, ordinal) => ({ kind: "register", ordinal, delay: 30 })));
  expect(jobs.map((job) => job.delay)).toEqual(Array(10).fill(30));
  expect(stdoutAvailable).toBe(false);
  expect(stdout()).toBeNull(); // Missing observation, not empty output.
});
