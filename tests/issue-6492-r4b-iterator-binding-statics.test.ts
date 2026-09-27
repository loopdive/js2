// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 round 4b — the `%Iterator%` binding must carry the intrinsic's STATICS.
//
// Round 4 gave the linked lane a binding (`function Iterator() {}`) and fixed
// 120 rows that need one. It also SHADOWED the real `%Iterator%`, and 19 rows
// need that instead: before any shim existed, `Iterator.concat` / `.from` /
// `.zip` / `.zipKeyed` resolved through the compiler's builtin machinery to the
// real (polyfilled, or host-native) constructor while the bare identifier read
// `undefined`. Those rows reverted to the honest verdict.
//
// The two halves pull in opposite directions and this file pins BOTH, because
// either one alone was measured to break the other:
//   - binding `Iterator` directly to the intrinsic restores every static but
//     makes `new (class Sub extends Iterator {}) instanceof Iterator` FALSE (a
//     compiled class instance does not satisfy `instanceof` against a host
//     function);
//   - keeping the synthetic binding alone loses the statics.
// So the shim keeps the binding and copies the intrinsic's own function-valued
// statics onto itself.
//
// Real-runner measurement over all 654 rows of `built-ins/Iterator/`, linked
// lane: pre-shim 240 passes → round 4 341 → round 4b 352.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { ITERATOR_BINDING_PREAMBLE, needsIteratorBinding } from "../scripts/test262-iterator-binding.mjs";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6492-r4b-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

const HEADER = "/*---\ndescription: r4b\nfeatures: [iterator-helpers]\n---*/\n";

type Verdict = "pass" | `fail: ${string}` | `compile_error: ${string}`;

/** Linked-lane verdict only — see the note in `issue-6492-r4-…` for why. */
async function linkedLane(body: string): Promise<Verdict> {
  const source = HEADER + body;
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await buildHarnessProvider({
    harnessPrefix: assembly.harnessPrefix,
    cacheDir: CACHE,
    compileOptions: OPTIONS,
  });
  const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...OPTIONS,
    strict: assembly.primary.strict,
  });
  if (!result.success) return `compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`;
  const runtime = await import("../src/runtime.js");
  const importObject = runtime.buildImports(result.imports as never, { console }, result.stringPool as never);
  try {
    await instantiateTest262Module(result.binary, importObject, {
      linkedModules: result.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime,
    });
    return "pass";
  } catch (error) {
    return `fail: ${String((error as { message?: string })?.message ?? error)}`;
  }
}

describe("#6492 r4b — the binding carries the intrinsic's statics", () => {
  it("copies the intrinsic's statics while keeping its own name/length/prototype", () => {
    // The copy is an enumeration, not a hand list — the static set is
    // engine-dependent (CI runs a newer Node than a dev container) and a hand
    // list silently omits whatever the newer engine added.
    expect(ITERATOR_BINDING_PREAMBLE).toContain("Object.getOwnPropertyNames");
    for (const excluded of ["length", "name", "prototype"]) {
      expect(ITERATOR_BINDING_PREAMBLE).toContain(`=== "${excluded}"`);
    }
    // The binding itself stays a js2-compiled function declaration; binding it
    // to the intrinsic instead is what broke `instanceof`.
    expect(ITERATOR_BINDING_PREAMBLE).toContain("function Iterator() {}");
  });

  it("does not inject for a body whose only `Iterator` is in a comment", () => {
    // `Iterator/prototype/{drop,take}/underlying-iterator-advanced-in-parallel.js`
    // name `Iterator` only in the frontmatter `info:` block. Injecting there
    // flipped both rows pass → fail once the shim started reading
    // `%IteratorPrototype%.constructor`, so the gate no longer counts comments.
    const commentOnly = `${HEADER}/*\n  %Iterator.prototype%.drop\n*/\nlet it = [][Symbol.iterator]();\n`;
    const lineComment = `${HEADER}// Iterator.prototype.drop\nlet it = 1;\n`;
    const realUse = `${HEADER}let it = Object.create(Iterator.prototype);\n`;
    expect(needsIteratorBinding(commentOnly)).toBe(false);
    expect(needsIteratorBinding(lineComment)).toBe(false);
    expect(needsIteratorBinding(realUse)).toBe(true);
    // A declaration that is itself commented out must not suppress a binding
    // the live code below needs.
    expect(needsIteratorBinding(`${HEADER}// class Iterator {}\nlet it = Iterator.prototype;\n`)).toBe(true);
  });

  it("`Iterator.from` is the intrinsic's, and `extends Iterator` still works", async () => {
    // Both halves in ONE body on purpose: every earlier cut satisfied one and
    // broke the other.
    const linked = await linkedLane(
      `if (typeof Iterator.from !== "function") { throw new Error("no from: " + typeof Iterator.from); }\n` +
        `if (Iterator.name !== "Iterator") { throw new Error("name " + Iterator.name); }\n` +
        `class Sub extends Iterator {}\n` +
        `if (!(new Sub() instanceof Iterator)) { throw new Error("not an Iterator"); }`,
    );
    expect(linked).toBe("pass");
  }, 600_000);
});
