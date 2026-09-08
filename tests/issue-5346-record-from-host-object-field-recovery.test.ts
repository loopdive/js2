// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #5346 — rebuilding a `__anon_*` record from a HOST object trapped on
 * every reference-typed field.
 *
 * `buildRecordFromExternref` (#5243) exists for exactly one situation: a value
 * whose STATIC type is a compiler-minted record struct arrives at runtime as an
 * ordinary host object, so `ref.test` fails and the record has to be rebuilt
 * property by property with `__extern_get`. Its own comment described the
 * reference-field arm as "anything else lands as null on that ONE field" — but
 * the arm emitted a BARE `any.convert_extern; ref.cast_null`, and
 * `ref.cast null $T` does not produce null on a mismatch, it TRAPS. A host
 * property is never already a WasmGC struct, so the one input the materializer
 * was written for was the one input it could not survive: `RuntimeError:
 * illegal cast`.
 *
 * Measured on prettier@3.8.1: all three of `tests/unit/print-doc-to-string.js`
 * died inside `printDocToString`, whose `Indent.queue` is an ordinary host
 * array reached through the record materializer 23 times in that one function.
 *
 * The fix routes the field through the SAME `externref → ref_null` coercion arm
 * its enclosing value took to get here, so a vec field is rebuilt by element
 * copy instead of cast-or-die. That distinction is load-bearing and not
 * cosmetic: a plain guarded cast (test, else `ref.null`) also stops the trap,
 * but it hands `queue: []` back as `null`, and prettier's printer then spins
 * forever instead of crashing — a worse failure, which is why this test asserts
 * the field's CONTENTS and not merely that nothing threw.
 *
 * The fixture is untyped `.js` across two modules on purpose. Annotating the
 * values, or collapsing `grow` into its caller, keeps the value in a WasmGC
 * struct end to end and the materializer is never reached — the test then
 * passes identically with and without the fix.
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
 * prettier's `src/document/printer/indent.js`, reduced. `grow` returns a
 * SPREAD literal, so its value is built on the host and handed back as an
 * externref while its inferred return type is the closed record — the exact
 * mismatch `buildRecordFromExternref` is the terminal for. `queue` is that
 * record's vec-typed field.
 */
const INDENT_MODULE = `
const ROOT = { value: "", length: 0, queue: [] };

function grow(indent, options) {
  const queue = [...indent.queue, 1];
  return { ...indent, value: " ", length: options.tabWidth, queue };
}

export { grow, ROOT };
`;

/**
 * The consumer. Pushing the grown indent back through an array of command
 * records is what forces the record type at the boundary; reading it back out
 * is what used to trap.
 */
const PRINTER_MODULE = `
import { grow, ROOT } from "./indent.js";

export function grownLength() {
  const stack = [{ indent: ROOT, doc: "x" }];
  const top = stack.pop();
  stack.push({ indent: grow(top.indent, { tabWidth: 2 }), doc: top.doc });
  return stack.pop().indent.length;
}

export function grownQueueLength() {
  const stack = [{ indent: ROOT, doc: "x" }];
  const top = stack.pop();
  stack.push({ indent: grow(top.indent, { tabWidth: 2 }), doc: top.doc });
  return stack.pop().indent.queue.length;
}

export function seedQueueLength() {
  const stack = [{ indent: ROOT, doc: "x" }];
  return stack.pop().indent.queue.length;
}
`;

/**
 * Anti-vacuity control. Same harness, same compile options, a value the
 * fixture computes in plain arithmetic. If the wrappers, the instantiation or
 * `__module_init` silently stopped running, this returns something other than
 * 7 and the suite says so instead of the assertions above passing by accident.
 */
const CONTROL_MODULE = `
export function control() {
  return 3 + 4;
}
`;

function entryFor(module: string, names: readonly string[]): string {
  const imports = `import { ${[...names].sort().join(", ")} } from "./${module}";`;
  const wrappers = names.map((name) => `export function via_${name}(): number { return ${name}(); }`);
  return `${imports}\n${wrappers.join("\n")}\n`;
}

async function instantiate(
  files: Readonly<Record<string, string>>,
  entryModule: string,
  names: readonly string[],
): Promise<WebAssembly.Exports> {
  const root = mkdtempSync(join(tmpdir(), "js2-5346-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
  writeFileSync(join(root, "entry.ts"), entryFor(entryModule, names));
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

const call = (exports: WebAssembly.Exports, name: string): number => (exports[`via_${name}`] as () => number)();

const PROJECT = { "indent.js": INDENT_MODULE, "printer.js": PRINTER_MODULE };
const NAMES = ["grownLength", "grownQueueLength", "seedQueueLength"] as const;

describe("#5346 a record rebuilt from a host object recovers its reference fields", () => {
  it("reads a rebuilt record's primitive field without an illegal cast", async () => {
    // Parent commit: `RuntimeError: illegal cast` — the trap fires while
    // BUILDING the record, so even the f64 field is unreachable.
    const exports = await instantiate(PROJECT, "printer.js", NAMES);
    expect(call(exports, "grownLength")).toBe(2);
  });

  it("rebuilds the record's array field by copying it, not by nulling it", async () => {
    // The assertion that separates the real fix from a guarded cast: 1, not 0
    // (an empty vec fabricated out of nothing) and not a null deref.
    const exports = await instantiate(PROJECT, "printer.js", NAMES);
    expect(call(exports, "grownQueueLength")).toBe(1);
  });

  it("leaves a record that never crossed the host boundary alone", async () => {
    // `ROOT` reaches this read as its own WasmGC struct — `ref.test` succeeds
    // and no materialization happens. Passes on the parent commit too; it fails
    // if the recovery is applied where a plain cast was already correct.
    const exports = await instantiate(PROJECT, "printer.js", NAMES);
    expect(call(exports, "seedQueueLength")).toBe(0);
  });

  it("control: the harness reports a wrong answer rather than passing blank", async () => {
    const exports = await instantiate({ "control.js": CONTROL_MODULE }, "control.js", ["control"]);
    expect(call(exports, "control")).toBe(7);
  });
});
