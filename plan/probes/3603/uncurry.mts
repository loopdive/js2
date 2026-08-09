/**
 * Focused two-lane check of the uncurryThis family used by propertyHelper.js.
 * Uses runTest262File so the HOST lane gets its real import object.
 *
 * Run: npx tsx .tmp/vp/uncurry.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTest262File } from "../../../tests/test262-runner.ts";

const OUT = join(import.meta.dirname!, "uncurry-cases");
mkdirSync(OUT, { recursive: true });

const HEADER = `/*---
description: uncurryThis probe
includes: [propertyHelper.js]
flags: [noStrict]
---*/
`;

const cases: { name: string; body: string; expect: "pass" | "fail" }[] = [
  {
    name: "uncurried-push-works",
    expect: "pass",
    body: `var arr = [];
__push(arr, "x");
assert.sameValue(arr.length, 1, "uncurried __push must append");`,
  },
  {
    name: "uncurried-join-works",
    expect: "pass",
    body: `assert.sameValue(__join(["a", "b"], ";"), "a;b", "uncurried __join must join");`,
  },
  {
    name: "uncurried-hasown-objlit",
    expect: "pass",
    body: `var o = { a: 1 };
assert.sameValue(__hasOwnProperty(o, "a"), true, "uncurried __hasOwnProperty on an object literal");`,
  },
  {
    name: "uncurried-hasown-desc-shape",
    expect: "pass",
    body: `var d = { value: 1, writable: true, enumerable: true, configurable: true };
assert.sameValue(__hasOwnProperty(d, "value"), true, "uncurried __hasOwnProperty(desc,'value')");`,
  },
  {
    name: "failure-accumulation-end-to-end",
    expect: "pass",
    body: `var failures = [];
__push(failures, "boom");
assert.sameValue(failures.length, 1, "failures must accumulate");
assert.sameValue(__join(failures, "; "), "boom", "failures must render");`,
  },
  {
    name: "runtime-hasown-via-any-param",
    expect: "pass",
    body: `function ho(a, b) { return Object.prototype.hasOwnProperty.call(a, b); }
var o = { a: 1 };
assert.sameValue(ho(o, "a"), true, "runtime hasOwnProperty on an object literal");`,
  },
  {
    name: "runtime-keys-via-any-param",
    expect: "pass",
    body: `function ks(a) { return Object.keys(a).length; }
var o = { a: 1, b: 2 };
assert.sameValue(ks(o), 2, "runtime Object.keys on an object literal");`,
  },
  {
    name: "runtime-forin-via-any-param",
    expect: "pass",
    body: `function fi(a) { var n = 0; for (var k in a) { n++; } return n; }
var o = { a: 1, b: 2 };
assert.sameValue(fi(o), 2, "runtime for-in over an object literal");`,
  },
  {
    name: "push-then-join-discriminator",
    expect: "pass",
    body: `var failures = [];
__push(failures, "boom");
assert.sameValue(__join(failures, ";"), "boom", "join sees the pushed element");`,
  },
  {
    name: "push-then-index0-discriminator",
    expect: "pass",
    body: `var failures = [];
__push(failures, "boom");
assert.sameValue(failures[0], "boom", "index 0 sees the pushed element");`,
  },
  {
    name: "native-push-control",
    expect: "pass",
    body: `var arr = [];
arr.push("x");
assert.sameValue(arr.length, 1, "native push must append");`,
  },
];

for (const c of cases) {
  const file = join(OUT, `${c.name}.js`);
  writeFileSync(file, HEADER + c.body + "\n");
  const cells: string[] = [];
  for (const lane of [undefined, "standalone"] as const) {
    let status = "??";
    let err = "";
    try {
      const r = await runTest262File(file, "probe", 30000, lane);
      status = r.status;
      err = String((r as any).error ?? "");
    } catch (e) {
      status = "THREW";
      err = String(e);
    }
    cells.push(`${(lane ?? "host").padEnd(10)}=${status.padEnd(13)}${err ? ` :: ${err.replace(/\s+/g, " ").slice(0, 90)}` : ""}`);
  }
  console.log(c.name.padEnd(34), "|", cells.join("  |  "));
}
