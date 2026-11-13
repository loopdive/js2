// (#2944) Externref-typed ESCAPE discipline for hash-consumer-poisoned `$Object`
// vars (host mode).
//
// The #2584/#2849 poison (`objectHashConsumerVars`) keeps a `{}` var with BOTH
// dynamic-key writes (`o[k]=`, for-in copy) AND static-named access on the
// dynamic `$Object` representation. But the var-name poison was honored only at
// the WIDENING decision, while representation actually flows from the
// ts.Type-keyed machinery: the function-signature pre-pass calls
// `ensureStructForType` on the INFERRED RETURN TYPE of a function that returns
// the poisoned var — the SAME ts.Type instance the var carries — registering it
// as an (empty) anon struct. The local then typed `(ref null $__anon_N)`, the
// `{}` host `$Object` externref failed the decl-init cast, and the var was NULL
// from the first instruction: every for-in write silently no-opped on null, the
// null escaped through `return` into the `this.options` field, and the method
// read null-dereferenced. That was #2937 — compiled-acorn threw on EVERY
// host-mode input (the `Parser` constructor runs `getOptions` before parsing
// anything), which forced a temporary revert of the host poison.
//
// #2944 keys the poison by ts.Type identity too (`ctx.objectHashConsumerTypes`)
// and consults it at the three type-resolution chokepoints
// (`ensureStructForType` — skip registration; `resolveWasmType` → externref;
// `resolveStructName` → undefined → dynamic host path), so the "stays a
// `$Object`" decision follows the value through every slot it escapes into:
// returns, params, fields, aliases, elements.
//
// The repro below is the acorn `Parser`/`getOptions` shape with NO type
// annotations — that is load-bearing: the #2937 reduced shapes (E1/E2/E3) all
// carried `: any` annotations, which already lowered every slot to externref
// and masked the escape. Acorn is unannotated JS; its inferred object types are
// what the ts.Type-keyed registrars re-bind.
//
// Standalone: the same escape exists there but is a PRE-EXISTING, separate gap
// (unchanged by #2944 — standalone codegen is byte-identical, verified via
// sha256 in the issue). The standalone arm asserts purity (no host-import leak)
// only.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ESCAPE_SRC = `// @ts-nocheck
var defaults = { ecmaVersion: 5, sourceType: "script" };
function getOptions(opts) {
  var options = {};
  for (var opt in defaults) {
    options[opt] = opts && opt in opts ? opts[opt] : defaults[opt];
  }
  if (options.ecmaVersion === "latest") { options.ecmaVersion = 1e8; }
  else if (options.ecmaVersion == null) { options.ecmaVersion = 11; }
  else if (options.ecmaVersion >= 2015) { options.ecmaVersion -= 2009; }
  return options;
}
class Parser {
  constructor(opts) {
    this.options = getOptions(opts);
  }
  read() { return this.options.ecmaVersion; }
}
export function test(ev) {
  var p = new Parser({ ecmaVersion: ev, sourceType: "module" });
  return p.read();
}
`;

// Alias escape: the poisoned value flows through a second binding before the
// read — the alias's slot must lower to externref too (it shares the ts.Type).
const ALIAS_SRC = `// @ts-nocheck
var defaults = { ecmaVersion: 5 };
export function run(ev) {
  var o = {};
  var src = { ecmaVersion: ev };
  for (var k in defaults) { o[k] = src[k]; }
  if (o.ecmaVersion >= 2015) { o.ecmaVersion -= 2009; }
  var alias = o;
  return alias.ecmaVersion;
}
`;

async function runHost(source: string, arg: number, fn: string): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn](arg);
}

describe("#2944 poisoned $Object escape discipline (host)", () => {
  it("host: poisoned var escapes via return + class field, read normalises 2022 → 13", async () => {
    expect(await runHost(ESCAPE_SRC, 2022, "test")).toBe(13);
  });

  it("host: default arm survives the escape (5 stays 5)", async () => {
    expect(await runHost(ESCAPE_SRC, 5, "test")).toBe(5);
  });

  it("host: poisoned var read through an alias binding", async () => {
    expect(await runHost(ALIAS_SRC, 2022, "run")).toBe(13);
  });

  it("standalone: escape shape compiles pure (no host-import leak)", async () => {
    const r = await compile(ESCAPE_SRC, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // Instantiates with EMPTY imports — a leaked host import fails here. The
    // standalone RUNTIME still has the pre-existing (separate) escape gap, so
    // we do not call test() — #2944 leaves standalone bytes untouched.
    await WebAssembly.instantiate(r.binary, {});
  });
});
