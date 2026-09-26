// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6663 — a top-level `if (process.env.NODE_ENV === ...) module.exports =
// require(...)` build selector (react's package entry) was never linked under
// `--target standalone`: neither `require` entered the compileProject graph, so
// module init called an unbound `require` and threw
// `ReferenceError: require is not defined` (npm-compat: "uncaught Wasm-GC
// exception (non-stringifiable payload)"). Standalone `process.env` is always
// empty, so the resolver now folds that `if` to the arm the program takes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject } from "../src/index.ts";
import { foldStandaloneProcessEnvBranches } from "../src/cjs-standalone-env-fold.ts";

let dir = "";

const MAIN = `import lib from "./LIB";
export function probe() {
  return lib.kind;
}
`;

const SELECTORS: Record<string, { source: string; expected: number }> = {
  ifElse: {
    source:
      "'use strict';\nif (process.env.NODE_ENV === 'production') {\n  module.exports = require('./a.js');\n} else {\n  module.exports = require('./b.js');\n}\n",
    expected: 2,
  },
  reversedNegated: {
    source:
      "'use strict';\nif ('production' !== process.env.NODE_ENV) {\n  module.exports = require('./c.js');\n} else {\n  module.exports = require('./a.js');\n}\n",
    expected: 3,
  },
  elseIfChain: {
    source:
      "'use strict';\nif (process.env.NODE_ENV === 'production') module.exports = require('./a.js');\nelse if (process.env['NODE_ENV'] === 'test') module.exports = require('./c.js');\nelse module.exports = require('./b.js');\n",
    expected: 2,
  },
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "issue-6663-"));
  writeFileSync(join(dir, "a.js"), "'use strict';\nexports.kind = 1;\n");
  writeFileSync(join(dir, "b.js"), "'use strict';\nexports.kind = 2;\n");
  writeFileSync(join(dir, "c.js"), "'use strict';\nmodule.exports = { kind: 3 };\n");
  for (const [name, { source }] of Object.entries(SELECTORS)) {
    writeFileSync(join(dir, `${name}.js`), source);
    writeFileSync(join(dir, `${name}.mjs`), MAIN.replace("./LIB", `./${name}.js`));
  }
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function runStandalone(entry: string, define?: Record<string, string>): Promise<unknown> {
  const result = await compileProject(join(dir, entry), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    target: "standalone",
    ...(define ? { define } : {}),
  });
  expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return exports.probe!();
}

describe("#6663 standalone NODE_ENV build selector links its require", () => {
  for (const [name, { expected }] of Object.entries(SELECTORS)) {
    it(`${name}: module init links the arm standalone takes (kind ${expected})`, async () => {
      expect(await runStandalone(`${name}.mjs`)).toBe(expected);
    });
  }

  it("an explicit define selects the other arm", async () => {
    expect(await runStandalone("ifElse.mjs", { "process.env.NODE_ENV": '"production"' })).toBe(1);
  });
});

describe("#6663 foldStandaloneProcessEnvBranches", () => {
  const selector = SELECTORS.ifElse!.source;

  it("keeps every position: same length, same newlines, only the taken arm left", () => {
    const folded = foldStandaloneProcessEnvBranches(selector);
    expect(folded).not.toBe(selector);
    expect(folded.length).toBe(selector.length);
    expect(folded.split("\n").length).toBe(selector.split("\n").length);
    expect(folded.replace(/\s+/g, " ").trim()).toBe("'use strict'; module.exports = require('./b.js');");
  });

  it("leaves sources it cannot prove untouched", () => {
    const unchanged = [
      // the module binds its own `process`
      "var process = { env: { NODE_ENV: 'production' } };\n" + selector,
      // the dropped arm declares a `var` that outlives it
      "if (process.env.NODE_ENV === 'production') { var x = 1; } else { module.exports = 2; }\n",
      // the condition reads something other than process.env
      "if (process.env.NODE_ENV === 'production' && typeof window === 'object') { a(); } else { b(); }\n",
      // not a top-level statement: runs whenever `f` is called
      "function f() { if (process.env.NODE_ENV === 'production') { a(); } else { b(); } }\n",
      // a non-literal define value is not a proof
      // (checked below with the define map)
    ];
    for (const source of unchanged) expect(foldStandaloneProcessEnvBranches(source)).toBe(source);
    expect(foldStandaloneProcessEnvBranches(selector, { "process.env.NODE_ENV": "someIdentifier" })).toBe(selector);
  });

  it("keeps the braces of a kept block that declares a lexical binding", () => {
    const source = "if (process.env.NODE_ENV !== 'production') { const k = 1; module.exports = k; }\n";
    const folded = foldStandaloneProcessEnvBranches(source);
    expect(folded.replace(/\s+/g, " ").trim()).toBe("{ const k = 1; module.exports = k; }");
  });
});
