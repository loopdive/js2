// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #6872 — the last five marked `Hooks.test.js` walls (16/18 → 30/30).
 * Five independent codegen defects, each reduced from marked's published
 * `lib/marked.esm.js` (`Marked.use` / `parseMarkdown`):
 *
 *  1. A field-absent `this.x` read in an object-literal method called with a
 *     foreign receiver (`hook.apply(hooksInstance, args)`) read off the method's
 *     NULL struct receiver instead of the caller's thisArg → `undefined`.
 *  2. An object-literal method parameter spelled like an enclosing local
 *     (`{ postprocess(html) {…} }` beside `const html = await …`) was promoted
 *     as a CAPTURE, re-routing the async frame's `html` through a global its
 *     resumed writes never reached → `null`.
 *  3. Two classes whose fields share Wasm types (`Renderer {options; parser}`,
 *     `Hooks {options; block}`) are ONE canonical struct type; the host
 *     field-name table answered the first class's names, so `block` read as
 *     absent on every `Hooks` instance.
 *  4. A function expression's own `let u` was captured from an already-closed
 *     sibling block's `let u` (→ `illegal cast` reading the sibling's cell).
 *  5. A sibling function's write to ITS OWN `u` counted as a write of the
 *     captured loop binding `u`, boxing it into one cell every iteration's
 *     closure shared — each hook wrapper called the FIRST hook.
 *
 * Untyped `.js` behind a two-file project, the shape the marked bundle has.
 * ANTI-VACUITY: each `*Control` export passes on the parent commit too; the
 * defect exports fail there (measured: `undefined|undefined`, `null`,
 * `…|undefined|…`, `illegal cast`, `illegal cast`).
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
class Renderer {
  options;
  parser;
  constructor(o) { this.options = o || null; }
}

class Hooks {
  options;
  block;
  constructor(o) { this.options = o || null; }
  provideLexer() { return "lex"; }
}

function dynGet(o, k) { return o[k]; }
function callDyn(o, k, x) { return o[k](x); }

// 1. foreign receiver: an object-literal method's field-absent \`this.x\`
export function foreignReceiverRead() {
  const h = new Hooks();
  h.block = true;
  const fn = { f() { return this.block; } }.f;
  return String(fn.apply(h, [])) + "|" + String(fn.call(h));
}

export function foreignReceiverControl() {
  const o = { block: 3, f() { return this.block; } };
  return String(o.f());
}

// 2. method parameter shadowing an enclosing local of an async frame
export async function shadowedParamAsyncFrame() {
  const pack = { m(html) { return html + "!"; } };
  const html = await callDyn(pack, "m", "H");
  return String(html);
}

export async function shadowedParamControl() {
  const pack = { m(h) { return h + "!"; } };
  const html = await callDyn(pack, "m", "H");
  return String(html);
}

// 3. two classes lowering to one struct type report their own field names
export function sharedStructFieldNames() {
  const r = new Renderer({});
  const h = new Hooks({});
  h.block = true;
  const keys = ["block"];
  return Object.keys(h).join(",") + "|" + String(dynGet(h, keys[0])) + "|" + Object.keys(r).join(",");
}

// 4. closure-owned \`let\` vs a closed sibling block's same-named binding
export function closureOwnedLet() {
  const pack = { a: 1 };
  const res = {};
  [pack].forEach((n) => {
    for (const i in n) {
      let u = n[i];
      res[i] = () => u;
    }
    res.w = function (o) {
      let u = [];
      u.push(o);
      return u;
    };
  });
  return JSON.stringify(res.w(8)) + "|" + String(res.a());
}

// 5. a sibling function's write to its OWN \`u\` is not a write of the captured \`u\`
export async function perIterationCapture() {
  const pack = { pre(m) { return "P:" + m; }, lex(b) { return "L:" + b; } };
  const r = {};
  [pack].forEach((n) => {
    for (const i in n) {
      let u = n[i];
      r[i] = (c) => (async () => { const d = await u.call(r, c); return d; })();
    }
    r.w = function (o) {
      let u = [];
      return u.push(o), (u = u.concat([1])), u;
    };
  });
  const a = await r.pre("x");
  const b = await r.lex("y");
  return a + "|" + b + "|" + JSON.stringify(r.w(0));
}
`;

const NAMES = [
  "foreignReceiverRead",
  "foreignReceiverControl",
  "shadowedParamAsyncFrame",
  "shadowedParamControl",
  "sharedStructFieldNames",
  "closureOwnedLet",
  "perIterationCapture",
] as const;

let cached: Promise<WebAssembly.Exports> | undefined;

function instantiate(): Promise<WebAssembly.Exports> {
  if (cached) return cached;
  cached = (async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-6872-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "mod.js"), MODULE);
    const imports = `import { ${[...NAMES].sort().join(", ")} } from "./mod.js";`;
    const wrappers = NAMES.map((name) => `export function via_${name}(): any { return ${name}(); }`);
    writeFileSync(join(root, "entry.ts"), `${imports}\n${wrappers.join("\n")}\n`);
    const result = await compileProject(join(root, "entry.ts"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "node",
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const hostImports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(result.binary, hostImports);
    (hostImports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
    (hostImports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
    (instance.exports.__module_init as (() => void) | undefined)?.();
    return instance.exports;
  })();
  return cached;
}

const call = async (name: (typeof NAMES)[number]): Promise<string> =>
  String(await ((await instantiate())[`via_${name}`] as () => unknown)());

describe("#6872 marked Hooks residual", () => {
  it("binds a field-absent `this.x` in an object-literal method to the caller's thisArg", async () => {
    expect(await call("foreignReceiverRead")).toBe("true|true");
    expect(await call("foreignReceiverControl")).toBe("3");
  });

  it("does not capture a method parameter that shares an async frame local's name", async () => {
    expect(await call("shadowedParamAsyncFrame")).toBe("H!");
    expect(await call("shadowedParamControl")).toBe("H!");
  });

  it("reports each class's own fields when two classes share one struct type", async () => {
    expect(await call("sharedStructFieldNames")).toBe("options,block|true|options,parser");
  });

  it("keeps a function expression's own `let` out of a closed sibling block's binding", async () => {
    expect(await call("closureOwnedLet")).toBe("[8]|1");
  });

  it("gives each loop iteration's closure its own binding beside a same-spelled sibling write", async () => {
    expect(await call("perIterationCapture")).toBe("P:x|L:y|[0,1]");
  });
});
