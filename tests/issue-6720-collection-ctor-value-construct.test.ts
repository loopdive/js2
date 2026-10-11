// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6720 — `new <Map|Set|WeakMap carrier held in a VALUE>(…)` under
// `--target standalone` answered null.
//
// #6711 (PR #6208) seeds `globalThis.Map` / `.Set` / `.WeakMap` / … in the
// zero-import lane (a runtime-eval module with no provider linked), so
// lodash's `Function('return this')()` realm idiom now SEES them. lodash-es's
// feature detection (`_createSet.js`: `Set && 1 / setToArray(new Set([,-0]))[1]
// == INFINITY`) then constructs through the imported default-expression
// snapshot `Set` — which the host-free lane refused and evaluated to null — and
// module init died in `_setToArray.js` at `Array(set.size)`:
// `TypeError: Cannot access property on null or undefined at 10:22`.
//
// Row 1 pins the culprit's own shape (the realm-object ctor read through the
// no-provider `Function('return this')()` idiom). Row 2 pins lodash-es's module
// graph verbatim in miniature: a default-exported `var Set = getNative(root,
// 'Set')` constructed from another module during module init.
//
// Each row compares against Node running the same source.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const STANDALONE = {
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "standalone",
  runtimeEvalProvider: false,
  deferTopLevelInit: true,
} as const;

function instantiate(binary: Uint8Array): Record<string, unknown> {
  const module = new WebAssembly.Module(binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = new WebAssembly.Instance(module, {}).exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return exports;
}

// The culprit's shape: realm constructors read off `Function('return this')()`.
const REALM_CTOR_VALUES = `
var root = Function('return this')();
var S = root.Set;
var M = root.Map;
var WM = root.WeakMap;
function mk(C) { return new C(); }
function probe(f, want) { try { return f() === want ? 1 : 2; } catch (e) { return 9; } }
export function run() {
  var r = 0;
  r = r * 10 + probe(function () { return new S([1, -0, 1, 0]).size; }, 2);
  r = r * 10 + probe(function () { var m = new M([["k", 3]]); return m.get("k") + m.size; }, 4);
  r = r * 10 + probe(function () { var m = mk(M); m.set(1, 2); return m.size; }, 1);
  r = r * 10 + probe(function () { var w = new WM(); var k = {}; w.set(k, 5); return w.get(k); }, 5);
  r = r * 10 + probe(function () { return new S().size; }, 0);
  return r;
}
`;

describe("#6720 — constructing a Map/Set carrier VALUE (standalone)", () => {
  it("constructs realm constructors read through the no-provider realm idiom", async () => {
    const expected = (
      new Function(REALM_CTOR_VALUES.replace("export function run", "return function run")) as () => () => number
    )()();
    expect(expected).toBe(11_111);
    const result = await compile(REALM_CTOR_VALUES, { ...STANDALONE, fileName: "realm-ctors.js" } as Parameters<
      typeof compile
    >[1]);
    expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
    expect((instantiate(result.binary!).run as () => number)()).toBe(expected);
  });

  it("initializes lodash-es's default-exported Set snapshot graph", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-6720-"));
    roots.push(root);
    const files: Record<string, string> = {
      "_root.js": "var root = Function('return this')();\nexport default root;\n",
      "_getNative.js":
        "function getNative(object, key) { var value = object == null ? undefined : object[key]; return value; }\nexport default getNative;\n",
      "_Set.js":
        "import getNative from './_getNative.js';\nimport root from './_root.js';\nvar Set = getNative(root, 'Set');\nexport default Set;\n",
      "_setToArray.js":
        "function setToArray(set) {\n  var index = -1,\n      result = Array(set.size);\n\n  set.forEach(function(value) {\n    result[++index] = value;\n  });\n  return result;\n}\nexport default setToArray;\n",
      "_createSet.js":
        "import Set from './_Set.js';\nimport setToArray from './_setToArray.js';\nvar INFINITY = 1 / 0;\nvar createSet = !(Set && (1 / setToArray(new Set([,-0]))[1]) == INFINITY) ? 1 : 2;\nexport default createSet;\n",
      "entry.js": "import createSet from './_createSet.js';\nexport function run() { return createSet; }\n",
      "package.json": '{ "type": "module" }\n',
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    const expected = ((await import(pathToFileURL(join(root, "entry.js")).href)) as { run: () => number }).run();
    expect(expected).toBe(2);
    const result = await compileProject(join(root, "entry.js"), STANDALONE as Parameters<typeof compileProject>[1]);
    expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
    expect((instantiate(result.binary!).run as () => number)()).toBe(expected);
  });
});
