// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6425 — `new TextEncoder()` answered `TextEncoder is not a constructor` on
// the `--platform node` lane.
//
// `--platform node` type-checks against the DOM-free composite lib, which
// declares no `TextEncoder`/`TextDecoder`. So `isUnresolvableIdentifier` was
// true for the name and the #4246 unresolvable arm of
// `tryNonConstructableNewTarget` emitted a STATIC
// `TypeError("TextEncoder is not a constructor")` — reached before the
// recovery arm in `new-super.ts` (`!className && externClasses.has(name) &&
// resolvesToAmbientGlobal`) that exists for exactly this case, and which the
// synthetic `TextEncoder`/`TextDecoder` registration in
// `extern-declarations.ts` was written to feed.
//
// The web lane has lib.dom, resolves the symbol, and emitted `TextEncoder_new`
// all along — which is why only hono's two node-lane files
// (`src/utils/crypto.test.ts`, `src/utils/buffer.test.ts`) ever reported it.
//
// The fixtures are untyped `.js` deliberately: a `.ts` file with a DOM-typed
// annotation resolves the name and never reaches the arm under test.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const ENTRY = fileURLToPath(new URL("./fixtures/issue-6425/entry.js", import.meta.url));

type Compiled = {
  readonly imports: readonly { readonly name: string }[];
  readonly stringPool: readonly string[];
  readonly exports: WebAssembly.Exports;
};

async function compile(platform: "node" | "web"): Promise<Compiled> {
  const result = await compileProject(ENTRY, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result, { TextEncoder, TextDecoder }) as Record<string, unknown> &
    WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return {
    imports: (result.imports ?? []) as readonly { readonly name: string }[],
    stringPool: (result.stringPool ?? []) as readonly string[],
    exports: instance.exports,
  };
}

function importNames(compiled: Compiled): string[] {
  return compiled.imports.map((entry) => entry.name);
}

describe("#6425 — new TextEncoder() on the DOM-free node lane", () => {
  it("imports the host constructor instead of pooling a not-a-constructor throw", async () => {
    const compiled = await compile("node");
    // Parent: no `TextEncoder_new` import at all — the whole construction was
    // replaced by a static throw.
    expect(importNames(compiled)).toContain("TextEncoder_new");
    expect(compiled.stringPool).not.toContain("TextEncoder is not a constructor");
  });

  it("round-trips a multi-byte string through the real host encoder", async () => {
    const compiled = await compile("node");
    const utf8Length = compiled.exports.utf8Length as (text: string) => number;
    const echo = compiled.exports.echo as (text: string) => string;
    expect(utf8Length("炎")).toBe(3);
    expect(echo("炎")).toBe("炎");
  });

  // Anti-vacuity control 1: the same fixture on the web lane passed BEFORE the
  // fix too. If this ever fails, the assertions above stopped measuring the
  // node lane specifically.
  it("web lane is unchanged (control)", async () => {
    const compiled = await compile("web");
    expect(importNames(compiled)).toContain("TextEncoder_new");
    const echo = compiled.exports.echo as (text: string) => string;
    expect(echo("炎")).toBe("炎");
  });

  // Anti-vacuity control 2: the #4246 unresolvable-identifier throw is NOT
  // disabled in general — only names registered as host extern classes are
  // exempt. `NoSuchCtor` is not one.
  it("still throws for a genuinely undeclared constructor (control)", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "js2-6425-"));
    try {
      writeFileSync(join(root, "entry.js"), `export function boom() { return new NoSuchCtor(); }\n`);
      const result = await compileProject(join(root, "entry.js"), {
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "gc",
        platform: "node",
      });
      expect(result.success).toBe(true);
      expect(result.stringPool ?? []).toContain("NoSuchCtor is not a constructor");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
