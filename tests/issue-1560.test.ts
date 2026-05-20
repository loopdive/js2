// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1560 — CJS module.exports = { ClassName } named class re-exports link
// to the compiled class, not the extern fallback.
//
// FINDING (2026-05-20): the reduced repro using RELATIVE-PATH imports
// (`import { Foo } from "./pkg/middle"`) ALREADY WORKS on current
// `main`. Both rungs below pass. This narrows #1560 significantly:
// the CJS re-export plumbing IS functional for local-file graphs.
//
// The remaining bug surface is bare-package + package.json resolution:
//   `import { Linter } from "eslint"` resolves to the `.d.ts` (not the
//   compiled class) and the consumer sees `env.__new_Linter` because
//   the resolver never picked the implementation graph.
//
// That makes #1560's actionable surface **downstream of #1559**: once
// #1559 redirects bare-package imports to the impl entry, this test's
// pattern should naturally extend to the bare-package case. If after
// #1559 lands the ESLint case still degrades to extern, #1560 has a
// real residual bug; otherwise #1560 can close as "covered by #1559".
//
// This file remains in the suite as a positive regression guard:
// the local-file CJS class re-export pattern must continue to work.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { compileProject } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = resolve(__dirname, "../.tmp/issue-1560");
const PKG_DIR = join(FIXTURE_DIR, "pkg");

function setupFixture() {
  mkdirSync(PKG_DIR, { recursive: true });

  // Leaf: defines the real class.
  writeFileSync(
    join(PKG_DIR, "leaf.js"),
    `
class Foo {
  constructor() { this.v = 42; }
  hello() { return this.v; }
}
module.exports = { Foo };
`,
  );

  // Middle: pulls the named binding and re-exports it under the same name.
  // This is the hop where the binding is currently losing its class identity.
  writeFileSync(
    join(PKG_DIR, "middle.js"),
    `
const { Foo } = require("./leaf");
module.exports = { Foo };
`,
  );

  // Entry: imports through the middle. Mirrors the consumer side
  // `import { Linter } from "eslint"` -> resolved via api.js -> linter/index.js.
  writeFileSync(
    join(FIXTURE_DIR, "entry.ts"),
    `
import { Foo } from "./pkg/middle";
export function test(): number {
  const f = new Foo();
  return f.hello();
}
`,
  );

  return join(FIXTURE_DIR, "entry.ts");
}

describe("#1560 — CJS named class re-export links to compiled class", () => {
  let entryPath: string;

  beforeAll(() => {
    entryPath = setupFixture();
  });

  afterAll(() => {
    try {
      rmSync(FIXTURE_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /**
   * Rung 1 — compile succeeds and the import manifest does NOT register
   * an extern constructor for `Foo`. If `__new_Foo` is present in the
   * imports, the re-export chain has degraded to extern fallback.
   *
   * Expected to FAIL on current `main`: today the bare-impl wiring at
   * the `module.exports = { Foo }` hop loses the class identity and
   * the codegen emits a host import.
   */
  it("compiles without __new_Foo extern in import manifest", () => {
    const r = compileProject(entryPath, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;

    const importEntries = Object.keys(r.imports as Record<string, unknown>);
    const externNew = importEntries.filter((k) => /__new_Foo$/.test(k));
    expect(externNew).toEqual([]);
  });

  /**
   * Rung 2 — end-to-end: `new Foo().hello()` returns 42. Requires
   * Rung 1 to be green, plus the instantiation path needs to find
   * the compiled `Foo` struct + method dispatch. If Rung 1 already
   * passes, this is the integration gate.
   */
  it("instantiates and `new Foo().hello()` returns 42", async () => {
    const r = compileProject(entryPath, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;

    const imps = buildImports(r.imports as never, undefined, r.stringPool);
    const inst = await WebAssembly.instantiate(r.binary, imps as never);
    const exports = inst.instance.exports as { test?: () => number };
    expect(typeof exports.test).toBe("function");
    expect(exports.test!()).toBe(42);
  });
});
