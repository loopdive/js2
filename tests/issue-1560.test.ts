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
// FINDING (2026-05-21, post-#1559 smoke): with the #1559 resolver fix
// applied (PR #457 — bare-package imports prefer the `.js` impl over
// `.d.ts`), compiling `import { Linter } from "eslint"` produces a
// binary whose `r.imports` contains NO `__new_Linter` extern. The
// `module.exports = { Linter }` re-export chain in ESLint's
// `lib/api.js → lib/linter/index.js → lib/linter/linter.js` survives
// intact once the resolver picks the impl graph. This issue is
// therefore RESOLVED by #1559 — no separate code change required.
//
// This file remains in the suite as a positive regression guard:
//   - Rungs 1 + 2: two-hop class re-export (the original reduced repro).
//   - Rung 3: three-hop class re-export — mirrors ESLint's depth
//     (`api.js → linter/index.js → linter/linter.js`) without
//     depending on bare-package resolution. Pins that the local-file
//     CJS class re-export plumbing handles arbitrary chain depth.
// If any future change regresses the class-binding propagation through
// `module.exports = { Class }` hops, these tests catch it directly.

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
  it("compiles without __new_Foo extern in import manifest", async () => {
    const r = await compileProject(entryPath, { allowJs: true });
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
    const r = await compileProject(entryPath, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;

    const imps = buildImports(r.imports as never, undefined, r.stringPool);
    const inst = await WebAssembly.instantiate(r.binary, imps as never);
    const exports = inst.instance.exports as { test?: () => number };
    expect(typeof exports.test).toBe("function");
    expect(exports.test!()).toBe(42);
  });

  /**
   * Rung 3 — three-hop re-export chain
   * (`leaf.js` → `mid1.js` → `mid2.js` → `entry.ts`). Mirrors
   * ESLint's chain depth (`lib/api.js` → `lib/linter/index.js` →
   * `lib/linter/linter.js`) without going through bare-package
   * resolution. The class identity must survive every
   * `const { Foo } = require(...)` ; `module.exports = { Foo }`
   * round-trip, end-to-end. This pin guards against a regression
   * where multi-hop re-export accidentally drops the class binding.
   */
  it("three-hop class re-export — `new Foo().hello()` returns 42", async () => {
    const dir = resolve(__dirname, "../.tmp/issue-1560-3hop");
    const pkg = join(dir, "pkg");
    mkdirSync(pkg, { recursive: true });

    writeFileSync(
      join(pkg, "leaf.js"),
      `
class Foo {
  constructor() { this.v = 42; }
  hello() { return this.v; }
}
module.exports = { Foo };
`,
    );
    writeFileSync(
      join(pkg, "mid1.js"),
      `
const { Foo } = require("./leaf");
module.exports = { Foo };
`,
    );
    writeFileSync(
      join(pkg, "mid2.js"),
      `
const { Foo } = require("./mid1");
module.exports = { Foo };
`,
    );
    const entry3 = join(dir, "entry.ts");
    writeFileSync(
      entry3,
      `
import { Foo } from "./pkg/mid2";
export function test(): number {
  const f = new Foo();
  return f.hello();
}
`,
    );

    try {
      const r = await compileProject(entry3, { allowJs: true });
      expect(r.success).toBe(true);
      if (!r.success) return;

      const importEntries = Object.keys(r.imports as Record<string, unknown>);
      const externNew = importEntries.filter((k) => /__new_Foo$/.test(k));
      expect(externNew).toEqual([]);

      const imps = buildImports(r.imports as never, undefined, r.stringPool);
      const inst = await WebAssembly.instantiate(r.binary, imps as never);
      const exports = inst.instance.exports as { test?: () => number };
      expect(typeof exports.test).toBe("function");
      expect(exports.test!()).toBe(42);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
