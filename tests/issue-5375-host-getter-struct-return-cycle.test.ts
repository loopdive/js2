// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #5375 — prettier's `printDocToString` never returned for an array doc.
 *
 * The loop was not in the printer at all. `ROOT_INDENT` (prettier's
 * `src/document/printer/indent.js`) is an object literal with an accessor —
 * `get root() { return ROOT_INDENT; }` — so it lives on the host, while its
 * JSDoc `@type {RootIndent}` registers a compiler struct for the same shape.
 * The printer's command stack `[{ indent: ROOT_INDENT, mode, doc }]` is a vec
 * of records whose `indent` field is that struct, so storing the host object
 * there rebuilds it property by property (`buildRecordFromExternref`, #5243).
 * Reading `root` runs the getter; the getter's compiled callback was typed to
 * RETURN the same struct, so it rebuilt the same host object again, read `root`
 * again, and recursed through the host. Two defects made that a hang rather
 * than a crash, and both are fixed here:
 *
 *  A. A callback the host invokes as an accessor or method (`needsThis`, the
 *     `__make_getter_callback` bridge) now returns reference results as an
 *     externref (`hostFacingCallbackReturnType`, callback-ctor-bridge.ts). The
 *     host can only ever receive an externref, so the struct type bought
 *     nothing but the rebuild; the getter now hands `ROOT_INDENT` back as the
 *     host object it is.
 *  B. `__extern_get` swallowed the stack-overflow `RangeError` the recursion
 *     eventually produced and fell through to `_safeGet`, which re-ran the same
 *     read — re-descending until it overflowed again, a few frames higher.
 *     Measured: pinned at depth ~335, tens of thousands of unwind/re-descend
 *     cycles per second, never returning to depth 0. `_rethrowIfProxyOrRevoked`
 *     now re-throws a `RangeError` as the abrupt completion it is.
 *
 * Both lanes of the dogfood harness reproduced it (`compileAndRunUpstreamModule`:
 * Node passes, the Wasm worker times out in the EXECUTION stage), and the
 * fixture below is the two-file reduction that still looped on the parent —
 * including with the pushed literal hoisted into a `const`, which prettier's
 * full file happens to survive but the reduction does not.
 *
 * Why the assertions are shaped this way:
 *  - The loop lives inside a single `push`/record conversion, so no step
 *    counter in the JS loop can bound it. The bound is inside the getter: after
 *    64 reads it throws. On the parent that turns the hang into a `RangeError`
 *    that propagates out of `printDocToString` (fast, deterministic); with the
 *    fix the getter runs exactly ONCE for `["a"]` — measured with a host-import
 *    trace, not assumed — and the count is asserted exactly.
 *  - The `RangeError` test pins B on its own: a getter that throws one must run
 *    once and the error must reach the compiled `catch`. On the parent the
 *    swallow-and-retry ran it twice.
 *  - A getter-less `ROOT` with the same typedef passes on the parent too (the
 *    record rebuild reads `root` as undefined and stops); it is the control
 *    that the fix did not simply disable the rebuild.
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
 * prettier's `indent.js`, reduced to the two ingredients the loop needs: the
 * recursive JSDoc type (drop it and the parent terminates — measured) and the
 * self-returning accessor (drop it and the parent terminates — measured). The
 * read budget is the test's bound; it never fires with the fix.
 */
const INDENT_MODULE = `
/**
@typedef {{
  readonly value: '',
  readonly length: 0,
  readonly queue: readonly [],
  readonly root: RootIndent,
}} RootIndent
*/

let rootReads = 0;

/** @type {RootIndent} */
const ROOT_INDENT = {
  value: "",
  length: 0,
  queue: [],
  get root() {
    if (++rootReads > 64) throw new RangeError("root getter re-entered 64 times");
    return ROOT_INDENT;
  },
};

/** @type {RootIndent} */
const ROOT_NO_GETTER = {
  value: "",
  length: 0,
  queue: [],
};

function rootGetterReads() {
  return rootReads;
}

export { ROOT_INDENT, ROOT_NO_GETTER, rootGetterReads };
`;

/**
 * prettier's `printDocToString`, reduced to the STRING and ARRAY arms. The
 * command stack is what forces `ROOT_INDENT` into the record struct.
 */
const PRINTER_MODULE = `
import { ROOT_INDENT, ROOT_NO_GETTER, rootGetterReads } from "./indent.js";

const MODE_BREAK = Symbol("MODE_BREAK");

function getDocType(doc) {
  if (typeof doc === "string") return "string";
  if (Array.isArray(doc)) return "array";
  return null;
}

// The typed constant must be referenced IN the initializer literal: that is
// what types the record's \`indent\` field as the RootIndent struct. Passing it
// in as an (untyped) parameter types the field externref, nothing is rebuilt,
// and the loop never happens — which is why there are three copies below
// rather than one parameterized printer.
function print(doc) {
  const commands = [{ indent: ROOT_INDENT, mode: MODE_BREAK, doc }];
  let output = "";
  while (commands.length > 0) {
    const { indent, mode, doc } = commands.pop();
    switch (getDocType(doc)) {
      case "string":
        output += doc;
        break;
      case "array":
        for (let index = doc.length - 1; index >= 0; index--) {
          commands.push({ indent, mode, doc: doc[index] });
        }
        break;
      default:
        throw new Error("invalid doc");
    }
  }
  return output;
}

function printPlain(doc) {
  const commands = [{ indent: ROOT_NO_GETTER, mode: MODE_BREAK, doc }];
  let output = "";
  while (commands.length > 0) {
    const { indent, mode, doc } = commands.pop();
    switch (getDocType(doc)) {
      case "string":
        output += doc;
        break;
      case "array":
        for (let index = doc.length - 1; index >= 0; index--) {
          commands.push({ indent, mode, doc: doc[index] });
        }
        break;
      default:
        throw new Error("invalid doc");
    }
  }
  return output;
}

function printHoisted(doc) {
  const commands = [{ indent: ROOT_INDENT, mode: MODE_BREAK, doc }];
  let output = "";
  while (commands.length > 0) {
    const { indent, mode, doc } = commands.pop();
    switch (getDocType(doc)) {
      case "string":
        output += doc;
        break;
      case "array":
        for (let index = doc.length - 1; index >= 0; index--) {
          const command = { indent, mode, doc: doc[index] };
          commands.push(command);
        }
        break;
      default:
        throw new Error("invalid doc");
    }
  }
  return output;
}

export function printA() {
  return print(["a"]);
}

export function printAB() {
  return print(["a", "b"]);
}

export function printABHoisted() {
  return printHoisted(["a", "b"]);
}

export function rootReadsForA() {
  print(["a"]);
  return rootGetterReads();
}

export function printABWithoutGetter() {
  return printPlain(["a", "b"]);
}
`;

/**
 * Fix B on its own: a host-object getter that throws a RangeError. The count
 * says whether the read ran the getter once (spec) or twice (swallow, retry).
 */
const THROWING_GETTER_MODULE = `
let boomReads = 0;

const boomy = {
  get boom() {
    boomReads++;
    throw new RangeError("boom");
  },
};

export function readBoom() {
  try {
    return "value:" + String(boomy.boom);
  } catch (e) {
    return (e instanceof RangeError ? "range:" : "other:") + boomReads;
  }
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

function entryFor(module: string, names: readonly { name: string; type: "string" | "number" }[]): string {
  const imports = `import { ${names
    .map((n) => n.name)
    .sort()
    .join(", ")} } from "./${module}";`;
  const wrappers = names.map(({ name, type }) => `export function via_${name}(): ${type} { return ${name}(); }`);
  return `${imports}\n${wrappers.join("\n")}\n`;
}

async function instantiate(
  files: Readonly<Record<string, string>>,
  entryModule: string,
  names: readonly { name: string; type: "string" | "number" }[],
): Promise<WebAssembly.Exports> {
  const root = mkdtempSync(join(tmpdir(), "js2-5375-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
  writeFileSync(join(root, "entry.ts"), entryFor(entryModule, names));
  // The dogfood worker's options (`upstream-suite-compile-worker.mjs`), which
  // is the lane the hang was measured in.
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "web",
    experimentalIR: true,
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

const call = (exports: WebAssembly.Exports, name: string): unknown => (exports[`via_${name}`] as () => unknown)();

const PRINTER_PROJECT = { "indent.js": INDENT_MODULE, "printer.js": PRINTER_MODULE };
const PRINTER_NAMES = [
  { name: "printA", type: "string" },
  { name: "printAB", type: "string" },
  { name: "printABHoisted", type: "string" },
  { name: "rootReadsForA", type: "number" },
  { name: "printABWithoutGetter", type: "string" },
] as const;

describe("#5375 a host-invoked getter typed as a struct must not rebuild its own receiver", () => {
  it("prints a one-element array doc whose indent is a self-referencing host object", async () => {
    // Parent commit: never returns (bounded here to a RangeError by the getter's
    // read budget). The loop is inside the FIRST record conversion, at the
    // command stack's initializer — before the printer's loop runs at all.
    const exports = await instantiate(PRINTER_PROJECT, "printer.js", PRINTER_NAMES);
    expect(call(exports, "printA")).toBe("a");
  });

  it("runs the `root` getter exactly once for that doc", async () => {
    // Measured with a host-import trace on the fixed compiler: one
    // `__extern_get(ROOT_INDENT, "root")`. On the parent the same call recurses
    // until the budget throws, so this is where a partial fix would show.
    const exports = await instantiate(PRINTER_PROJECT, "printer.js", PRINTER_NAMES);
    expect(call(exports, "rootReadsForA")).toBe(1);
  });

  it("prints a two-element doc through the inline-literal push", async () => {
    const exports = await instantiate(PRINTER_PROJECT, "printer.js", PRINTER_NAMES);
    expect(call(exports, "printAB")).toBe("ab");
  });

  it("prints it through the hoisted-literal push as well", async () => {
    // The issue's hypothesis was that hoisting the literal is what terminates.
    // In this reduction the hoisted form looped on the parent too — the cycle
    // starts at the initializer, not at the push — so both forms are pinned.
    const exports = await instantiate(PRINTER_PROJECT, "printer.js", PRINTER_NAMES);
    expect(call(exports, "printABHoisted")).toBe("ab");
  });

  it("control: a getter-less indent with the same typedef prints on the parent too", async () => {
    // Passes before and after: the record rebuild reads `root` as undefined and
    // stops. It fails only if the rebuild itself were disabled, which is NOT
    // what this fix does.
    const exports = await instantiate(PRINTER_PROJECT, "printer.js", PRINTER_NAMES);
    expect(call(exports, "printABWithoutGetter")).toBe("ab");
  });

  it("a RangeError thrown by a host-object getter runs the getter once and reaches the catch", async () => {
    // Parent commit: "range:2" — `__extern_get` swallowed the first throw and
    // `_safeGet` ran the getter again. That retry is what turned a stack
    // overflow into an endless re-descend.
    const exports = await instantiate({ "boom.js": THROWING_GETTER_MODULE }, "boom.js", [
      { name: "readBoom", type: "string" },
    ]);
    expect(call(exports, "readBoom")).toBe("range:1");
  });

  it("control: the harness reports a wrong answer rather than passing blank", async () => {
    const exports = await instantiate({ "control.js": CONTROL_MODULE }, "control.js", [
      { name: "control", type: "number" },
    ]);
    expect(call(exports, "control")).toBe(7);
  });
});
