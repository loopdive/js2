// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2689 — ESLint `eslint/lib/languages/js/source-code/source-code.js` failed
// `WebAssembly.validate` with
//
//   function "SourceCode_new" failed: return_call: tail call type error
//
// Root cause: the iterator-protocol host imports (`__iterator`,
// `__iterator_next`, …) are registered LAZILY on the first `for-of` compiled
// (`compileForOfStatement` → `addIteratorImports`). That can happen AFTER a
// derived class's `${C}_new` constructor already baked `return_call ${C}_init`
// (the #1965 alloc + tail-call-init split). `addIteratorImports` (and its
// siblings `addArrayIteratorImports` / `addGeneratorImports` / `addForInImports`)
// added their imports via raw `addImport`, which bumps `numImportFuncs` WITHOUT
// shifting already-baked defined-function indices. So every funcIdx registered
// before that point silently desynced: `SourceCode_init` slid 9 slots up while
// `SourceCode_new`'s `return_call` stayed put, ending up pointed at the
// `__iterator_next` IMPORT → the tail-call type error. The same desync also
// broke later `call` sites ("not enough arguments on the stack for call").
//
// Fix: route those four lazy import-adders through `ensureLateImport` + an
// immediate `flushLateImportShifts`. The flushed batch shift repairs the
// already-baked funcIdx in the LATE context and is a clean no-op in the EARLY
// (collect-finalize) context — crucially WITHOUT leaving a deferred shift that
// would later over-shift functions registered after the imports.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";
import { ESLINT_DEV_DEPENDENCY_SKIP, requireEslintFile, resolveEslintFile } from "./helpers/eslint.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_DIR = resolve(__dirname, "../.tmp/issue-2689");
const ESLINT_SOURCE_CODE = resolveEslintFile("lib/languages/js/source-code/source-code.js");

function write(name: string, src: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const p = join(TMP_DIR, name);
  writeFileSync(p, src);
  return p;
}

describe("#2689 — lazy iterator/for-in/generator imports must not desync funcIdx", () => {
  it("derived class `_new` return_call survives a lazily-imported for-of (multi-module)", async () => {
    // base.js is a separate CJS module (mirrors eslint's TokenStore), so the
    // multi-module pipeline registers `Derived_new`/`Derived_init` BEFORE the
    // first for-of body is compiled — the precise ordering that desynced the
    // baked `return_call`.
    write(
      "base.js",
      `"use strict";
class Base {
  constructor(tokens, comments) { this.tokens = tokens; this.comments = comments; }
}
module.exports = Base;
`,
    );
    const entry = write(
      "main.js",
      `"use strict";
const Base = require("./base");
class Derived extends Base {
  constructor(textOrConfig, ast) {
    let text;
    if (typeof textOrConfig === "string") { text = textOrConfig; }
    else { text = textOrConfig.text; ast = textOrConfig.ast; }
    super(ast.tokens, ast.comments);
    this.text = text;
    Object.freeze(this);
  }
  countItems(items) {
    let n = 0;
    for (const x of items) { n += 1; }
    return n;
  }
}
module.exports = { Derived };
`,
    );
    const r = await compileProject(entry, { allowJs: true });
    expect(r.success, r.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!r.success) return;
    // Pre-fix: `Base_new` / `Derived_new` failed with "return_call: tail call
    // type error" because the lazy iterator import shifted indices out from
    // under the baked tail call.
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("derived class + for-of with destructuring over Object.entries (array-iterator + for-in path)", async () => {
    write(
      "base2.js",
      `"use strict";
class Base { constructor(a) { this.a = a; } }
module.exports = Base;
`,
    );
    const entry = write(
      "main2.js",
      `"use strict";
const Base = require("./base2");
class Derived extends Base {
  constructor(a, b) { super(a); this.b = b; Object.freeze(this); }
  applyOpts(opts) {
    const out = [];
    for (const [k, v] of Object.entries(opts || {})) { out.push(k); }
    for (const key in (opts || {})) { out.push(key); }
    return out;
  }
}
module.exports = { Derived };
`,
    );
    const r = await compileProject(entry, { allowJs: true });
    expect(r.success, r.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it.skipIf(ESLINT_SOURCE_CODE === null)(
    `the real eslint source-code.js validates ${ESLINT_DEV_DEPENDENCY_SKIP}`,
    async () => {
      const entry = requireEslintFile(ESLINT_SOURCE_CODE, "lib/languages/js/source-code/source-code.js");
      const r = await compileProject(entry, { allowJs: true });
      expect(r.success, r.errors.map((error) => error.message).join("\n")).toBe(true);
      if (!r.success) return;
      expect(WebAssembly.validate(r.binary)).toBe(true);
    },
  );
});
