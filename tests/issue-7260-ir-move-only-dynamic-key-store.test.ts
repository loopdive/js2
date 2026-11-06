// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7260 — the move-only scan admits a statement-position element store on a
// dynamic LOCAL receiver (`obj[name] = v`, as in propertyHelper's
// isWritable), lowered through `dyn.member_set` with the function code's
// PutValue failure rule: a sloppy store to a frozen object is ignored, a
// strict one throws TypeError. Each fixture runs through the test262 runner
// (standalone) and is compiled the same way to read the IR outcomes. Dot
// stores, assignment-as-value, compound stores and a store in a body with a
// dynamic method call (#7261) stay refused.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

const SLOPPY_BODY = `function put(obj, name, v) { obj[name] = v; }
function tryPut(obj, name, v) { try { obj[name] = v; } catch (e) { return false; } return true; }
var key = Symbol("k");
var o = {};
put(o, "a", 1);
put(o, 2, "two");
put(o, key, true);
assert.sameValue(o.a, 1);
assert.sameValue(o[2], "two");
assert.sameValue(o[key], true);
var frozen = Object.freeze({ a: 1 });
put(frozen, "a", 9);
assert.sameValue(frozen.a, 1, "sloppy store to a frozen object is ignored");
assert.sameValue(tryPut(frozen, "a", 9), true, "and does not throw");
assert.sameValue(tryPut(o, key, 3), true);
var seen = [];
var acc = { set q(v) { seen.push(v); } };
put(acc, "q", 7);
assert.sameValue(seen.length, 1);
assert.sameValue(seen[0], 7);
`;

const FIXTURES: Record<string, string> = {
  sloppy: `/*---\nflags: [noStrict]\n---*/\n${SLOPPY_BODY}`,
  strict: `/*---\nflags: [onlyStrict]\n---*/\nfunction put(obj, name, v) { obj[name] = v; }
function tryPut(obj, name, v) { try { obj[name] = v; } catch (e) { return false; } return true; }
var key = Symbol("k");
var o = {};
put(o, "a", 1);
put(o, 2, "two");
put(o, key, true);
assert.sameValue(o.a, 1);
assert.sameValue(o[2], "two");
assert.sameValue(o[key], true);
var frozen = Object.freeze({ a: 1 });
assert.throws(TypeError, function () { put(frozen, "a", 9); });
assert.sameValue(frozen.a, 1, "strict store left the value");
assert.sameValue(tryPut(frozen, "a", 9), false, "strict store throws");
assert.sameValue(tryPut(o, key, 3), true);
var seen = [];
var acc = { set q(v) { seen.push(v); } };
put(acc, "q", 7);
assert.sameValue(seen.length, 1);
assert.sameValue(seen[0], 7);
`,
  refused: `/*---\nflags: [noStrict]\n---*/
function dotStore(obj, v) { obj.k = v; }
function storeValue(obj, name, v) { return obj[name] = v; }
function compoundStore(obj, name, v) { obj[name] += v; }
function storeThenMethod(o, k, v) { o[k] = v; var r = o.f(); return r; }
function mk(n) { return { f: function () { return n; } }; }
var key = Symbol("k");
var o = { k: 0 };
dotStore(o, key); dotStore(o, "x"); dotStore(o, 1);
storeValue(o, "a", 1); storeValue(o, key, "s"); storeValue(o, 2, true);
compoundStore(o, "a", 1); compoundStore(o, key, "t"); compoundStore(o, 2, 3);
storeThenMethod(mk(1), "a", 1); storeThenMethod(mk(2), key, "s"); storeThenMethod(mk(3), 2, true);
`,
};

const dir = mkdtempSync(join(tmpdir(), "issue-7260-"));

function fixturePath(name: string): string {
  const path = join(dir, `${name}.js`);
  writeFileSync(path, FIXTURES[name]!);
  return path;
}

async function irOutcomes(path: string) {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const variant = assembleOriginalHarness(source, meta).primary;
  const result = await compile(variant.source, {
    ...originalHarnessCompileOptions(meta, "standalone"),
    fileName: path,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result.irOutcomes ?? [];
}

describe("#7260 dynamic-key element store on a dynamic local receiver", () => {
  for (const name of ["sloppy", "strict"]) {
    it(`IR-emits put and passes the ${name} fixture`, async () => {
      const path = fixturePath(name);
      const put = (await irOutcomes(path)).find((o) => o.displayName === "put");
      expect(put).toMatchObject({ kind: "emitted", irBodyEmitted: true });
      expect(await runTest262File(path, "issue-7260", undefined, "standalone")).toMatchObject({ status: "pass" });
    });
  }

  it("keeps dot stores, assignment-as-value and compound stores refused", async () => {
    const outcomes = await irOutcomes(fixturePath("refused"));
    for (const name of ["dotStore", "storeValue", "compoundStore", "storeThenMethod"]) {
      expect(outcomes.find((o) => o.displayName === name)?.irBodyEmitted, name).not.toBe(true);
    }
  });
});
