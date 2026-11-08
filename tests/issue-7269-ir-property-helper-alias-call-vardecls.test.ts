// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7269 — a function-local `var` initialised by a certified Object alias call
// (`var hadValue = __hasOwnProperty(obj, name)`, `var desc =
// __getOwnPropertyDescriptor(obj, name)`) is the provider's result, not an
// alias of module storage, so the selector admits it. Every other module
// alias local keeps `vardecl-module-binding-alias`: an alias that is written
// again, shadowed, called with the wrong arity, or called with a module value
// as an argument.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The refusal detail is recorded only under the shape diagnostic, which the
// selector reads at load: set it before the compiler is imported.
process.env.JS2WASM_IR_SHAPE_DIAG = "1";
const { compile } = await import("../src/index.js");
const { assembleOriginalHarness } = await import("./test262-original-harness.js");
const { originalHarnessCompileOptions, parseMeta, runTest262File } = await import("./test262-runner.js");

const ALIASES = `var __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
`;

const PROBE = `function probe(obj, name) {
  var hadValue = __hasOwnProperty(obj, name);
  var desc = __getOwnPropertyDescriptor(obj, name);
  if (hadValue) {
    return desc !== undefined;
  }
  return desc === undefined;
}
`;

const CHECKS = `var o = { w: 1 };
Object.defineProperty(o, "nw", { value: 2, writable: false });
assert.sameValue(probe(o, "w"), true, "own data");
assert.sameValue(probe(o, "nw"), true, "own non-writable");
assert.sameValue(probe(o, "missing"), true, "absent");
assert.sameValue(probe(Object.create(o), "w"), true, "inherited is not own");
var sym = Symbol("s");
o[sym] = 3;
assert.sameValue(probe(o, sym), true, "symbol key");
assert.sameValue(probe([1], 0), true, "index key");
`;

const dir = mkdtempSync(join(tmpdir(), "issue-7269-"));

function fixture(name: string, body: string, flag = "noStrict"): string {
  const path = join(dir, `${name}-${flag}.js`);
  writeFileSync(path, `/*---\nflags: [${flag}]\n---*/\n${body}`);
  return path;
}

async function probeOutcome(path: string, unit = "probe") {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const variant = assembleOriginalHarness(source, meta).primary;
  const result = await compile(variant.source, {
    ...originalHarnessCompileOptions(meta, "standalone"),
    fileName: path,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return (result.irOutcomes ?? []).find((outcome) => outcome.displayName === unit);
}

describe("#7269 certified alias-call vardecls", () => {
  for (const flag of ["noStrict", "onlyStrict"]) {
    it(`IR-emits the alias-call locals and passes (${flag})`, async () => {
      const path = fixture("admitted", ALIASES + PROBE + CHECKS, flag);
      expect(await probeOutcome(path)).toMatchObject({ kind: "emitted", irBodyEmitted: true });
      expect(await runTest262File(path, "issue-7269", undefined, "standalone")).toMatchObject({ status: "pass" });
    });
  }

  const refused: ReadonlyArray<readonly [string, string]> = [
    ["reassigned", ALIASES + PROBE + `__hasOwnProperty = function (o, k) { return false; };\n`],
    [
      "wrong-arity",
      ALIASES + PROBE.replace("__hasOwnProperty(obj, name)", "__hasOwnProperty(obj)") + CHECKS.split("\n")[0]! + "\n",
    ],
    [
      "module-argument",
      ALIASES +
        'var key = "w";\n' +
        PROBE.replace("__hasOwnProperty(obj, name)", "__hasOwnProperty(obj, key)") +
        CHECKS,
    ],
  ];
  for (const [name, body] of refused) {
    it(`keeps the alias rule for a ${name} alias call`, async () => {
      const outcome = await probeOutcome(fixture(name, body));
      expect(outcome?.irBodyEmitted).toBe(false);
      expect(outcome).toMatchObject({ detail: expect.stringContaining("vardecl-module-binding-alias") });
    });
  }

  // A local whose value is never read still runs its alias call: the key's
  // ToPropertyKey (and a Proxy receiver's traps) are observable, so dead-code
  // removal must keep `dyn.own_property` (`isSideEffecting`).
  const UNUSED_RESULT = `function f(obj, name) {
  var hadValue = __hasOwnProperty(obj, name);
  var desc = __getOwnPropertyDescriptor(obj, name);
  if (desc === undefined) { return -1; }
  return desc.value;
}
var log = "";
var k = { toString: function () { log += "k"; return "w"; } };
assert.sameValue(f({ w: 1 }, k), 1);
assert.sameValue(log, "kk", "ToPropertyKey must run once per alias call");
`;
  for (const flag of ["noStrict", "onlyStrict"]) {
    for (const target of ["gc", "standalone"] as const) {
      it(`keeps an unused alias call's key conversion (${flag}, ${target})`, async () => {
        const path = fixture(`unused-${target}`, ALIASES + UNUSED_RESULT, flag);
        const lane = target === "standalone" ? "standalone" : undefined;
        expect(await runTest262File(path, "issue-7269", undefined, lane)).toMatchObject({ status: "pass" });
      });
    }
  }

  // The same DCE rule for a dynamic member read (already reachable on main):
  // an unused `o.a` / `o[k]` still runs its getter, and still throws on a
  // null receiver.
  const UNUSED_MEMBER_READ = `function touch(o, k) {
  var v = o.a;
  var w = o[k];
  return 1;
}
var log = "";
var o = {};
Object.defineProperty(o, "a", { get: function () { log += "a"; return 1; } });
Object.defineProperty(o, "b", { get: function () { log += "b"; return 2; } });
assert.sameValue(touch(o, "b"), 1);
assert.sameValue(touch(o, 0), 1);
assert.sameValue(log, "aba", "every getter runs");
var threw = false;
try { touch(null, "b"); } catch (e) { threw = e instanceof TypeError; }
assert.sameValue(threw, true, "null receiver throws");
`;
  for (const target of ["gc", "standalone"] as const) {
    it(`keeps an unused dynamic member read (${target})`, async () => {
      const path = fixture(`unused-member-${target}`, UNUSED_MEMBER_READ);
      expect(await probeOutcome(path, "touch")).toMatchObject({ irBodyEmitted: true });
      const lane = target === "standalone" ? "standalone" : undefined;
      expect(await runTest262File(path, "issue-7269", undefined, lane)).toMatchObject({ status: "pass" });
    });
  }

  it("does not certify a call through a shadowing local", async () => {
    const shadowed = PROBE.replace("function probe(obj, name) {", "function probe(obj, name, __hasOwnProperty) {");
    const path = fixture(
      "shadowed",
      ALIASES + shadowed + `assert.sameValue(probe({}, "w", function () { return true; }), false);\n`,
    );
    expect((await probeOutcome(path))?.detail ?? "").not.toContain("vardecl-module-binding-alias");
    expect(await runTest262File(path, "issue-7269", undefined, "standalone")).toMatchObject({ status: "pass" });
  });
});
