// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7305 — a statement call through a top-level subject's own dynamic
// parameter (`function u(g, x) { g(x); }`) lowers through the Stage-4 dynamic
// call (`__apply_closure`, undefined receiver) instead of keeping `u` legacy.
// Value-position calls, a subject that reads `this` (the runtime does not
// restore `__current_this` when the callee throws), `new g()`, `var` aliases
// and calls inside nested functions stay refused.
//
// Each runtime case runs through the test262 runner on standalone and gc and
// asserts the result legacy gives, plus `u`'s route and zero post-claim errors.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

const dir = mkdtempSync(join(tmpdir(), "issue-7305-"));

function fixture(name: string, body: string): string {
  const path = join(dir, `${name}.js`);
  writeFileSync(path, `/*---\ndescription: issue 7305 ${name}\n---*/\n${body}\n`);
  return path;
}

async function unitIsIr(path: string, unit: string): Promise<boolean | undefined> {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const variant = assembleOriginalHarness(source, meta).primary;
  const result = await compile(variant.source, {
    ...originalHarnessCompileOptions(meta, "standalone"),
    fileName: path,
    trackIrOutcomes: true,
  });
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result.irOutcomes?.find((o) => o.displayName === unit)?.irBodyEmitted;
}

const RUNTIME: Record<string, string> = {
  "arguments in order": `var log = []; function u(g, x) { g(x); }
u(function (v) { log.push(v); }, 3); u(function (v) { log.push(v + "!"); }, "b");
assert.sameValue(log.join(), "3,b!");`,
  "callee throw propagates": `function u(g) { g(); } var caught;
try { u(function () { throw new Test262Error("boom"); }); } catch (e) { caught = e; }
assert.sameValue(caught.message, "boom"); assert(caught instanceof Test262Error);`,
  "strict callee sees undefined this": `var seen = 1; function u(g) { g(); }
u(function () { "use strict"; seen = this; }); assert.sameValue(seen, undefined);`,
  "not callable throws TypeError": `function u(g) { g(); }
assert.throws(TypeError, function () { u(5); }); assert.throws(TypeError, function () { u(undefined); });`,
  "missing and extra arguments": `var seen; function u(g) { g(1); }
u(function (a, b) { seen = [a, b, arguments.length]; });
assert.sameValue(seen[0], 1); assert.sameValue(seen[1], undefined); assert.sameValue(seen[2], 1);
function w(g) { g(1, 2, 3); } w(function (a) { seen = arguments.length + ":" + arguments[2]; });
assert.sameValue(seen, "3:3");`,
  "bound and builtin callees": `var seen; function u(g, x) { g(x); }
u(function () { seen = this.k; }.bind({ k: 7 })); assert.sameValue(seen, 7);
u(Array.isArray, []); u(String, 2);`,
  // A top-level call to a name that is another function's dynamic parameter
  // must not take (or crash) the arm: test262 call/S11.2.3_A2.js.
  "top-level call of a parameter name": `function u(x) { x(1); }
var caught; try { x(); } catch (e) { caught = e; }
assert(caught instanceof ReferenceError); u(function () {});`,
  // #7164 review B1 (6701844712): a caller's `this` after a caught throw
  // through the dynamic call. `__apply_closure` must restore `__current_this`
  // on the throw edge; node gives "1". Legacy gives "NaN" here too.
  "caller this after a caught callee throw": `var out = "";
var o = { v: 1, m: function () { try { u(f); } catch (e) {} out += this.v; } };
var f = function () { throw 1; };
function u(g) { g(); }
o.m();
assert.sameValue(out, "1");`,
  "a function declaration used as a constructor": `var seen; function u(g) { g(); }
var called = 0; new u(function () { called++; }); assert.sameValue(called, 1);`,
  "identity is preserved": `var h0 = function () {}; var same; function u(g, h) { g(h); }
u(function (x) { same = x === h0; }, h0); assert.sameValue(same, true);`,
};

const REFUSED: Record<string, string> = {
  "value position": "function u(g, x) { return g(x); }",
  "subject reads this": "function u(g) { g(); return this; }",
  "new g()": "function u(g) { new g(); }",
  "var alias": "function u(g) { var h = g; h(); }",
  "class instance method (C_u)": "class C { u(g) { g(); } } new C().u(function () {});",
  "class static method (C_u)": "class C { static u(g) { g(); } } C.u(function () {});",
  "nested function": "function u(g) { var f = function () { g(); }; f(); }",
};

// #7166 review B1 (6702803650): with `u` claimed, `<module-init>` must not be
// claimed over an argument from-ast cannot carry into `g`. A bare compile (the
// CLI route, no harness options) is where these reproduced.
const BARE_MODULE_INIT: Record<string, string> = {
  "null argument": "function u(g) { g(1); }\nu(null);",
  "null argument in try": 'var R = ""; function u(g) { g(1); }\ntry { u(null); } catch (e) { R += "x"; }',
  "object literal argument": "function u(g) { g(1); }\nu({ a: 1 });",
  // #7328: the null reaches `u` through a script var; its initializer is refused.
  "null held in a script var": "var nv = null; function u(g) { g(1); }\nu(nv);",
};

describe("#7305 statement call through a top-level dynamic parameter", () => {
  for (const [name, source] of Object.entries(BARE_MODULE_INIT)) {
    it(`bare compile, ${name}: no post-claim error`, async () => {
      for (const target of ["standalone", "wasi", "gc"] as const) {
        const result = await compile(source, { target, fileName: "x.js", trackIrOutcomes: true });
        expect(result.success, target).toBe(true);
        expect(result.irPostClaimErrors ?? [], target).toEqual([]);
        expect(result.irOutcomes?.find((o) => o.displayName === "u")?.irBodyEmitted, target).toBe(true);
      }
    }, 60000);
  }
  for (const [name, body] of Object.entries(RUNTIME)) {
    it(
      name,
      async () => {
        const path = fixture(name.replace(/\W+/g, "-"), body);
        expect(await unitIsIr(path, "u")).toBe(true);
        for (const target of ["standalone", undefined] as const) {
          const result = await runTest262File(path, "issue-7305", 20000, target);
          expect(result.status, `${target ?? "gc"}: ${result.error ?? ""}`).toBe("pass");
        }
      },
      60000,
    );
  }
  for (const [name, body] of Object.entries(REFUSED)) {
    it(`${name} stays legacy`, async () => {
      const unit = /\((\w+)\)$/.exec(name)?.[1] ?? "u";
      expect(await unitIsIr(fixture(`refused-${name.replace(/\W+/g, "-")}`, body), unit)).toBe(false);
    }, 60000);
  }
});
