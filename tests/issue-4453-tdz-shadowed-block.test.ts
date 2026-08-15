// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4453 — the TDZ early-error scan reported a nested block's OWN lexical
// declarations as TDZ violations of a same-named outer binding declared later
// in the enclosing statement list:
//
//     if (cond) { const x = 1; use(x); }   // ← both flagged
//     const x = 2;
//
// The scan descended into nested blocks without tracking shadowing, so every
// mention of `x` inside the `if` looked like a use-before-declaration of the
// outer `const x`. This is correct code — `src/import-resolver.ts` (two sibling
// `const replacementText`) and `src/cjs-rewrite.ts` (two sibling `const
// imports`) both hit it, and it blocked compiling the compiler with itself.
//
// Every test pins BOTH directions: the shadowed shape must be silent, and the
// genuine TDZ it resembles must still be reported at the same position. A fix
// that only removes the false positive, at the cost of missing the real
// violation, is not a fix.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ts } from "../src/ts-api.js";
import { detectEarlyErrors } from "../src/compiler/early-errors/index.js";
import { compileFiles } from "../src/index.js";

/** Every early-error diagnostic for `src`, as `message@line:column`. */
function diagnostics(src: string): string[] {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
  return detectEarlyErrors(sf, { moduleGoal: true }).map((e) => `${e.message}@${e.line}:${e.column}`);
}

/** Just the TDZ diagnostics, so an unrelated rule firing can't mask the result. */
function tdz(src: string): string[] {
  return diagnostics(src).filter((m) => m.startsWith("Cannot access "));
}

describe("#4453 nested-block shadowing is not a TDZ violation", () => {
  it("an if-block's own const is not a use of the same-named outer const", () => {
    expect(
      tdz("function f(cond, use) {\n  if (cond) {\n    const x = 1;\n    use(x);\n  }\n  const x = 2;\n}"),
    ).toEqual([]);
  });

  it("a bare block at module top level shadows the same way", () => {
    expect(tdz("{\n  const y = 1;\n  use(y);\n}\nconst y = 2;")).toEqual([]);
  });

  it("a let/const for-head binding shadows over the whole loop", () => {
    expect(tdz("for (let i = 0; i < 3; i++) { use(i); }\nconst i = 9;")).toEqual([]);
  });

  it("a switch CaseBlock's lexical names shadow across its clauses", () => {
    expect(tdz("switch (v) { case 1: const s = 1; use(s); }\nconst s = 2;")).toEqual([]);
  });

  it("a catch parameter shadows", () => {
    expect(tdz("try { g(); } catch (e) { use(e); }\nconst e = 2;")).toEqual([]);
  });

  it("a destructuring pattern shadows every name it binds", () => {
    expect(tdz("{ const { p, q } = o; use(p, q); }\nconst p = 1;\nconst q = 2;")).toEqual([]);
  });

  it("block-scoped class and function declarations shadow too", () => {
    expect(tdz("{ class C {} use(C); }\nconst C = 1;")).toEqual([]);
    expect(tdz("{ function fn() {} use(fn); }\nconst fn = 1;")).toEqual([]);
  });
});

describe("#4453 genuine TDZ violations are still reported", () => {
  it("a use before the declaration in the same statement list", () => {
    expect(tdz("function g(use) {\n  use(x);\n  const x = 1;\n}")).toEqual([
      "Cannot access 'x' before initialization@2:7",
    ]);
  });

  it("a use inside a nested block that does NOT re-declare the name", () => {
    expect(tdz("{ use(x); }\nconst x = 2;")).toEqual(["Cannot access 'x' before initialization@1:7"]);
  });

  it("a nested block that declares only OTHER names still exposes the outer use", () => {
    expect(tdz("{ const y = 0; use(x); }\nconst x = 2;")).toEqual(["Cannot access 'x' before initialization@1:20"]);
  });

  it("a use before the declaration INSIDE the shadowing block — reported exactly once", () => {
    // The inner block both shadows the outer `x` and violates its own TDZ. The
    // outer scan must stay silent; the inner scan must report the one real
    // violation. Before #4453 this emitted three diagnostics for one bug.
    expect(tdz("{ use(x); const x = 1; }\nconst x = 2;")).toEqual(["Cannot access 'x' before initialization@1:7"]);
  });

  it("a for-head binding does not shadow a different pending name", () => {
    expect(tdz("for (let i = 0; i < n; i++) {}\nconst n = 9;")).toEqual([
      "Cannot access 'n' before initialization@1:21",
    ]);
  });

  it("a self-reference in the declaration's own initializer", () => {
    expect(tdz("let a = a + 1;")).toEqual(["Cannot access 'a' before initialization@1:9"]);
  });
});

describe("#4453 compileFiles no longer reports the false positive", () => {
  /** The `Cannot access` messages a whole-program compile of `entry` produces. */
  async function tdzErrorsOf(entry: string): Promise<string[]> {
    const r = (await compileFiles(entry, {})) as { errors?: { message: string }[] };
    return (r.errors ?? []).map((e) => e.message).filter((m) => m.startsWith("Cannot access "));
  }

  it("compiles a reduced fixture with import-resolver's shape", async () => {
    // Two sibling `const replacementText`, the first inside a nested if-block —
    // src/import-resolver.ts lines ~1313 and ~1396, minimized.
    const fixture = fileURLToPath(new URL("./fixtures/issue-4453-shadowed-block.ts", import.meta.url));
    expect(await tdzErrorsOf(fixture)).toEqual([]);
  }, 60_000);
});

describe("#4453 the reporting files are clean", () => {
  // The two real files the sweep found. Asserted on the DIAGNOSTIC, not on a
  // whole-program compile: `compileFiles` on either pulls the compiler's full
  // ~700-file graph and peaks at 0.7–0.9 GB RSS, which OOMs a vitest worker
  // (measured 2026-08-15) — while the false positive is produced by the
  // early-error gate on the single file, which is exactly what this asserts.
  // Before the fix: 3 diagnostics for import-resolver, 4 for cjs-rewrite.
  function tdzOfFile(rel: string): string[] {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    const sf = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
      ts.ScriptKind.TS,
    );
    return detectEarlyErrors(sf, { moduleGoal: true })
      .map((e) => `${e.message}@${e.line}`)
      .filter((m) => m.startsWith("Cannot access "));
  }

  it("src/import-resolver.ts — no 'Cannot access replacementText'", () => {
    expect(tdzOfFile("../src/import-resolver.ts")).toEqual([]);
  });

  it("src/cjs-rewrite.ts — no 'Cannot access imports'", () => {
    expect(tdzOfFile("../src/cjs-rewrite.ts")).toEqual([]);
  });
});
