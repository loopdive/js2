// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1557 — `__obj_meth_tramp_*` arity mismatch under `compileProject`.
//
// The bug surfaces when a project compiles a module containing multiple inline
// object literals whose method-typed field (e.g. `validate`) resolves to
// `externref` (so `propType.getCallSignatures()` returns 0 signatures). When
// that happens, `ensureStructForType`'s `methodSigParts` is empty for that
// field, so the structural hash collapses literals like
//
//   { merge: ..., validate(value) { ... } }
//   { merge: ..., validate()      { ... } }
//
// into the same `__anon_N` struct. Both literals' `validate` methods then
// share the same `funcMap` entry `__anon_N_validate`, and the second body
// compiled rewrites the first's `typeIdx` (literals.ts ≈ line 1334:
// `methodFunc.typeIdx = methodTypeIdx`).
//
// The trampolines emitted for the FIRST literal's `validate(value)` reference
// funcIdx N with a 2-param signature; after the second literal's body
// compilation, the function's final signature is 1-param. Wasm validation
// rejects:
//
//   __obj_meth_tramp___anon_0_validate_<N>:
//     not enough arguments on the stack for call (need 2, got 1) @+<offset>
//
// The fix in `compileObjectLiteralForStruct` does a pre-pass over `expr.properties`
// to detect signature mismatches against the shared `funcMap` entry and routes
// the conflicting literal's method body + trampoline through a per-literal
// `funcIdx`, so both literals stay self-consistent.
//
// This test was uncovered via `node_modules/eslint/lib/config/config.js`
// (Tier 1d), which transitively imports `flat-config-schema.js` — that module
// declares many `{ validate(value) {...} }` and one `{ validate() {...} }`
// (line 545, `createEslintrcErrorSchema`) inline schema literals.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";
import { ESLINT_DEV_DEPENDENCY_SKIP, requireEslintFile, resolveEslintFile } from "./helpers/eslint.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_DIR = resolve(__dirname, "../.tmp/issue-1557");
const ESLINT_CONFIG = resolveEslintFile("lib/config/config.js");

function writeFile(name: string, src: string): string {
  mkdirSync(dirname(join(TMP_DIR, name)), { recursive: true });
  const p = join(TMP_DIR, name);
  writeFileSync(p, src);
  return p;
}

describe("#1557 — `__obj_meth_tramp_*` arity mismatch under compileProject", () => {
  /**
   * Minimal multi-file synthetic repro distilled from
   * `eslint/lib/config/flat-config-schema.js`. The TS Checker resolves
   * `validate: any` to externref with no call signatures, so the structural
   * hash collapses these three literals into the same `__anon_N` struct.
   * Their methods share `funcMap.__anon_N_validate`, and pre-fix the
   * trampolines emitted for the arity-1 literals expected a 2-param call
   * but the final func sig (after the arity-0 literal's body was compiled)
   * was 1-param. Without the fix, `WebAssembly.validate` returns false with
   * "not enough arguments on the stack for call (need 2, got 1)".
   */
  it("emits valid Wasm for multiple object literals with same-shape methods of different arity", async () => {
    writeFile(
      "schema.ts",
      `export type PropSchema = {
  merge: any;
  validate: any;
};

export function makeSeveritySchema(): PropSchema {
  return {
    merge: "replace",
    validate(value: any) {
      if (typeof value !== "string") throw new TypeError("Expected string");
    },
  };
}

export function makeErrorSchema(): PropSchema {
  return {
    merge: "replace",
    validate() {
      throw new TypeError("Not allowed");
    },
  };
}

export function makeArgValidator(): PropSchema {
  return {
    merge: "replace",
    validate(value: any) {
      if (value === null) throw new TypeError("Null not allowed");
    },
  };
}
`,
    );
    const entry = writeFile(
      "main.ts",
      `import { makeSeveritySchema, makeErrorSchema, makeArgValidator } from "./schema.js";

const s1 = makeSeveritySchema();
const s2 = makeErrorSchema();
const s3 = makeArgValidator();

s1.validate("hi");
s2.validate(null as any);
s3.validate(42);
`,
    );

    const r = await compileProject(entry, { allowJs: true });
    expect(r.success, r.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  /**
   * Smoke-test the real-world reproducer that uncovered the bug.
   * `node_modules/eslint/lib/config/config.js` transitively imports
   * `flat-config-schema.js`, which contains the multi-arity-validate
   * object-literal pattern. Pre-fix this binary failed
   * `WebAssembly.validate`; post-fix it validates. Skipped if the eslint
   * package is not installed locally (e.g. clean CI checkout that doesn't
   * pull npm devDependencies).
   */
  it.skipIf(ESLINT_CONFIG === null)(
    `emits valid Wasm for compileProject(node_modules/eslint/lib/config/config.js) ${ESLINT_DEV_DEPENDENCY_SKIP}`,
    async () => {
      const eslintConfig = requireEslintFile(ESLINT_CONFIG, "lib/config/config.js");
      const r = await compileProject(eslintConfig, { allowJs: true });
      expect(r.success, r.errors.map((error) => error.message).join("\n")).toBe(true);
      if (!r.success) return;
      expect(WebAssembly.validate(r.binary)).toBe(true);
    },
  );
});
