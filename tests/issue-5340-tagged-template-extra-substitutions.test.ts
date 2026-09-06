// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5340) A NUMERIC tagged-template substitution must survive the surplus-
// argument path as a usable number, all the way into a host `new Array(n)`.
//
// #5338 fixed the arity half of this: `compileTaggedTemplateExpression`
// marshalled at most `declaredParams - 1` substitutions into positional slots
// and dropped the rest, so a tag reading `arguments` (the vitest/jest
// `test.each\`table\`` helper) saw `arguments.length === 1`. Its regression test
// (`issue-5338-tagged-template-call-site-arity.test.ts`) pins that the
// substitutions arrive at all, and that `strings.raw` is the raw parts.
//
// It deliberately uses STRING substitutions — its own comment explains why: "an
// untyped parameter lowers to f64 in this lane, so a string substitution would
// read NaN here for reasons that have nothing to do with this issue". That
// leaves the numeric round-trip unpinned, and the numeric round-trip is exactly
// what #5340 was reported as:
//
//   RangeError: Invalid array length
//
// hono's `src/utils/concurrent.test.ts` was 6/6 failing with that message.
// Chain: the dropped substitutions made `test.each` treat the template STRINGS
// array as its case list, so the test body got the raw 25-character table
// header instead of its row object; `row.count` read `undefined`; and
// `new Array(undefined)` reaches the host as `new Array(NaN)`.
//
// So this file is the value-level guard that complements #5338's arity guard:
// a number crossing the extras path must arrive as a non-negative integer the
// host will accept as a length, not as `undefined`/NaN. It fails on the
// pre-#5338 parent (2 of 3 cases) and passes from #5338 onward.
//
// Fixtures are deliberately UNTYPED `.js` in a two-file project: a `: any`
// annotation on the tag's parameter routes the call through a different arm and
// hides the defect.
//
// Each case carries an anti-vacuity control that exercises the SAME tag through
// a plain over-arity CALL, which already worked before #5338, so a fixture that
// silently stopped running cannot read as a pass.
//
// A property-access tag (`tags.each\`…\``, hono's own spelling) is NOT covered
// here: in a fixture this small it compiles to the `__tagged_template` host
// bridge, which hands the raw closure carrier to JS and fails with "tag is not
// a function" both before and after — a separate live defect. The hono suite
// reaches the closure `call_ref` arm instead and is the measurement that covers
// it.

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
 * The tag module — untyped `.js`, imported by the entry.
 *
 * `summarize` is shared by both tags so the two arms assert the identical
 * string, including the `new Array(n).length` readback of every substitution.
 */
const TAG_MODULE = `
export function summarize(argCount, values) {
  let out = 'n=' + argCount + ' vals=' + values.join(',');
  // The operand that produced the RangeError: a length that must arrive as a
  // real non-negative integer, not \`undefined\` (→ host NaN).
  for (let i = 0; i < values.length; i++) {
    out += ' len' + i + '=' + new Array(values[i]).fill(0).length;
  }
  return out;
}

export function namedTag(strings) {
  return summarize(arguments.length, Array.prototype.slice.call(arguments, 1));
}
`;

async function instantiate(entrySource: string): Promise<WebAssembly.Exports> {
  const root = mkdtempSync(join(tmpdir(), "js2-5340-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "tag.js"), TAG_MODULE);
  writeFileSync(join(root, "entry.js"), entrySource);
  const result = await compileProject(join(root, "entry.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

describe("#5340 numeric tagged-template substitutions reach the host as lengths", () => {
  it("carries numbers to a one-parameter named tag", async () => {
    const exports = await instantiate(`
      import { namedTag } from './tag.js';
      export function probe() { return namedTag\`a\${3}b\${10}c\`; }
      export function control() { return namedTag(['a', 'b', 'c'], 3, 10); }
    `);
    // Anti-vacuity: the plain over-arity CALL path already worked before #5338,
    // so a fixture that silently stopped running cannot pass.
    expect((exports.control as () => string)()).toBe("n=3 vals=3,10 len0=3 len1=10");
    expect((exports.probe as () => string)()).toBe("n=3 vals=3,10 len0=3 len1=10");
  });

  it("carries numbers to a one-parameter function-expression tag", async () => {
    const exports = await instantiate(`
      import { summarize } from './tag.js';
      const closureTag = function (strings) {
        return summarize(arguments.length, Array.prototype.slice.call(arguments, 1));
      };
      export function probe() { return closureTag\`a\${4}b\${7}c\`; }
      export function control() { return closureTag(['a', 'b', 'c'], 4, 7); }
    `);
    expect((exports.control as () => string)()).toBe("n=3 vals=4,7 len0=4 len1=7");
    expect((exports.probe as () => string)()).toBe("n=3 vals=4,7 len0=4 len1=7");
  });

  it("leaves an in-arity tag alone", async () => {
    // Every substitution fits a declared slot, so nothing rides the surplus
    // path. Passes on the pre-#5338 parent too — it pins the arm that must not
    // be disturbed.
    const exports = await instantiate(`
      function pair(strings, a, b) { return strings[0] + a + strings[1] + b + strings[2]; }
      export function probe() { return pair\`<\${1}|\${2}>\`; }
    `);
    expect((exports.probe as () => string)()).toBe("<1|2>");
  });
});
