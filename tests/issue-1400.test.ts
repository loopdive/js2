// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1400 — ESLint Tier 1: compileProject must emit valid Wasm for class
// constructors that assign a chained, computed member expression to a `this`
// property. The bug surfaced when compiling `eslint/lib/config/config.js`:
// `Config_new` failed validation with
//
//   extern.convert_any[0] expected type anyref,
//     found extern.convert_any of type externref @+...
//
// because the multi-module pipeline (`compileProject` →
// `generateMultiModule`) never ran the `fixupExternConvertAny` late pass.
// `stackBalance`'s `fixCallArgTypesInBody` walks backward from a host call
// (`__extern_set(externref, externref, externref)`) and inserts coercion ops
// per-argument; when the inserted coercion is `extern.convert_any` and the
// walker re-traverses through pass-through producers (`extern.convert_any`
// itself has delta = 0), it queues the same insertion for multiple args.
// The result is 2–4 consecutive `extern.convert_any` ops, and the second one
// fails validation because externref is NOT a subtype of anyref.
//
// The single-module pipeline (`generateModule`) already invoked
// `fixupExternConvertAny` after `stackBalance` (index.ts:1053) to scrub these
// duplicates. The multi-module pipeline was missing the same call. This test
// pins the fix so the pass stays wired in for `compileProject`.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_DIR = resolve(__dirname, "../.tmp/issue-1400");

function writeEntry(name: string, src: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const p = join(TMP_DIR, name);
  writeFileSync(p, src);
  return p;
}

describe("#1400 ESLint Tier 1 — Config_new duplicate extern.convert_any", () => {
  /**
   * Minimal reproducer distilled from `eslint/lib/config/config.js:380`. The
   * exact shape that previously triggered the bug:
   *
   *   class C {
   *     constructor(c) {
   *       const x = "key";
   *       this.r = c.a[x];      // ← computed member access on a member access,
   *                             //   assigned to a `this` property
   *     }
   *   }
   *
   * Pre-fix: `compileProject` returned `success: true` but the binary failed
   * `WebAssembly.validate` with a duplicate-extern.convert_any error inside
   * the synthesized `C_new` constructor. Post-fix: the late
   * `fixupExternConvertAny` pass scrubs the duplicates and the binary
   * validates.
   */
  it("emits valid Wasm for `this.r = c.a[x]` in a class constructor", async () => {
    const entry = writeEntry(
      "ctor-chained-elem-access.js",
      `class C {
  constructor(c) {
    const x = "key";
    this.r = c.a[x];
  }
}
module.exports = { C };
`,
    );
    const r = await compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  /**
   * Broader shape, closer to ESLint's `Config` constructor — destructuring
   * with a rest pattern, `Object.assign(this, ...)`, multiple chained
   * computed member accesses, all in one constructor. This stresses the
   * `fixCallArgTypesInBody` walker through several `__extern_set` /
   * `__extern_get` call sites in sequence.
   */
  it("emits valid Wasm for Config-shaped constructor with destructuring + chained accesses", async () => {
    const entry = writeEntry(
      "config-shaped-ctor.js",
      `function splitPluginIdentifier(id) {
  return { pluginName: "a", objectName: "b" };
}
class Config {
  constructor(config) {
    const { plugins, language, languageOptions, processor, ...otherKeys } = config;
    Object.assign(this, otherKeys);
    if (!language) {
      throw new TypeError("Key 'language' is required.");
    }
    this.plugins = plugins;
    this.language = language;
    const { pluginName: languagePluginName, objectName: localLanguageName } = splitPluginIdentifier(language);
    if (!plugins || !plugins[languagePluginName] || !plugins[languagePluginName].languages || !plugins[languagePluginName].languages[localLanguageName]) {
      throw new TypeError("Key language not found");
    }
    this.language = plugins[languagePluginName].languages[localLanguageName];
  }
}
module.exports = { Config };
`,
    );
    const r = await compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  /**
   * Verify that the late `fixupExternConvertAny` pass is invoked by the
   * multi-module pipeline by checking it scrubs known-redundant sequences.
   * We compile a tiny program whose `__extern_set` call path used to emit
   * `extern.convert_any; extern.convert_any` and assert that no two
   * consecutive `extern.convert_any` opcodes appear in any function body
   * (the GC opcodes `fb 1b fb 1b` are the binary signature of the bug).
   */
  it("never emits consecutive extern.convert_any opcodes in the produced binary", async () => {
    const entry = writeEntry(
      "no-consec-extern.js",
      `class C {
  constructor(c) {
    const x = "key";
    const y = "k2";
    this.r = c.a[x];
    this.s = c.b[y];
  }
}
module.exports = { C };
`,
    );
    const r = await compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    // Scan the binary for `fb 1b fb 1b` (two consecutive GC-prefix
    // extern.convert_any opcodes).
    let bug = false;
    for (let i = 0; i < r.binary.length - 3; i++) {
      if (r.binary[i] === 0xfb && r.binary[i + 1] === 0x1b && r.binary[i + 2] === 0xfb && r.binary[i + 3] === 0x1b) {
        bug = true;
        break;
      }
    }
    expect(bug).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
