// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #5358 — a RUNTIME-key read of a compiled class instance's prototype
 * method must answer a callable, not `undefined`.
 *
 * `h[k]` lowers to the host `__extern_get(h, k)`. The host resolver already
 * resolves prototype methods through the compiled `__member_kind_<key>` /
 * `__class_call_<key>_<n>` bridges — and the callable it hands back honours an
 * explicit `this` (#5237), which is the unbound-method shape marked's
 * `a.call(r, c)` needs. Those bridges were published only for keys some NAMED
 * dynamic call or write registered; a runtime key has no name to register, so
 * a class whose methods are never dynamically called by name published nothing
 * and every such read answered `undefined`. The read sites now register the
 * demand (`src/codegen/runtime-key-class-methods.ts`), and the host `in`
 * operator answers through the same discriminator so `k in h` and `h[k]` agree.
 *
 * The fixtures are untyped `.js` behind a two-file project on purpose: a
 * `: any` annotation on the receiver routes the read through a different arm.
 * Keys come from string arrays, never from a sibling object literal — an object
 * whose FIELD is named after the method would itself carry that name as a
 * struct field and the read would resolve against it, not the class.
 *
 * ANTI-VACUITY: the object-literal control (a literal's methods are struct
 * fields) passes on the parent commit too; the receiver-honouring and `in`
 * guards fail if the read hands back a pre-bound closure or the `in` twin is
 * dropped.
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

const MODULE = `
class Hooks {
  options;
  block;
  preprocess(markdown) { return "pre:" + markdown; }
  provideLexer(block = this.block) { return block ? "lex" : "lexInline"; }
  get kind() { return "hooks:" + (this.block ? "b" : "i"); }
}

class SubHooks extends Hooks {
  postprocess(html) { return "post:" + html; }
}

// No member of Hooks is ever CALLED BY NAME through a dynamic receiver in this
// module: such a call registers the name on its own and would publish the
// bridge the runtime-key read is supposed to demand (marked's own module has
// one, which is why its use() read works even without this fix).
function anyRead(x, k) { return x[k]; }
function anyHas(x, k) { return k in x; }

function describeValue(v) {
  return v === null ? "null" : v === undefined ? "undefined" : typeof v;
}

// A method WITHOUT a default parameter and one WITH — the filed diagnosis
// blamed the default parameter; both spellings were broken identically.
export function methodByRuntimeKey() {
  const h = new Hooks();
  const names = ["preprocess", "provideLexer", "missing"];
  const out = [];
  for (const k of names) out.push(k + "=" + describeValue(h[k]));
  return out.join(",");
}

export function getterByRuntimeKey() {
  const h = new Hooks();
  const other = new Hooks();
  other.block = true;
  const names = ["kind"];
  let out = "";
  for (const k of names) out += String(h[k]) + "|" + String(other[k]);
  return out;
}

export function inheritedThroughSubclass() {
  const s = new SubHooks();
  const names = ["preprocess", "postprocess", "provideLexer"];
  const out = [];
  for (const k of names) out.push(k + "=" + describeValue(s[k]));
  for (const k of ["postprocess"]) out.push(String(s[k].call(s, "x")));
  return out.join(",");
}

// marked's use(): wrap each hook with the previous one, read under the for-in
// key, then call the installed wrapper read back under a runtime key.
export function forInWrapAndCall() {
  const r = new Hooks();
  const pack = { preprocess(md) { return md.toUpperCase(); } };
  for (const o in pack) {
    const u = pack[o];
    const a = r[o];
    r[o] = (c) => {
      const p = u.call(r, c);
      return a.call(r, p);
    };
  }
  const wrapped = anyRead(r, "preprocess");
  return String(wrapped("abc"));
}

export function defaultParameterThroughCall() {
  const h = new Hooks();
  h.block = true;
  const names = ["provideLexer"];
  let out = "";
  for (const k of names) out += String(h[k].call(h)) + "|" + String(h[k].call(h, false));
  return out;
}

export function prototypeSpellings() {
  const h = new Hooks();
  const names = ["preprocess"];
  const out = [];
  for (const k of names) {
    const viaProto = Object.getPrototypeOf(h)[k];
    out.push("gpo=" + describeValue(viaProto) + ":" + String(viaProto.call(h, "q")));
    const viaClass = Hooks.prototype[k];
    out.push("cp=" + describeValue(viaClass) + ":" + String(viaClass.call(h, "w")));
  }
  return out.join(",");
}

export function inAgreesWithRead() {
  const h = new Hooks();
  const names = ["preprocess", "provideLexer", "missing"];
  const out = [];
  for (const k of names) out.push(k + ":" + String(k in h) + "/" + String(anyHas(h, k)));
  return out.join(",");
}

export function anyReceiverRead() {
  const h = new SubHooks();
  const names = ["preprocess", "postprocess", "missing"];
  const out = [];
  for (const k of names) out.push(k + "=" + describeValue(anyRead(h, k)));
  return out.join(",");
}

export function objectLiteralControl() {
  const o = { preprocess(md) { return "lit:" + md; } };
  const names = ["preprocess"];
  let out = "";
  for (const k of names) out += describeValue(o[k]) + ":" + String(o[k].call(o, "m"));
  return out;
}
`;

const NAMES = [
  "methodByRuntimeKey",
  "getterByRuntimeKey",
  "inheritedThroughSubclass",
  "forInWrapAndCall",
  "defaultParameterThroughCall",
  "prototypeSpellings",
  "inAgreesWithRead",
  "anyReceiverRead",
  "objectLiteralControl",
] as const;

function entryFor(names: readonly string[]): string {
  const imports = `import { ${[...names].sort().join(", ")} } from "./mod.js";`;
  const wrappers = names.map((name) => `export function via_${name}(): string { return ${name}(); }`);
  return `${imports}\n${wrappers.join("\n")}\n`;
}

let cached: Promise<WebAssembly.Exports> | undefined;

function instantiate(): Promise<WebAssembly.Exports> {
  if (cached) return cached;
  cached = (async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-5358-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "mod.js"), MODULE);
    writeFileSync(join(root, "entry.ts"), entryFor(NAMES));
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
  })();
  return cached;
}

const call = (exports: WebAssembly.Exports, name: (typeof NAMES)[number]): string =>
  (exports[`via_${name}`] as () => string)();

describe("#5358 runtime-key read of a class prototype method", () => {
  it("answers a callable for a method with and without a default parameter", async () => {
    const exports = await instantiate();
    expect(call(exports, "methodByRuntimeKey")).toBe("preprocess=function,provideLexer=function,missing=undefined");
  });

  it("invokes a getter under a runtime key with the read receiver as `this`", async () => {
    const exports = await instantiate();
    expect(call(exports, "getterByRuntimeKey")).toBe("hooks:i|hooks:b");
  });

  it("reaches an inherited method through a subclass instance", async () => {
    const exports = await instantiate();
    expect(call(exports, "inheritedThroughSubclass")).toBe(
      "preprocess=function,postprocess=function,provideLexer=function,post:x",
    );
  });

  it("returns the transformed value through marked's for-in + .call wrapper shape", async () => {
    const exports = await instantiate();
    expect(call(exports, "forInWrapAndCall")).toBe("pre:ABC");
  });

  it("runs a default parameter when the callable is invoked through .call", async () => {
    const exports = await instantiate();
    expect(call(exports, "defaultParameterThroughCall")).toBe("lex|lexInline");
  });

  it("answers the same method for Object.getPrototypeOf(h)[k] and C.prototype[k]", async () => {
    const exports = await instantiate();
    expect(call(exports, "prototypeSpellings")).toBe("gpo=function:pre:q,cp=function:pre:w");
  });

  it("makes `k in h` agree with the read on a typed and on an any-typed receiver", async () => {
    const exports = await instantiate();
    expect(call(exports, "inAgreesWithRead")).toBe("preprocess:true/true,provideLexer:true/true,missing:false/false");
  });

  it("answers through an any-typed receiver too", async () => {
    const exports = await instantiate();
    expect(call(exports, "anyReceiverRead")).toBe("preprocess=function,postprocess=function,missing=undefined");
  });

  it("still reads a plain object literal's method (control — passes on the parent too)", async () => {
    const exports = await instantiate();
    expect(call(exports, "objectLiteralControl")).toBe("function:lit:m");
  });
});
