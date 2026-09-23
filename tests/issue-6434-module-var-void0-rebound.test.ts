// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6434 — a module-level `var x = void 0;` later rebound to an object was
// allocated an **i32** Wasm global, so the rebind stored a truncated `0` and
// every later read saw a falsy null pointer instead of the object.
//
// `moduleGlobalWasmType` (`src/codegen/declarations.ts`) has no arm for a
// `void 0` initializer, so the binding falls through to `resolveWasmType` and
// lands on i32 by the "void produces no result" convention. The widening that
// should have rescued it — `collectHeterogeneouslyAssignedModuleVarNames`
// (`src/ir/heterogeneous-module-bindings.ts`), read by BOTH direct codegen and
// the IR module-binding resolver so the two cannot disagree on a slot — missed
// on two independent counts:
//
//   1. `initializerTagOf` admitted only `HETEROGENEOUS_PRIMITIVE_SLOT_TAGS`
//      (number/string/boolean/bigint). `void 0` tags `"undefined"` and was
//      dropped, so the binding was never a widening candidate at all.
//   2. `visit` matched only `EqualsToken`, so `||=` / `??=` / `&&=` writes
//      were invisible even for bindings that WERE candidates.
//
// (1) alone explains the plain-`=` cases; (2) is what hono needs. `dist/jsx/
// base.js` declares `let nameSpaceContext` and `jsxFn` does
// `nameSpaceContext ||= createContext("")`; a bundled subpath that downlevels
// that to `var nameSpaceContext = void 0;` therefore lost the namespace
// context for `<svg>` / `<head>`.
//
// The fix admits `"undefined"` as a slot tag only for a SYNTACTIC `void <e>`
// initializer — the downlevelled shape of an unassigned `let` — and indexes
// the three logical assignment operators alongside `=`. A binding whose
// initializer merely has type `undefined` (an optional read, a delete
// sentinel) keeps its specialized slot, and a `void 0` that is never rebound
// keeps its i32 slot: both are asserted below as narrowness controls.
//
// Fixtures are untyped `.js` in a two-file project, matching how the upstream
// npm suites feed package code in — the import boundary is what makes the
// callee an arrow-valued `var`, which is hono's actual shape.

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

/** hono's shape: the context factory is an imported arrow-valued `var`. */
const CTX = `var createContext = (v) => ({ value: v, kind: "ctx-6434" });\nexport { createContext };\n`;

/**
 * `tag()` answers the binding's `kind` for the two namespaced tags and
 * `"plain"` otherwise, so one string witnesses both the rebind and the reads
 * that follow it. `trailer` runs at module top level, after the declaration.
 */
function mainSource(declaration: string, rebind: string, trailer = ""): string {
  return `import { createContext } from "./ctx.js";
${declaration}
var tag = (t) => {
  if (t === "svg" || t === "head") {
${rebind}
    return nameSpaceContext ? nameSpaceContext.kind : "null";
  }
  return "plain";
};
${trailer}export function run() { return tag("svg") + "|" + tag("head") + "|" + tag("div"); }
`;
}

async function compileFixture(mainSrc: string) {
  const root = mkdtempSync(join(tmpdir(), "js2-6434-"));
  roots.push(root);
  writeFileSync(join(root, "ctx.js"), CTX);
  writeFileSync(join(root, "main.js"), mainSrc);
  writeFileSync(join(root, "entry.ts"), ENTRY);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

/** The declared Wasm type of the `nameSpaceContext` module slot, from the WAT. */
function moduleSlotType(wat: string): string {
  const match = /\(global \$__mod_nameSpaceContext \(mut ([A-Za-z0-9_.]+)\)/.exec(wat.replace(/\s+/g, " "));
  expect(match, "no `__mod_nameSpaceContext` global in the WAT — the slot naming changed").not.toBeNull();
  return match![1]!;
}

async function runFixture(mainSrc: string): Promise<string> {
  const result = await compileFixture(mainSrc);
  const validation = validateEmittedBinary(result.binary);
  expect(validation.valid, validation.detail ?? "invalid binary").toBe(true);
  const instance = await instantiateWithRuntime(result);
  return String((instance.exports as Record<string, () => unknown>).test());
}

const REBOUND = "ctx-6434|ctx-6434|plain";

describe("#6434 — module `var x = void 0` rebound to an object", () => {
  // ── red on the parent revision: slot=i32, run=`null|null|plain` ───────────
  it("carries the object for hono's `var ns = void 0; ns ||= createContext(...)`", async () => {
    const source = mainSource("var nameSpaceContext = void 0;", '    nameSpaceContext ||= createContext("");');
    expect(moduleSlotType((await compileFixture(source)).wat ?? "")).toBe("externref");
    expect(await runFixture(source)).toBe(REBOUND);
  });

  it("carries the object for a plain `=` rebind inside a closure", async () => {
    const source = mainSource(
      "var nameSpaceContext = void 0;",
      '    if (!nameSpaceContext) nameSpaceContext = createContext("");',
    );
    expect(moduleSlotType((await compileFixture(source)).wat ?? "")).toBe("externref");
    expect(await runFixture(source)).toBe(REBOUND);
  });

  it("carries the object for a top-level `=` rebind", async () => {
    const source = mainSource("var nameSpaceContext = void 0;", "", 'nameSpaceContext = createContext("");\n');
    expect(moduleSlotType((await compileFixture(source)).wat ?? "")).toBe("externref");
    expect(await runFixture(source)).toBe(REBOUND);
  });

  it("carries the object for a `??=` rebind", async () => {
    const source = mainSource("var nameSpaceContext = void 0;", '    nameSpaceContext ??= createContext("");');
    expect(await runFixture(source)).toBe(REBOUND);
  });

  // ── anti-vacuity controls: green on the parent revision AND with the fix ──
  // Each already reached an externref slot before this change. If one ever
  // fails, the breakage is in the shared module-global lowering rather than in
  // the `void 0` admission.
  it("control — a bare `var ns;` was never affected", async () => {
    expect(await runFixture(mainSource("var nameSpaceContext;", '    nameSpaceContext ||= createContext("");'))).toBe(
      REBOUND,
    );
  });

  it("control — `var ns = undefined;` was never affected", async () => {
    expect(
      await runFixture(mainSource("var nameSpaceContext = undefined;", '    nameSpaceContext ||= createContext("");')),
    ).toBe(REBOUND);
  });

  // ── narrowness: the widening is driven by an actual rebind, not by `void` ─
  it("narrowness — a `void 0` that is never rebound keeps its specialized slot", async () => {
    const result = await compileFixture(mainSource("var nameSpaceContext = void 0;", ""));
    expect(moduleSlotType(result.wat ?? "")).toBe("i32");
  });
});
