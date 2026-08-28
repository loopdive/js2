// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5104 — standalone Boolean.prototype must retain its @@toStringTag metadata.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const TEST262_ROOT = join(__dirname, "..", "test262");
// CI's changed-root jobs may intentionally omit the optional Test262 checkout.
// Keep the exact corpus rows conditional while leaving compiler controls below
// mandatory. The environment switch makes that packaging mode reproducible
// locally without moving or deleting a checkout.
const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" && existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;
const EXACT_ROWS = ["built-ins/Boolean/prototype/S15.6.3.1_A1.js", "built-ins/Boolean/S15.6.2.1_A4.js"] as const;

async function runExactRow(relativePath: (typeof EXACT_ROWS)[number], lane: Lane) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-5104",
      120_000,
      lane === "standalone" ? lane : undefined,
    );
  } finally {
    restoreHostBuiltins();
  }
}

async function run(body: string, lane: Lane): Promise<number> {
  const result = await compile(`export function test(): number {\n${body}\n}`, {
    fileName: "issue-5104-boolean-prototype-tostringtag.ts",
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(
    result.success,
    `compile failed (${lane}):\n${result.errors.map((error) => `  L${error.line}: ${error.message}`).join("\n")}`,
  ).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  try {
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setInstance?.(instance);
    return (instance.exports as { test(): number }).test();
  } finally {
    // Keep each compiler-control execution isolated from the caller's realm.
    restoreHostBuiltins();
  }
}

const DESCRIPTOR = `
  const descriptor: any = Object.getOwnPropertyDescriptor(Boolean.prototype, Symbol.toStringTag);
  if (descriptor === undefined) return 1;
  return descriptor.value === "Boolean" &&
    descriptor.writable === false &&
    descriptor.enumerable === false &&
    descriptor.configurable === true ? 2 : 0;
`;

const ORDINARY_OBJECT_CONTROL = `
  return Object.prototype.toString.call({}) === "[object Object]" ? 1 : 0;
`;

describe("#5104 Boolean.prototype @@toStringTag", () => {
  for (const relativePath of EXACT_ROWS) {
    itWithTest262(
      `${relativePath}: preserves the Boolean tag after deleting its own toString in both lanes`,
      { timeout: 180_000 },
      async () => {
        for (const lane of ["host", "standalone"] as const) {
          const result = await runExactRow(relativePath, lane);
          expect(`${result.status}: ${result.error ?? ""}`, `${relativePath} (${lane})`).toBe("pass: ");
        }
      },
    );
  }

  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: exposes the exact non-writable tag descriptor`, async () => {
      // Node's host realm does not expose this own tag, while standalone must
      // materialize the standard descriptor in its native-prototype glue.
      await expect(run(DESCRIPTOR, lane)).resolves.toBe(lane === "host" ? 1 : 2);
    });

    it(`${lane}: leaves ordinary Object.prototype tags unchanged`, async () => {
      await expect(run(ORDINARY_OBJECT_CONTROL, lane)).resolves.toBe(1);
    });
  }
});
