// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3403 — object-integrity tracking maps keyed by BARE variable name →
// cross-function collision (same archetype as #3364, which fixed the sibling
// SHAPE-widening maps but left these integrity maps bare-keyed).
//
// The maps `frozenVars` / `sealedVars` / `nonExtensibleVars` and the
// `varName`-half of `definedPropertyFlags` / `widenedDefinePropertyKeys` were
// keyed by the bare identifier text, module-wide. So a `const o = {}` frozen /
// defineProperty'd in ONE function poisoned every OTHER function's variable
// that happened to share the name — producing spurious runtime throws
// ("assign to read only property of frozen object" / "Cannot redefine
// property") on objects that were never frozen / redefined.
//
// Fix: key all five maps per-declaration (name + declaration start offset) via
// `integrityVarKey` / `widenedVarKeyFromDecl` (the #3364 machinery), with a
// bare-name fallback for module-level / ambient globals (which cannot collide
// cross-function anyway). Both the standalone (pure-Wasm) and host lanes must
// return the spec values; non-colliding modules stay byte-identical.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

async function runHost(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as unknown as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as { test: () => unknown }).test();
}

// (a) freeze collision — `mutateIt`'s `cfg` is never frozen; pre-fix the bare
// name `cfg` poisoned by `freezeIt` made its write compile-away to a throw.
const FREEZE_REPRO = `
function freezeIt(): number { const cfg = { a: 1 }; Object.freeze(cfg); return cfg.a; }
function mutateIt(): number { const cfg = { a: 1 }; cfg.a = 5; return cfg.a; }
export function test(): number { return freezeIt() + mutateIt(); }`; // want 6

// (b) defineProperty collision — `b`'s independent `o` is legally redefined;
// pre-fix `a`'s non-configurable `o:p` poisoned it into a spurious redefine throw.
const DEFINE_REPRO = `
function a(): number { const o: any = {}; Object.defineProperty(o, "p", { value: 1, configurable: false }); return o.p; }
function b(): number {
  const o: any = {};
  Object.defineProperty(o, "p", { value: 2, configurable: true });
  Object.defineProperty(o, "p", { value: 3, configurable: true });
  return o.p;
}
export function test(): number { return a() + b(); }`; // want 4

// Control: a same object frozen/mutated with DISTINCT names must be unaffected
// (guards that the fix does not over-suppress the real freeze semantics).
const FREEZE_CONTROL = `
function freezeIt(): number { const frozenCfg = { a: 1 }; Object.freeze(frozenCfg); return frozenCfg.a; }
function mutateIt(): number { const mutableCfg = { a: 1 }; mutableCfg.a = 5; return mutableCfg.a; }
export function test(): number { return freezeIt() + mutateIt(); }`; // want 6

describe("#3403 object-integrity per-declaration keying", () => {
  it("(a) freeze in one function does not poison a same-named var in another (standalone)", async () => {
    expect(await runStandalone(FREEZE_REPRO)).toBe(6);
  });
  it("(a) freeze collision — host lane", async () => {
    expect(await runHost(FREEZE_REPRO)).toBe(6);
  });

  it("(b) defineProperty in one function does not block a legal redefine in another (standalone)", async () => {
    expect(await runStandalone(DEFINE_REPRO)).toBe(4);
  });
  it("(b) defineProperty collision — host lane", async () => {
    expect(await runHost(DEFINE_REPRO)).toBe(4);
  });

  it("control: distinct names keep correct freeze semantics (standalone)", async () => {
    expect(await runStandalone(FREEZE_CONTROL)).toBe(6);
  });
});
