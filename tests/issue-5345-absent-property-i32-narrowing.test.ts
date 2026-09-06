// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #5345 (Cluster A) — a dynamic member read must not be narrowed to `i32`.
 *
 * `finalizeStructAndDynamicMemberGet`'s Phase-3 vote collapses a dynamically
 * typed read to a scalar when every struct that carries the property name
 * agrees on one field kind. That is a bet that the receiver will BE one of
 * those structs. The dispatcher terminal exists because it may not be — a host
 * plain object (`{...options}` lowers to `__new_plain_object`), a sidecar prop,
 * an expando — and the terminal legitimately answers `undefined`.
 *
 * Narrowing to `i32` then coerces that `undefined` back down through
 * `__unbox_number` + `i32.trunc_sat_f64_s`: NaN saturates to `0`, which is
 * bit-identical to `false`. `f64` at least has a NaN/sentinel encoding for
 * "absent"; i32 has no spare value at all, so for a boolean-valued property the
 * two-value domain is fully consumed and the read lies unconditionally.
 *
 * Measured on marked@18.0.2. Its parse guard is
 *
 *     if (this.defaults.async === true && origOpt.async === false) throw …
 *
 * with `origOpt = {...options}` and `options` undefined. Exactly one struct in
 * the module carries `async` (the defaults literal, `{async:false, …}`), so the
 * lone-`i32` vote fired and the absent read answered a real `false` —
 * "marked(): The async option was set to true by an extension" on 11 of the 30
 * tests in `test/unit/Hooks.test.js`.
 *
 * The fixtures are untyped `.js` behind a two-file project on purpose: the
 * defect lives in the DYNAMIC read path. Annotating the objects (`interface
 * Opts { async?: boolean }`) routes the reads through the typed `struct.get`
 * arm instead, which has its OWN, separate absent-boolean defect — an absent
 * optional boolean reads `false` there where an absent optional *string*
 * correctly reads `undefined` — so a typed fixture is red on both sides of this
 * change and isolates nothing. That one is recorded in the issue and not fixed
 * here.
 *
 * ANTI-VACUITY: a property that is really `false` must still compare `=== false`,
 * a real `true` must still compare `=== true`, and an absent property must stay
 * falsy. Those three cases pass on the parent commit too and fail if the read is
 * widened into answering `undefined` for everything.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * Every check is written INLINE rather than through a shared `describe(v)`
 * helper. Routing the answer through a helper parameter re-narrows it in the
 * callee's param slot, which masks the defect: the fixture then reports
 * `"false"` even with the fix applied. (`typeof` is unusable for the same
 * class of reason — it is const-folded from the believed static type and
 * answered `"boolean"` for an absent property on the parent commit.)
 */
const SPREAD_MODULE = `
// The only struct in the module that carries 'async' — this is what the
// Phase-3 vote reads, and why an unrelated receiver was narrowed to its i32.
function makeDefaults() {
  return { async: false, silent: false, gfm: true };
}

// The '=== false' test comes FIRST on purpose. On the parent commit BOTH
// 'origOpt.async === false' and 'origOpt.async === undefined' answered true for
// the same read — the two comparisons take different lowerings, only the
// scalar one is wrong — so a fixture that asks about undefined first reports a
// clean "undefined" and hides the defect entirely. marked asks '=== false'
// first, which is why it saw it.
export function absentOnSpreadOfUndefined() {
  const origOpt = { ...undefined };
  if (origOpt.async === false) return "false";
  if (origOpt.async === true) return "true";
  if (origOpt.async === undefined) return "undefined";
  return "value";
}

export function absentOnSpreadOfPartial() {
  const options = { silent: true };
  const origOpt = { ...options };
  if (origOpt.async === false) return "false";
  if (origOpt.async === true) return "true";
  if (origOpt.async === undefined) return "undefined";
  return "value";
}

export function realFalseSurvives() {
  const options = { async: false, silent: true };
  const origOpt = { ...options };
  if (origOpt.async === false) return "false";
  if (origOpt.async === undefined) return "undefined";
  return "value";
}

export function realTrueSurvives() {
  const options = { async: true, silent: true };
  const origOpt = { ...options };
  if (origOpt.async === true) return "true";
  if (origOpt.async === undefined) return "undefined";
  return "value";
}

export function defaultsStillReadable() {
  const defaults = makeDefaults();
  if (defaults.async === false) return "false";
  if (defaults.async === undefined) return "undefined";
  return "value";
}

export function absentStaysFalsy() {
  const origOpt = { ...undefined };
  return origOpt.async ? "truthy" : "falsy";
}
`;

/**
 * marked's guard, in the spelling its published `lib/marked.esm.js` bundle
 * uses: a defaults factory of boolean literals, `s.async = a || b || false`,
 * spread-merged defaults, and a parse closure whose options object is
 * `{...maybeUndefined}`.
 */
const MARKED_GUARD_MODULE = `
function makeDefaults() {
  return { async: false, breaks: false, gfm: true, silent: false };
}

class Marked {
  constructor() {
    this.defaults = makeDefaults();
    this.parse = this.parseMarkdown(true);
  }

  use(...packs) {
    packs.forEach((pack) => {
      const s = { ...pack };
      s.async = this.defaults.async || s.async || false;
      this.defaults = { ...this.defaults, ...s };
    });
    return this;
  }

  parseMarkdown(block) {
    return (src, options) => {
      const r = { ...options };
      const merged = { ...this.defaults, ...r };
      if (this.defaults.async === true && r.async === false) {
        return "THROW";
      }
      return "ok:" + String(merged.async);
    };
  }
}

export function asyncExtensionNoParseOptions() {
  const m = new Marked();
  m.use({ async: true });
  return m.parse("text");
}

export function asyncExtensionExplicitFalse() {
  const m = new Marked();
  m.use({ async: true });
  return m.parse("text", { async: false });
}

export function noAsyncExtension() {
  const m = new Marked();
  m.use({});
  return m.parse("text");
}
`;

function entryFor(names: readonly string[]): string {
  const imports = `import { ${[...names].sort().join(", ")} } from "./mod.js";`;
  const wrappers = names.map((name) => `export function via_${name}(): string { return ${name}(); }`);
  return `${imports}\n${wrappers.join("\n")}\n`;
}

async function instantiate(moduleSource: string, names: readonly string[]): Promise<WebAssembly.Exports> {
  const root = mkdtempSync(join(tmpdir(), "js2-5345-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), moduleSource);
  writeFileSync(join(root, "entry.ts"), entryFor(names));
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

const SPREAD_NAMES = [
  "absentOnSpreadOfUndefined",
  "absentOnSpreadOfPartial",
  "realFalseSurvives",
  "realTrueSurvives",
  "defaultsStillReadable",
  "absentStaysFalsy",
] as const;

const MARKED_NAMES = ["asyncExtensionNoParseOptions", "asyncExtensionExplicitFalse", "noAsyncExtension"] as const;

const call = (exports: WebAssembly.Exports, name: string): string => (exports[`via_${name}`] as () => string)();

describe("#5345 an absent property must not read as `false`", () => {
  it("answers undefined for a property no spread source carried", async () => {
    // Parent commit: both answer "false".
    const exports = await instantiate(SPREAD_MODULE, SPREAD_NAMES);
    expect(call(exports, "absentOnSpreadOfUndefined")).toBe("undefined");
    expect(call(exports, "absentOnSpreadOfPartial")).toBe("undefined");
  });

  it("still answers a real false and a real true (anti-vacuity)", async () => {
    const exports = await instantiate(SPREAD_MODULE, SPREAD_NAMES);
    expect(call(exports, "realFalseSurvives")).toBe("false");
    expect(call(exports, "realTrueSurvives")).toBe("true");
    expect(call(exports, "defaultsStillReadable")).toBe("false");
  });

  it("keeps an absent property falsy", async () => {
    const exports = await instantiate(SPREAD_MODULE, SPREAD_NAMES);
    expect(call(exports, "absentStaysFalsy")).toBe("falsy");
  });

  it("does not fire marked's async-extension guard when parse got no options", async () => {
    // Parent commit: "THROW" — this is the 11-test cluster in Hooks.test.js.
    const exports = await instantiate(MARKED_GUARD_MODULE, MARKED_NAMES);
    expect(call(exports, "asyncExtensionNoParseOptions")).toBe("ok:true");
  });

  it("still fires that guard when parse really was given async:false", async () => {
    const exports = await instantiate(MARKED_GUARD_MODULE, MARKED_NAMES);
    expect(call(exports, "asyncExtensionExplicitFalse")).toBe("THROW");
    expect(call(exports, "noAsyncExtension")).toBe("ok:false");
  });
});

/**
 * Issue #5345 (Cluster B) — NOT FIXED HERE. Pinned so the follow-up has a
 * failing anchor, in the same idiom #5327 used for its binding-slot residual.
 *
 * A computed-key read of a class PROTOTYPE method answers `undefined`. The
 * object-literal control passes, because a literal's methods are struct FIELDS
 * (so `__sget_<name>` reaches them) while a class's live on the prototype and
 * have no host-visible carrier at all — measured: with a genuine runtime key,
 * `Hooks.prototype[k]` and `Object.getPrototypeOf(h)[k]` are `undefined` too,
 * so the prototype `$Object` does not physically carry the methods in the JS-host
 * lane. Only a class with a runtime-keyed member gets its prototype force-
 * initialized (#5195 Step 1.5/1.7, standalone-only); widening that to every
 * class is #5195 Step 4.3 and needs a host-lane twin.
 *
 * This is what blocks the rest of marked's Hooks suite: `use()` installs hooks
 * with `const prev = hooks[prop]; hooks[prop] = … prev.call(hooks, …)`, so
 * `prev` is null and the wrapped hook returns nothing.
 *
 * Flip the two `toBe("undefined")` expectations to `toBe("function")` when
 * Cluster B lands.
 */
const PROTOTYPE_METHOD_MODULE = `
class Hooks {
  preprocess(markdown) { return markdown; }
  provideLexer(block = this.block) { return block; }
}

// Keys come from a string array, not a sibling object literal: an object whose
// field is NAMED after the method would itself become a struct carrier for that
// name and the read would resolve against IT, not the class.
export function classMethodByRuntimeKey() {
  const h = new Hooks();
  const names = ["preprocess"];
  let out = "";
  for (const prop of names) {
    const v = h[prop];
    out += v === null ? "null" : v === undefined ? "undefined" : "function";
  }
  return out;
}

export function defaultParamMethodByRuntimeKey() {
  const h = new Hooks();
  const names = ["provideLexer"];
  let out = "";
  for (const prop of names) {
    const v = h[prop];
    out += v === null ? "null" : v === undefined ? "undefined" : "function";
  }
  return out;
}

export function objectLiteralMethodByRuntimeKey() {
  const o = { preprocess(md) { return md; } };
  const names = ["preprocess"];
  let out = "";
  for (const prop of names) {
    const v = o[prop];
    out += v === null ? "null" : v === undefined ? "undefined" : "function";
  }
  return out;
}
`;

const PROTO_NAMES = [
  "classMethodByRuntimeKey",
  "defaultParamMethodByRuntimeKey",
  "objectLiteralMethodByRuntimeKey",
] as const;

describe("#5345 Cluster B — computed-key read of a class prototype method (known limitation)", () => {
  it("reads undefined for a prototype method, with or without a default parameter", async () => {
    const exports = await instantiate(PROTOTYPE_METHOD_MODULE, PROTO_NAMES);
    // Both spellings are broken identically — the issue's "only the two hooks
    // with a default parameter" framing does not hold; `preprocess` has none.
    expect(call(exports, "classMethodByRuntimeKey")).toBe("undefined");
    expect(call(exports, "defaultParamMethodByRuntimeKey")).toBe("undefined");
  });

  it("reads the same method correctly off a plain object literal (control)", async () => {
    const exports = await instantiate(PROTOTYPE_METHOD_MODULE, PROTO_NAMES);
    expect(call(exports, "objectLiteralMethodByRuntimeKey")).toBe("function");
  });
});
