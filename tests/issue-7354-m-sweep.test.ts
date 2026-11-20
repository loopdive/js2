// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 M1 — the sweep of plan slice M §9: member operations over every receiver kind the carrier admits (numbers
// incl. NaN, -0, Infinity; booleans; strings; undefined; null; objects with and without the key, holding a string,
// undefined or an object), in a function, as a value, as a condition, unused, and at top level, each against node.
// A nullish receiver's TypeError is caught by a catch that does not read its binding ("T"). Keys a built-in prototype
// holds refuse by name (tests/issue-7354-m-refusals.test.ts). Then T, Ty, Str2-c and D1 again with `{}` among the
// operands. Programs are kept small: compile time grows steeply with the number of try blocks.
import { afterEach, describe, it, vi } from "vitest";
import { agreesWithNode } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const RECEIVERS = [
  "1",
  "NaN",
  "-0",
  "Infinity",
  "true",
  '""',
  '"abc"',
  "undefined",
  "null",
  "{}",
  "{k:1}",
  '{k:"s"}',
  "{k:undefined}",
  "{k:{}}",
];

const OPERATIONS: readonly (readonly [string, string])[] = [
  ["read .k", "function op(v){ return String(v.k); }"],
  ['read ["name"]', 'function op(v){ return String(v["name"]); }'],
  ["write .message then read", "function op(v){ v.message = 7; return String(v.message); }"],
  ["typeof v.k", "function op(v){ return typeof v.k; }"],
  ["v.name === undefined", 'function op(v){ return v.name === undefined ? "t" : "f"; }'],
  ['"" + v.k', 'function op(v){ return "" + v.k; }'],
  ["Object.prototype.toString.call(v)", "function op(v){ return Object.prototype.toString.call(v); }"],
  ["v.k as a condition", 'function op(v){ if (v.k) return "y"; return "n"; }'],
  ["v.name unused", 'function op(v){ v.name; return "u"; }'],
  ["v.k || v.name as a value", "function op(v){ return String(v.k || v.name); }"],
];

const overReceivers = (operation: string) =>
  ['var out = "";', operation]
    .concat(RECEIVERS.map((r) => `try { out = out + op(${r}) + ","; } catch (e) { out = out + "T,"; }`))
    .join("\n");

const TOP_LEVEL = ['var out = "";', "function id(x){ return x; }", "var v = id(0);"]
  .concat(
    RECEIVERS.flatMap((r) => [
      `v = id(${r});`,
      'try { if (v.k) out = out + "y"; else out = out + String(v.name) + ","; } catch (e) { out = out + "T,"; }',
    ]),
  )
  .join("\n");

// T (ToBoolean), Ty (`typeof` comparisons), Str2-c (`+`) and D1 (`===`) with an object operand on either side.
const OPERANDS = ["1", "NaN", "-0", "true", '""', '"a"', "undefined", "null", "{}"];
const WITH_OBJECTS = [
  'var out = "";',
  "function add(a, b){ return String(a + b); }",
  'function eq(a, b){ return a === b ? "1" : "0"; }',
  'function t(a){ return (!a ? "1" : "0") + (typeof a === "object" ? "o" : "-"); }',
  "var o = {};",
]
  .concat(OPERANDS.map((x) => `out = out + add(${x}, {}) + add({}, ${x}) + eq(${x}, o) + eq(o, ${x}) + t(${x}) + ",";`))
  .join("\n");

describe("#7354 M1 — the member-access sweep against node", () => {
  it.each(OPERATIONS)("in a function: %s over every receiver kind", (_name, operation) =>
    agreesWithNode(overReceivers(operation), false),
  );
  it("at top level: a script var holding each receiver kind in turn", () => agreesWithNode(TOP_LEVEL, false));
  it("re-sweeps ToBoolean, typeof, + and === with an object operand", () => agreesWithNode(WITH_OBJECTS, false));
}, 300_000);
