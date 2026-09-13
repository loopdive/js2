// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6413 — `x ||= rhs` on a MODULE-LEVEL binding emitted a `global.get` with a
// stale slot index whenever compiling `rhs` added late imports.
//
// `compileLogicalAssignment` (`src/codegen/expressions/operator-assignment.ts`)
// built the `||=` arms in source order: the then-arm (`emitGet()` — "keep the
// current value") was emitted into a fresh array FIRST, then `fctx.body = []`
// detached that array while the RHS compiled into a second one. Compiling the
// RHS can call `ensureLateImport`, which inserts imported globals and then
// runs `shiftGlobalIndices` (`src/codegen/registry/imports.ts`) to bump every
// `global.get`/`global.set` at or above the insertion threshold. That walk
// reaches `fctx.body`, `fctx.savedBodies`, `ctx.funcStack` and friends — but
// the then-arm array was reachable from NONE of them, so its `global.get`
// kept the pre-shift index while the condition and the `global.set` (both
// re-resolved after the shift) moved to the new one.
//
// The then-arm therefore read a NEIGHBOURING global. In hono that neighbour
// had a different Wasm type, which is how it surfaced: three `dist/jsx/dom/*`
// modules compiled and then failed `WebAssembly.compile` with
//   Compiling function #195:"__closure_64" failed:
//     type error in fallthru[0] (expected i32, got externref)
// — the `if (result i32)` selected by `||=` fell through with the externref
// neighbour of the real i32 slot. hono reaches it through `dist/jsx/base.js`'s
// `jsxFn`: `nameSpaceContext ||= createContext("")`, where `createContext` is
// an imported `var` arrow whose call emits null-guard `__new_TypeError`
// message strings → string-constant globals → the shift.
//
// `&&=` and `??=` compile the RHS FIRST and are unaffected; the property-target
// form (`emitLogicalAssignmentPattern`) reads through `local.get tmpKeep` and
// never held a global index across a subexpression compile. The fix reorders
// the `||=` arms so the then-arm's `emitGet()` runs after the RHS, resolving
// its index post-shift. Emission order changes; execution order does not.
//
// Fixtures are plain untyped `.js` in a two-file project, matching how the
// upstream npm suites feed package code in: the import boundary is what makes
// the callee an arrow-valued `var` (hence the null-guard strings) rather than
// a directly-callable declaration.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { validateEmittedBinary } from "../src/optimize.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const ENTRY = `import { run } from "./main.js";\nexport function test(): string { return String((run as unknown as () => unknown)()); }`;

/** Imported arrow-valued `var` — calling it emits null-guard message strings. */
const ARROW_CTX = `var createContext = (v) => ({ value: v, kind: "ctx-6413" });\nexport { createContext };\n`;
/** Anti-vacuity control: a plain declaration is called directly, no late import. */
const DECL_CTX = `export function createContext(v) { return { value: v, kind: "ctx-6413" }; }\n`;

/** hono's `jsxFn` shape: a module `var`, logically assigned inside a closure. */
function mainSource(declaration: string, operator: string): string {
  return `import { createContext } from "./ctx.js";
${declaration}
var tag = (t) => {
  if (t === "svg" || t === "head") {
    nameSpaceContext ${operator} createContext("");
    return nameSpaceContext ? nameSpaceContext.kind : "null";
  }
  return "plain";
};
export function run() { return tag("svg") + "|" + tag("head") + "|" + tag("div"); }
`;
}

async function compileFixture(ctxSource: string, mainSrc: string) {
  const root = mkdtempSync(join(tmpdir(), "js2-6413-"));
  roots.push(root);
  writeFileSync(join(root, "ctx.js"), ctxSource);
  writeFileSync(join(root, "main.js"), mainSrc);
  writeFileSync(join(root, "entry.ts"), ENTRY);
  return compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
}

async function validateFixture(ctxSource: string, mainSrc: string): Promise<{ valid: boolean; detail?: string }> {
  const result = await compileFixture(ctxSource, mainSrc);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return validateEmittedBinary(result.binary);
}

/**
 * Every `||=` site in the emitted WAT, as `[conditionGlobal, thenArmGlobal]`.
 *
 * The lowering is `global.get <slot>; call <truthy>; (if (result externref)
 * (then global.get <slot>) (else …))` — condition and then-arm MUST name the
 * same slot. This is the direct, value-level reading of the bug: when the
 * neighbouring global happens to have a compatible Wasm type the module still
 * validates, and the only visible damage is that the pair disagrees.
 */
function logicalOrAssignGlobalPairs(wat: string): Array<[string, string]> {
  const site = /global\.get\s+(\d+)\s+call\s+\d+\s+\(if\s+\(result\s+externref\)\s+\(then\s+global\.get\s+(\d+)\s+\)/g;
  const pairs: Array<[string, string]> = [];
  for (const match of wat.replace(/\s+/g, " ").matchAll(site)) pairs.push([match[1]!, match[2]!]);
  return pairs;
}

async function runFixture(ctxSource: string, mainSrc: string): Promise<string> {
  const result = await compileFixture(ctxSource, mainSrc);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const validation = validateEmittedBinary(result.binary);
  expect(validation.valid, validation.detail ?? "invalid binary").toBe(true);
  const instance = await instantiateWithRuntime(result);
  return String((instance.exports as Record<string, () => unknown>).test());
}

describe("#6413 — `||=` on a module global after a late import", () => {
  // The hono `jsx/dom` shape, reduced. Before the fix this compiles and then
  // fails WebAssembly.compile with `fallthru[0] (expected i32, got externref)`.
  //
  // Its RUNTIME value is a separate, still-open defect, deliberately not
  // asserted here: `moduleGlobalWasmType` excludes the `void 0` initializer
  // arm for module globals (#4491), so `nameSpaceContext` gets an i32 slot and
  // `||=` stores a truncated 0 — the module validates but the context object
  // is lost, and this fixture then traps at run time. Tracked as #6434.
  it("emits a validating module for hono's `var ns = void 0; ns ||= createContext(...)`", async () => {
    const validation = await validateFixture(ARROW_CTX, mainSource("var nameSpaceContext = void 0;", "||="));
    expect(validation.valid, validation.detail ?? "binary rejected by the engine").toBe(true);
  });

  // Same defect, type-compatible neighbour. An uninitialised `var` gets an
  // externref slot, so the stale `global.get` lands on another externref: the
  // module still VALIDATES on the parent commit and, because `tag` is emitted
  // three times and only the FIRST copy predates the shift, it can even run
  // correctly. The damage is visible in the instruction stream — the `if`'s
  // condition and its then-arm name different globals — so that is what this
  // asserts. Parent: `[["21","20"],["21","21"],["21","21"]]`.
  it("keeps the then-arm on the same global as the condition for `var ns; ns ||= …`", async () => {
    const result = await compileFixture(ARROW_CTX, mainSource("var nameSpaceContext;", "||="));
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const pairs = logicalOrAssignGlobalPairs(result.wat ?? "");
    expect(pairs.length, "no `||=` site found — the lowering shape changed, update the matcher").toBeGreaterThan(0);
    for (const [condition, thenArm] of pairs) expect(thenArm).toBe(condition);
  });

  it("reads the assigned value back for `var ns; ns ||= createContext(...)`", async () => {
    expect(await runFixture(ARROW_CTX, mainSource("var nameSpaceContext;", "||="))).toBe("ctx-6413|ctx-6413|plain");
  });

  // ── anti-vacuity controls: pass on the parent commit AND with the fix ─────
  // Each isolates one ingredient. If they ever fail, the breakage is in the
  // shared `||=` lowering rather than in the late-import interaction.
  it("control — declaration callee (no late import) already worked", async () => {
    expect(await runFixture(DECL_CTX, mainSource("var nameSpaceContext;", "||="))).toBe("ctx-6413|ctx-6413|plain");
  });

  it("control — `??=` compiles its RHS first and was never stale", async () => {
    expect(await runFixture(ARROW_CTX, mainSource("var nameSpaceContext;", "??="))).toBe("ctx-6413|ctx-6413|plain");
  });

  it("control — `&&=` compiles its RHS first and was never stale", async () => {
    // `undefined` is falsy, so `&&=` never assigns and the binding stays unset.
    expect(await runFixture(ARROW_CTX, mainSource("var nameSpaceContext;", "&&="))).toBe("null|null|plain");
  });
});
