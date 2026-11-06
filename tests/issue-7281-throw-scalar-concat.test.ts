// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7281 — a module-init `throw new Test262Error('…' + (x))` whose message
// concatenates an f64 module binding no longer refuses `<module-init>` as
// `throw-module-scalar-unboxed`: a `new` yields an object, so only a scalar
// argument would be unboxed, and `'…' + x` is a string. A scalar argument
// (`new Test262Error(x)`) and a bare `throw x` stay refused.
//
// Each case runs through the test262 runner (the original harness) on
// standalone and gc, asserting the thrown message the JS spec gives
// (ToString of -0 is "0", 1e21 is "1e+21") and the `<module-init>` route.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

const dir = mkdtempSync(join(tmpdir(), "issue-7281-"));

function fixture(name: string, body: string): string {
  const path = join(dir, `${name}.js`);
  writeFileSync(path, `/*---\ndescription: issue 7281 ${name}\n---*/\n${body}\n`);
  return path;
}

async function moduleInitIsIr(path: string): Promise<boolean | undefined> {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const variant = assembleOriginalHarness(source, meta).primary;
  const result = await compile(variant.source, {
    ...originalHarnessCompileOptions(meta, "standalone"),
    fileName: path,
    trackIrOutcomes: true,
  });
  return result.irOutcomes?.find((o) => o.displayName === "<module-init>")?.irBodyEmitted;
}

interface Case {
  readonly body: string;
  /** The thrown message, or undefined when the test must pass. */
  readonly message?: string;
  readonly ir: boolean;
}

const CASES: Record<string, Case> = {
  "-0": { body: "var x = -0; if (x === 0) { throw new Test262Error('A: ' + (x)); }", message: "A: 0", ir: true },
  NaN: { body: "var x = NaN; if (x !== x) { throw new Test262Error('A: ' + (x)); }", message: "A: NaN", ir: true },
  "0.5": { body: "var x = 0.5; if (x > 0) { throw new Test262Error('A: ' + (x)); }", message: "A: 0.5", ir: true },
  "1e21": { body: "var x = 1e21; if (x > 0) { throw new Test262Error('A: ' + (x)); }", message: "A: 1e+21", ir: true },
  "compound-assigned": {
    body: "var x = 1; x <<= 3; if (x !== 2) { throw new Test262Error('A: ' + (x)); }",
    message: "A: 8",
    ir: true,
  },
  "nested concat": {
    body: "var x = 2.5; if (x) { throw new Test262Error(('a' + x) + 'b'); }",
    message: "a2.5b",
    ir: true,
  },
  "number-first concat": {
    body: "var x = 9; if (x) { throw new Test262Error(1 + x + ' Z'); }",
    message: "10 Z",
    ir: true,
  },
  "not firing": { body: "var x = 1; if (x !== 1) { throw new Test262Error('A: ' + (x)); }", ir: true },
  "scalar argument stays refused": {
    body: "var x = 3; if (x) { throw new Test262Error(x); }",
    message: "3",
    ir: false,
  },
  "bare scalar throw stays refused": { body: "var x = 3; if (x) { throw x; }", ir: false },
};

describe("#7281 module-init throw with a scalar binding inside a string concat", () => {
  for (const [name, c] of Object.entries(CASES)) {
    it(
      name,
      async () => {
        const path = fixture(name.replace(/\W+/g, "-"), c.body);
        expect(await moduleInitIsIr(path)).toBe(c.ir);
        for (const target of ["standalone", undefined] as const) {
          const result = await runTest262File(path, "issue-7281", 20000, target);
          if (c.message === undefined && c.ir) {
            expect(result.status, `${target ?? "gc"}: ${result.error ?? ""}`).toBe("pass");
          } else {
            expect(result.status, target ?? "gc").toBe("fail");
            if (c.message !== undefined) expect(result.error).toContain(`Test262Error: ${c.message}`);
          }
        }
      },
      60000,
    );
  }
});
