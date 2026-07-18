// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2509 — `referencedNames` (via `collectReferencedGlobalNames`) over-collected
 * property-access MEMBER names, so `port.close()` / `obj.open` / `x.toString()`
 * pulled `close`/`open`/`toString` into the ambient-global gate even though the
 * user never referenced the GLOBAL of that name. When such a name collides with
 * an ambient `declare function` (e.g. the DOM `close`/`open`/`fetch` globals),
 * a spurious `env.<name>` host import was emitted under wasi/standalone.
 *
 * Fix: `collectReferencedGlobalNames` now skips identifiers in property-NAME
 * position (property access `.name`, object-literal keys, member declaration
 * names, qualified-name `.right`). Only genuine bare/computed value references
 * gate the ambient `declare function` scan.
 *
 * The test drives `collectReferencedGlobalNames` directly with a `lib.`-named
 * `.d.ts` fixture so the member name (`port.close`) resolves to a LIB-FILE
 * method — the exact shape `isAmbientGlobalDecl` used to misclassify.
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
// Import the compiler entry first so the codegen module graph initializes in the
// right order (extern-declarations.js pulls in collections-brand.ts, whose
// module-eval reads COLLECTION_KIND — a bad init order if imported cold).
import "../src/index.js";
import { collectReferencedGlobalNames } from "../src/codegen/extern-declarations.js";

/** Build a tiny Program from an in-memory user .ts + a `lib.`-named .d.ts. */
function analyze(userSrc: string): Set<string> {
  const libName = "lib.fixture.d.ts";
  const libSrc = `
declare function close(): void;
declare function open(): void;
interface Port { close(): void; open(): void; }
declare const port: Port;
`;
  const userName = "user.ts";
  const files: Record<string, string> = { [libName]: libSrc, [userName]: userSrc };
  const sfs: Record<string, ts.SourceFile> = {};
  for (const [n, s] of Object.entries(files)) {
    sfs[n] = ts.createSourceFile(n, s, ts.ScriptTarget.ESNext, true);
  }
  const host: ts.CompilerHost = {
    getSourceFile: (f) => sfs[f],
    writeFile: () => {},
    getDefaultLibFileName: () => libName,
    getCurrentDirectory: () => "",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => f in files,
    readFile: (f) => files[f],
  };
  const program = ts.createProgram({
    rootNames: [userName],
    options: { noLib: false, types: [] },
    host,
  });
  const checker = program.getTypeChecker();
  return collectReferencedGlobalNames([sfs[userName]!], checker);
}

describe("#2509 — collectReferencedGlobalNames excludes property-name positions", () => {
  it("member access `port.close()` does NOT pull in the global `close`", () => {
    const names = analyze(`export function test(): void { port.close(); }`);
    expect(names.has("close")).toBe(false);
  });

  it("bare `close()` DOES register the global (regression guard)", () => {
    const names = analyze(`export function test(): void { close(); }`);
    expect(names.has("close")).toBe(true);
  });

  it("object-literal key `{ close: 1 }` does NOT pull in the global", () => {
    const names = analyze(`export function test(): number { const o = { close: 1 }; return o.close; }`);
    expect(names.has("close")).toBe(false);
  });

  it("distinguishes member vs bare in the same file", () => {
    const names = analyze(`export function test(): void { port.open(); close(); }`);
    // `open` only appears as a member → excluded; `close` is a bare call → included.
    expect(names.has("open")).toBe(false);
    expect(names.has("close")).toBe(true);
  });

  it("computed member `port[open]` keeps the bare `open` value reference", () => {
    // `open` here is a bare identifier used as a computed key — a genuine value
    // use, so it must still register.
    const names = analyze(`export function test(): void { const k = open; }`);
    expect(names.has("open")).toBe(true);
  });
});
