// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7354 M1) The member-access sweep of plan slice M §9, split over tests/issue-7354-m-sweep-{1,2,3}.test.ts so each
// file stays within CI's per-file time (every program compiles the realm, ~20-60 s with the validator on).
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

const overReceivers = (operation: string, receivers: readonly string[]) =>
  ['var out = "";', operation]
    .concat(receivers.map((r) => `try { out = out + op(${r}) + ","; } catch (e) { out = out + "T,"; }`))
    .join("\n");

const topLevel = (receivers: readonly string[]) =>
  ['var out = "";', "function id(x){ return x; }", "var v = id(0);"]
    .concat(
      receivers.flatMap((r) => [
        `v = id(${r});`,
        'try { if (v.k) out = out + "y"; else out = out + String(v.name) + ","; } catch (e) { out = out + "T,"; }',
      ]),
    )
    .join("\n");

/**
 * Each program covers half the receivers: one compile must stay well under a minute, or the blocked vitest worker
 * misses its RPC deadline.
 */
const HALVES = [
  ["the primitives", RECEIVERS.slice(0, 7)],
  ["undefined, null and the objects", RECEIVERS.slice(7)],
] as const;

/** [name, program] for every operation over each half of the receivers. */
export const SWEEP_CASES: readonly (readonly [string, string])[] = [
  ...OPERATIONS.flatMap(([name, operation]) =>
    HALVES.map(
      ([half, receivers]) => [`in a function: ${name} over ${half}`, overReceivers(operation, receivers)] as const,
    ),
  ),
];

/** A script var at top level holding each receiver in turn, a quarter of the receivers per program. */
export const TOP_LEVEL_CASES: readonly (readonly [string, string])[] = [0, 4, 8, 11].map(
  (from, index, starts) =>
    [
      `at top level: a script var holding ${RECEIVERS.slice(from, starts[index + 1]).join(", ")} in turn`,
      topLevel(RECEIVERS.slice(from, starts[index + 1])),
    ] as const,
);

// T (ToBoolean), Ty (`typeof` comparisons), Str2-c (`+`) and D1 (`===`) with an object operand on either side.
const OPERANDS = ["1", "NaN", "-0", "true", '""', '"a"', "undefined", "null", "{}"];
const withObjects = (operands: readonly string[]) =>
  [
    'var out = "";',
    "function add(a, b){ return String(a + b); }",
    'function eq(a, b){ return a === b ? "1" : "0"; }',
    'function t(a){ return (!a ? "1" : "0") + (typeof a === "object" ? "o" : "-"); }',
    "var o = {};",
  ]
    .concat(
      operands.map((x) => `out = out + add(${x}, {}) + add({}, ${x}) + eq(${x}, o) + eq(o, ${x}) + t(${x}) + ",";`),
    )
    .join("\n");

/** T (ToBoolean), Ty (`typeof`), Str2-c (`+`) and D1 (`===`) with an object operand on either side, in two programs. */
export const WITH_OBJECTS_CASES: readonly (readonly [string, string])[] = [OPERANDS.slice(0, 5), OPERANDS.slice(5)].map(
  (operands) =>
    [`ToBoolean, typeof, + and === of ${operands.join(", ")} beside an object`, withObjects(operands)] as const,
);
