// #6877 — react.development.js (everything inside one IIFE) and
// react.production.js (the same names at module scope) in one project graph.
// `ctx.funcMap` / `ctx.nestedFuncCaptures` / `ctx.moduleGlobals` are keyed by
// BARE name across the whole compile, so the production module's top-level
// `cloneAndReplaceKey` used to compile into the development IIFE's nested slot
// and inherit its capture plan (`references out-of-range local(s) 43, 62`), and
// a `var` inside the inlined IIFE initialized the production module's global.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

type Lane = "default" | "native-first" | "standalone";
type Order = "dev-first" | "prod-first";

function project(devSource: string, prodSource: string, order: Order): string {
  const dir = mkdtempSync(join(tmpdir(), "issue-6877-"));
  writeFileSync(join(dir, "dev.js"), devSource);
  writeFileSync(join(dir, "prod.js"), prodSource);
  const imports = [`import dev from "./dev.js";`, `import prod from "./prod.js";`];
  if (order === "prod-first") imports.reverse();
  writeFileSync(
    join(dir, "main.js"),
    `${imports.join("\n")}\nexport function va() { return dev.va(); }\nexport function vb() { return prod.vb(); }\n`,
  );
  return join(dir, "main.js");
}

async function run(entry: string, lane: Lane): Promise<{ va: unknown; vb: unknown }> {
  const result = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : { platform: "node" as const }),
    ...(lane === "native-first" ? { semanticProviders: "native-first" as const } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, () => unknown>;
    exports.__module_init?.();
    return { va: exports.va!(), vb: exports.vb!() };
  }
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  const exports = wrapCompiledExports(result, instance) as Record<string, () => unknown>;
  return { va: exports.va!(), vb: exports.vb!() };
}

const LANES: Lane[] = ["default", "native-first", "standalone"];
const ORDERS: Order[] = ["dev-first", "prod-first"];

// The twelve-line reduction from the issue file. `prod.js` uses a single
// `module.exports =` so the two modules do not also share the CJS prelude's
// `exports` binding (that collision is #6705, a separate bug).
const capturesDev = `(function () {
  ${Array.from({ length: 60 }, (_, i) => `var x${i} = ${i};`).join(" ")}
  function helper(v) { return v + x40 + x59; }
  function cloneAndReplaceKey(oldElement, newKey) { newKey = helper(oldElement.v); return newKey + x50; }
  exports.va = function () { return cloneAndReplaceKey({ v: 1 }, 0); };
})();
`;
const capturesProd = `function helper(v) { return v; }
function cloneAndReplaceKey(oldElement, newKey) { newKey = helper(oldElement.v); return newKey; }
module.exports = { vb: function () { return cloneAndReplaceKey({ v: 1 }, 0); } };
`;

// The next react failure: `var assign = Object.assign` inside the development
// IIFE stored into the production module's `assign` global once the module
// initializer is chunked (forty filler statements force the chunking).
const varDev = `(function () {
  var assign = function (t) { t.x = 7; return t; };
  var o = assign({ x: 0 });
  exports.va = function () { return o.x; };
})();
`;
const varProd = `var assign = 5;
${Array.from({ length: 40 }, (_, i) => `var f${i} = ${i};`).join("\n")}
module.exports = { vb: function () { return assign + f39; } };
`;

describe("#6877 cross-module bare-name tables", () => {
  it("an IIFE var shadows a same-named module var in a chunked single-module init (default gc)", async () => {
    const source = `var assign = 1;
${Array.from({ length: 30 }, (_, i) => `var g${i} = ${i};`).join("\n")}
var out = (function () { var assign = 7; function inner() { return assign + g29; } return inner(); })();
export function run() { return out + assign; }
`;
    const dir = mkdtempSync(join(tmpdir(), "issue-6877-single-"));
    writeFileSync(join(dir, "main.js"), source);
    const result = await compileProject(join(dir, "main.js"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      platform: "node",
    });
    expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    const exports = wrapCompiledExports(result, instance) as Record<string, () => unknown>;
    expect(exports.run!()).toBe(37);
  });

  for (const lane of LANES) {
    for (const order of ORDERS) {
      it(`nested capture plans stay with their own module (${lane}, ${order})`, async () => {
        expect(await run(project(capturesDev, capturesProd, order), lane)).toEqual({ va: 150, vb: 1 });
      });
      it(`an inlined IIFE var does not initialize another module's global (${lane}, ${order})`, async () => {
        expect(await run(project(varDev, varProd, order), lane)).toEqual({ va: 7, vb: 44 });
      });
    }
  }
});
