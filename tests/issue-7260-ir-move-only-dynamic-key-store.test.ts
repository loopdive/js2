// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7260 — the move-only scan admits a statement-position element store on a
// dynamic LOCAL receiver (`obj[name] = v`, as in propertyHelper's
// isWritable), lowered through `dyn.member_set` with the function code's
// PutValue failure rule: a sloppy store to a frozen object is ignored, a
// strict one throws TypeError. Each fixture runs through the test262 runner
// (standalone) and is compiled the same way to read the IR outcomes. Dot
// stores, assignment-as-value, compound stores and a store in a body with a
// dynamic method call (#7261) stay refused. Strict function code stays
// refused too: the strict `__dyn_member_set` throws for exotic receivers
// (arrays out of bounds, typed arrays, Map, …) where legacy stores (#7107
// review). The receiver matrix pins base == head on gc and standalone.
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

// Receiver matrix (#7107 review). Each row is recorded as `label=value`; the
// fixture always throws the joined row list, which the test compares.
const MATRIX_BODY = `function put(obj, name, v) { obj[name] = v; }
put({}, Symbol(), null);
var out = [];
function t(label, f) { try { out.push(label + "=" + f()); } catch (e) { out.push(label + "=THROW:" + e.constructor.name); } }
t("arr0", function () { var a = [1, 2, 3]; put(a, 0, 9); return a[0]; });
t("arr10", function () { var a = [1]; put(a, 10, 1); return a.length; });
t("arrStr", function () { var a = [1, 2]; put(a, "1", 5); return a[1]; });
t("arrLen", function () { var a = [1, 2, 3]; put(a, "length", 1); return a.length; });
t("u8", function () { var u = new Uint8Array(2); put(u, 0, 300); return u[0]; });
t("u8str", function () { var u = new Uint8Array(2); put(u, "1", 7); return u[1]; });
t("u8oob", function () { var u = new Uint8Array(2); put(u, 5, 1); return u[5]; });
t("f64", function () { var u = new Float64Array(1); put(u, 0, 1.5); return u[0]; });
t("map", function () { var m = new Map(); put(m, "x", 1); return m.x; });
t("date", function () { var d = new Date(0); put(d, "x", 2); return d.x; });
t("err", function () { var e = new Error("a"); put(e, "message", "n"); return e.message; });
t("dv", function () { var d = new DataView(new ArrayBuffer(2)); put(d, "x", 3); return d.x; });
t("ab", function () { var b = new ArrayBuffer(2); put(b, "x", 4); return b.x; });
t("obj", function () { var o = {}; put(o, "x", 5); return o.x; });
t("frozen", function () { var o = Object.freeze({ x: 1 }); put(o, "x", 6); return o.x; });
t("fn", function () { var f = function () {}; put(f, "x", 7); return f.x; });
t("re", function () { var r = /a/; put(r, "x", 8); return r.x; });
throw new Test262Error(out.join(" "));
`;
const SLOPPY_MATRIX =
  "arr0=9 arr10=11 arrStr=5 arrLen=1 u8=44 u8str=7 u8oob=0 f64=1.5 map=null date=2 err=a dv=3 ab=4 obj=5 frozen=1 fn=7 re=8";
const STRICT_MATRIX = SLOPPY_MATRIX.replace("frozen=1", "frozen=THROW:TypeError");
// The #3795 conflict-marker store in sloppy code: a failed [[Set]] is ignored, as in legacy and JS.
const MARK_BODY = `function mark(o, k) { o[k] = "true"; }
mark({}, Symbol()); mark([], 0);
var out = [];
function t(label, f) { try { out.push(label + "=" + f()); } catch (e) { out.push(label + "=THROW:" + e.constructor.name); } }
t("obj", function () { var o = {}; mark(o, "a"); return o.a; });
t("frozen", function () { var o = Object.freeze({ a: 1 }); mark(o, "a"); return o.a; });
t("nonwritable", function () { var o = {}; Object.defineProperty(o, "a", { value: 1 }); mark(o, "a"); return o.a; });
t("getter", function () { var o = { get a() { return 2; } }; mark(o, "a"); return o.a; });
t("arr", function () { var a = [1]; mark(a, 0); return a[0]; });
throw new Test262Error(out.join(" "));
`;
const REVIEW_REPRO = `function put(obj, name, v) { obj[name] = v; }
put({}, Symbol(), null);
var a = [1, 2, 3];
put(a, 0, 9);
assert.sameValue(a[0], 9);
`;

const dir = mkdtempSync(join(tmpdir(), "issue-7260-"));

function writeFixture(name: string, flag: string, body: string): string {
  const path = join(dir, `${name}.js`);
  writeFileSync(path, `/*---\nflags: [${flag}]\n---*/\n${body}`);
  return path;
}

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
  for (const [name, claimed] of [
    ["sloppy", true],
    ["strict", false],
  ] as const) {
    it(`${claimed ? "IR-emits" : "keeps legacy"} put and passes the ${name} fixture`, async () => {
      const path = fixturePath(name);
      const put = (await irOutcomes(path)).find((o) => o.displayName === "put");
      expect(put?.irBodyEmitted).toBe(claimed);
      expect(await runTest262File(path, "issue-7260", undefined, "standalone")).toMatchObject({ status: "pass" });
    });
  }

  for (const target of ["standalone", undefined] as const) {
    const lane = target ?? "gc";
    it(`runs the sloppy receiver matrix through the IR store on ${lane}`, async () => {
      const path = writeFixture(`matrix-sloppy-${lane}`, "noStrict", MATRIX_BODY);
      expect((await irOutcomes(path)).find((o) => o.displayName === "put")?.irBodyEmitted).toBe(true);
      expect((await runTest262File(path, "issue-7260", undefined, target)).error).toContain(SLOPPY_MATRIX);
    });

    it(`keeps strict code on legacy for the receiver matrix on ${lane}`, async () => {
      const path = writeFixture(`matrix-strict-${lane}`, "onlyStrict", MATRIX_BODY);
      expect((await irOutcomes(path)).find((o) => o.displayName === "put")?.irBodyEmitted).not.toBe(true);
      expect((await runTest262File(path, "issue-7260", undefined, target)).error).toContain(STRICT_MATRIX);
      const repro = writeFixture(`review-repro-${lane}`, "onlyStrict", REVIEW_REPRO);
      expect(await runTest262File(repro, "issue-7260", undefined, target)).toMatchObject({ status: "pass" });
    });

    it(`ignores a failed sloppy #3795 conflict-marker store on ${lane}`, async () => {
      const path = writeFixture(`mark-${lane}`, "noStrict", MARK_BODY);
      expect((await irOutcomes(path)).find((o) => o.displayName === "mark")?.irBodyEmitted).toBe(true);
      expect((await runTest262File(path, "issue-7260", undefined, target)).error).toContain(
        "obj=true frozen=1 nonwritable=1 getter=2",
      );
    });
  }

  it("keeps dot stores, assignment-as-value and compound stores refused", async () => {
    const outcomes = await irOutcomes(fixturePath("refused"));
    for (const name of ["dotStore", "storeValue", "compoundStore", "storeThenMethod"]) {
      expect(outcomes.find((o) => o.displayName === name)?.irBodyEmitted, name).not.toBe(true);
    }
  });
});
