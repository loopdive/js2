// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4675 — native Symbol ids returned by an ordinary Object.prototype
 * receiver-coercion method must cross the dynamic closure ABI as Symbol
 * carriers, not as boxed numbers.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const ORDINARY_SYMBOL_KEY_FILES = [
  "built-ins/Object/prototype/hasOwnProperty/symbol_property_toString.js",
  "built-ins/Object/prototype/hasOwnProperty/symbol_property_valueOf.js",
  "built-ins/Object/prototype/propertyIsEnumerable/symbol_property_toString.js",
  "built-ins/Object/prototype/propertyIsEnumerable/symbol_property_valueOf.js",
] as const;

const SYMBOL_KEY_CONTROLS = [
  "built-ins/Object/prototype/hasOwnProperty/symbol_own_property.js",
  "built-ins/Object/prototype/propertyIsEnumerable/symbol_own_property.js",
] as const;

describe("#4675 — standalone Object.prototype Symbol ToPropertyKey coercion", () => {
  it.each(ORDINARY_SYMBOL_KEY_FILES)("passes the exact ES2015 row %s", async (file) => {
    const result = await runTest262File(join("test262/test", file), "built-ins/Object/prototype", 30_000, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(SYMBOL_KEY_CONTROLS)("keeps the direct Symbol-key control %s passing", async (file) => {
    const result = await runTest262File(join("test262/test", file), "built-ins/Object/prototype", 30_000, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
