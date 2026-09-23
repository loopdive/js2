// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6479 — the `cjs-rewrite` and `timer-shim` prepasses each parsed every source
// of a multi-file graph. Both now gate the parse behind a textual pre-filter.
// A false negative would silently skip a rewrite, so these tests assert the
// pre-filtered output is byte-identical to the unfiltered one (`prefilter:
// false` forces the original AST path) for every rewrite shape plus a corpus of
// real compiler sources.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { rewriteCjsRequire, rewriteCjsRequireWithMap } from "../src/cjs-rewrite.js";
import { injectTimerShimOnly } from "../src/import-resolver.js";

function bothAgree(source: string): void {
  expect(rewriteCjsRequire(source)).toBe(rewriteCjsRequire(source, { prefilter: false }));
  expect(injectTimerShimOnly(source)).toBe(injectTimerShimOnly(source, { prefilter: false }));
}

/** Every CommonJS shape `rewriteCjsRequireWithMap`'s visitor can act on. */
const CJS_POSITIVES: Record<string, string> = {
  "default import": `const fs = require("fs");\nfs.readFileSync("x");\n`,
  "named destructuring": `const { join, resolve: r } = require("path");\njoin(r("a"), "b");\n`,
  "member access": `const join = require("path").join;\njoin("a");\n`,
  "factory call": `const app = require("express")();\napp.listen(1);\n`,
  "grouped declarators": `const a = require("a"), b = require("b");\na;\nb;\n`,
  "let binding": `let lodash = require("lodash");\nlodash.map([], (x) => x);\n`,
  "var binding": `var util = require("util");\nutil.format("%s", 1);\n`,
  "reassigned let stays cjs": `let x = require("a");\nx = 1;\n`,
  "whitespace before paren": `const fs = require ("fs");\nfs;\n`,
  "module.exports assignment": `function f() {\n  return 1;\n}\nmodule.exports = f;\n`,
  "module.exports = require": `module.exports = require("./inner.js");\n`,
  "module.exports spaced": `const v = 1;\nmodule . exports = v;\n`,
  "exports member": `exports.a = 1;\nexports.b = 2;\n`,
  "exports member spaced": `exports\n  .a = 1;\nexports.b = 2;\n`,
  "umd wrapper": `(function () {\n  module.exports = { v: 1 };\n})();\n`,
  "empty destructuring": `const {} = require("side-effect");\n`,
  "rest pattern bails out": `const { ...rest } = require("a");\nrest;\n`,
  "token inside a string only": `const s = "require(\\"x\\") and module.exports";\ns;\n`,
  "token inside a comment only": `// require("x") / module.exports / exports.y\nexport const k = 1;\n`,
};

/** Every timer shape `injectTimerShimOnly` can act on, plus near misses. */
const TIMER_POSITIVES: Record<string, string> = {
  setTimeout: `setTimeout(() => {}, 1);\n`,
  setInterval: `setInterval(() => {}, 1);\n`,
  clearTimeout: `const h = setTimeout(() => {}, 1);\nclearTimeout(h);\n`,
  clearInterval: `const h = setInterval(() => {}, 1);\nclearInterval(h);\n`,
  queueMicrotask: `queueMicrotask(() => {});\n`,
  "member form globalThis": `globalThis.setTimeout(() => {}, 1);\n`,
  "member form window": `window.setTimeout(() => {}, 1);\n`,
  "user-defined shadow": `function setTimeout(cb: () => void, ms: number): number {\n  return ms;\n}\nsetTimeout(() => {}, 1);\n`,
  "imported binding": `import { setTimeout } from "node:timers";\nsetTimeout(() => {}, 1);\n`,
  "value reference only": `const f = setTimeout;\nf(() => {}, 1);\n`,
  "setImmediate is not shimmed": `setImmediate(() => {});\n`,
  "token inside a string only": `const s = "setTimeout and queueMicrotask";\ns;\n`,
  "token inside a comment only": `// setInterval / clearTimeout\nexport const k = 1;\n`,
  "near miss identifier": `const mySetTimeoutX = 1;\nconst setTimeoutish = 2;\n`,
};

describe("#6479 prepass textual pre-filter", () => {
  describe("cjs-rewrite shapes", () => {
    for (const [name, source] of Object.entries(CJS_POSITIVES)) {
      it(`is byte-identical with and without the pre-filter: ${name}`, () => {
        const filtered = rewriteCjsRequireWithMap(source);
        const unfiltered = rewriteCjsRequireWithMap(source, { prefilter: false });
        expect(filtered.source).toBe(unfiltered.source);
        bothAgree(source);
      });
    }

    it("still rewrites the canonical require() form", () => {
      expect(rewriteCjsRequire(`const fs = require("fs");\nfs;\n`)).toContain('import fs from "node:fs"');
    });

    it("leaves a source with no CommonJS surface untouched", () => {
      const source = `export const value = 1;\nexport function f(): number {\n  return value;\n}\n`;
      expect(rewriteCjsRequire(source)).toBe(source);
    });
  });

  describe("timer-shim shapes", () => {
    for (const [name, source] of Object.entries(TIMER_POSITIVES)) {
      it(`is byte-identical with and without the pre-filter: ${name}`, () => {
        expect(injectTimerShimOnly(source)).toBe(injectTimerShimOnly(source, { prefilter: false }));
        bothAgree(source);
      });
    }

    it("still injects the shim for a bare setTimeout call", () => {
      expect(injectTimerShimOnly(`setTimeout(() => {}, 1);\n`)).toContain("__timer_set_timeout");
    });

    it("leaves a source with no timer token untouched", () => {
      const source = `export const value = 1;\n`;
      expect(injectTimerShimOnly(source)).toBe(source);
    });
  });

  describe("real compiler sources", () => {
    const corpus: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) corpus.push(p);
      }
    };
    walk("src");
    // A deterministic spread across the tree rather than the first N files of
    // one directory: ~24 files, mixing pre-filter hits and misses.
    const sampled = corpus.filter((_, i) => i % Math.ceil(corpus.length / 24) === 0);

    it("samples a non-trivial corpus", () => {
      expect(sampled.length).toBeGreaterThanOrEqual(20);
    });

    for (const file of sampled) {
      it(`is byte-identical with and without the pre-filter: ${file}`, () => {
        const source = readFileSync(file, "utf8");
        const filtered = rewriteCjsRequireWithMap(source);
        const unfiltered = rewriteCjsRequireWithMap(source, { prefilter: false });
        expect(filtered.source).toBe(unfiltered.source);
        expect(injectTimerShimOnly(source)).toBe(injectTimerShimOnly(source, { prefilter: false }));
      });
    }
  });
});
