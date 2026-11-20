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
import { SWEEP_CASES } from "./helpers/member-access-sweep.js";

afterEach(() => vi.restoreAllMocks());

describe("#7354 M1 — the member-access sweep against node, part 3", () => {
  it.each(SWEEP_CASES.slice(14))("%s", (_name, program) => agreesWithNode(program, false));
}, 300_000);
