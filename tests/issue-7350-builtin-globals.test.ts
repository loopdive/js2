// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7350 G1 — one admission for a built-in global read as a value
// (`src/ir/builtin-globals.ts`): the namespaces and global functions beyond
// #7118's names are read off the realm on standalone, in the positions the
// alias walk follows; a write to the name, an enclosing `with` body, a member
// read through an alias and a bare `null` beside the value stay refused at
// select. The JS environment keeps main's routing for the new names.

import { describe, expect, it } from "vitest";

import { runModuleInit } from "./helpers/ambient-intrinsic-probe.js";

const run = (target: "standalone" | undefined, source: string) =>
  runModuleInit(target, source, { fileName: "issue-7350-builtin-globals.js" });

const NEW_NAMES = ["Math", "JSON", "Date", "RegExp", "parseInt", "isNaN", "encodeURIComponent", "unescape"];

/** Each throws unless the read answers as node does. */
const CLAIMED: Record<string, string> = {
  ...Object.fromEntries(
    NEW_NAMES.flatMap((name) => [
      [`${name}: identity through an alias`, `var a = ${name}; if (a !== ${name}) { throw "i"; }`],
      [`${name}: truthiness`, `if (!${name}) { throw "t"; }`],
      [`${name}: a same-file parameter`, `function id(x) { return x === ${name}; } if (!id(${name})) { throw "p"; }`],
    ]),
  ),
  "a with statement elsewhere in the file": `function g(o) { with (o) { return 1; } } if (!Math) { throw "w"; }`,
};

/** Each stays refused at select on standalone (never claimed, then withdrawn). */
const REFUSED: Record<string, string> = {
  "a member read through an alias": `var M = Math; if (M.max(1, 2) !== 2) { throw "m"; }`,
  "the name written": `function w() { Math = 5; } if (!Math) { throw "w"; }`,
  // A unit that contains a `with` statement is never claimed (`body-shape-rejected`), so no admission check is
  // needed for a read inside the body.
  "a unit containing a with statement": `var o = { Math: 3 }; var r; with (o) { r = Math === 3; } if (!r) { throw "b"; }`,
  "a loose compare with null": `if (Math == null) { throw "n"; }`,
  "a conditional beside null": `var c = 1; var v = c ? JSON : null; if (v !== JSON) { throw "c"; }`,
};

describe("#7350 G1 — a built-in global read as a value", () => {
  for (const [name, source] of Object.entries(CLAIMED)) {
    it(`claims <module-init> on standalone and answers as node: ${name}`, async () => {
      expect(() => new Function(source)()).not.toThrow();
      expect(await run("standalone", source)).toEqual({ claimed: true, threw: false });
    });
  }

  for (const [name, source] of Object.entries(REFUSED)) {
    it(`refuses <module-init> at select on standalone: ${name}`, async () => {
      expect(() => new Function(source)()).not.toThrow();
      expect(await run("standalone", source)).toEqual({ claimed: false, threw: false });
    });
  }

  it("keeps the JS environment's routing for the new names", async () => {
    expect(await run(undefined, `var a = Math; if (a !== Math) { throw "i"; }`)).toEqual({
      claimed: false,
      threw: false,
    });
  });
});
