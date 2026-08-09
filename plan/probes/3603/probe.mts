/**
 * verifyProperty vacuity probe — A/B wrong-expectation control.
 *
 * For each (subject, key) we build a set of variants where exactly ONE
 * descriptor field is deliberately WRONG. A correct engine + correct harness
 * must FAIL every wrong variant and PASS the control variant.
 *
 * Run: npx tsx .tmp/vp/probe.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTest262File } from "../../../tests/test262-runner.ts";

const OUT = join(import.meta.dirname!, "cases");
mkdirSync(OUT, { recursive: true });

const HEADER = `/*---
description: verifyProperty vacuity probe
includes: [propertyHelper.js]
flags: [noStrict]
---*/
`;

type Case = { name: string; body: string; expect: "pass" | "fail" };

const cases: Case[] = [
  // --- Math.abs.name / .length (builtin function props) ---
  {
    name: "abs-name-correct",
    expect: "pass",
    body: `verifyProperty(Math.abs, "name", { value: "abs", writable: false, enumerable: false, configurable: true });`,
  },
  {
    name: "abs-name-wrong-value",
    expect: "fail",
    body: `verifyProperty(Math.abs, "name", { value: "SHOULD_NOT_MATCH", writable: false, enumerable: false, configurable: true });`,
  },
  {
    name: "abs-name-wrong-writable",
    expect: "fail",
    body: `verifyProperty(Math.abs, "name", { value: "abs", writable: true, enumerable: false, configurable: true });`,
  },
  {
    name: "abs-name-wrong-enumerable",
    expect: "fail",
    body: `verifyProperty(Math.abs, "name", { value: "abs", writable: false, enumerable: true, configurable: true });`,
  },
  {
    name: "abs-name-wrong-configurable",
    expect: "fail",
    body: `verifyProperty(Math.abs, "name", { value: "abs", writable: false, enumerable: false, configurable: false });`,
  },
  {
    name: "abs-length-wrong-value",
    expect: "fail",
    body: `verifyProperty(Math.abs, "length", { value: 999, writable: false, enumerable: false, configurable: true });`,
  },
  {
    name: "abs-missing-key",
    expect: "fail",
    body: `verifyProperty(Math.abs, "no_such_prop_zz", { value: 1 });`,
  },

  // --- plain object literal, plain data property ---
  {
    name: "plain-correct",
    expect: "pass",
    body: `var o = { a: 1 };
verifyProperty(o, "a", { value: 1, writable: true, enumerable: true, configurable: true });`,
  },
  {
    name: "plain-wrong-value",
    expect: "fail",
    body: `var o = { a: 1 };
verifyProperty(o, "a", { value: 42, writable: true, enumerable: true, configurable: true });`,
  },
  {
    name: "plain-wrong-writable",
    expect: "fail",
    body: `var o = { a: 1 };
verifyProperty(o, "a", { value: 1, writable: false, enumerable: true, configurable: true });`,
  },
  {
    name: "plain-wrong-enumerable",
    expect: "fail",
    body: `var o = { a: 1 };
verifyProperty(o, "a", { value: 1, writable: true, enumerable: false, configurable: true });`,
  },
  {
    name: "plain-wrong-configurable",
    expect: "fail",
    body: `var o = { a: 1 };
verifyProperty(o, "a", { value: 1, writable: true, enumerable: true, configurable: false });`,
  },
  {
    name: "plain-missing-key",
    expect: "fail",
    body: `var o = { a: 1 };
verifyProperty(o, "zz", { value: 1 });`,
  },

  // --- value-only descriptor (isolates the value branch) ---
  {
    name: "plain-valueonly-correct",
    expect: "pass",
    body: `var o = { a: 1 };
verifyProperty(o, "a", { value: 1 });`,
  },
  {
    name: "plain-valueonly-wrong",
    expect: "fail",
    body: `var o = { a: 1 };
verifyProperty(o, "a", { value: 42 });`,
  },

  // --- sanity: raw assert must be live ---
  {
    name: "sanity-assert-false",
    expect: "fail",
    body: `assert(false, "sanity");`,
  },
  {
    name: "sanity-assert-sameValue-3arg",
    expect: "fail",
    body: `assert.sameValue(1, 2, "sanity");`,
  },
];

const lanes: { label: string; target?: "standalone" }[] = [
  { label: "host", target: undefined },
  { label: "standalone", target: "standalone" },
];

const rows: string[] = [];
for (const c of cases) {
  const file = join(OUT, `${c.name}.js`);
  writeFileSync(file, HEADER + c.body + "\n");
  const cells: string[] = [];
  for (const lane of lanes) {
    let status = "??";
    let err = "";
    try {
      const r = await runTest262File(file, "probe", 30000, lane.target);
      status = r.status;
      err = (r as any).error ?? "";
    } catch (e) {
      status = "THREW";
      err = String(e);
    }
    const verdict = status === "pass" ? "pass" : status === "skip" ? "skip" : "fail";
    const ok = verdict === c.expect ? "OK " : verdict === "pass" ? "VACUOUS" : "MISMATCH";
    cells.push(`${lane.label}=${status}[${ok}]${err ? ` :: ${String(err).slice(0, 140)}` : ""}`);
  }
  rows.push(`${c.name.padEnd(30)} expect=${c.expect.padEnd(5)} ${cells.join("  |  ")}`);
  console.log(rows[rows.length - 1]);
}
