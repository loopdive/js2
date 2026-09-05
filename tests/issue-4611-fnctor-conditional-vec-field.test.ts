// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4611 — a conditional fnctor-ctor write of an array value must land on the
// struct FIELD, not a marshalled JS-array copy in the host sidecar. The generic
// vec→externref coercion appends `__make_iterable`, whose copy fails the
// member-set dispatcher's element ref.test and silently demotes the write to
// the sidecar — splitting the field across three storages (acorn's
// `this.range = [pos, 0]` under `if (options.ranges)`: ctor write → sidecar
// copy, `node.range[1] = pos` → struct-field null receiver no-op, final read →
// struct field null).

import { describe, it } from "vitest";

import { assertEquivalent } from "./equivalence/helpers.js";

describe("#4611 fnctor conditional vec field writes", () => {
  it("keeps the acorn ranges shape on one storage (ctor write, element write, read)", async () => {
    await assertEquivalent(
      `var Node = function Node(parser, pos) {
         this.type = "";
         this.start = pos;
         this.end = 0;
         if (parser.options.ranges) { this.range = [pos, 0]; }
       };
       var Parser = function Parser(options) { this.options = options; };
       var pp = Parser.prototype;
       function finishNodeAt(node, type, pos) {
         node.type = type; node.end = pos;
         if (this.options.ranges) { node.range[1] = pos; }
         return node;
       }
       pp.startNode = function(pos) { return new Node(this, pos); };
       pp.finishNode = function(node, type, pos) { return finishNodeAt.call(this, node, type, pos); };
       export function test(): string {
         const p = new Parser({ ranges: true });
         const n = p.startNode(4);
         p.finishNode(n, "X", 9);
         const off = new Parser({ ranges: false });
         const m = off.startNode(2);
         off.finishNode(m, "Y", 7);
         // NOTE: \`m.range === undefined\` is deliberately NOT asserted — an
         // unwritten presence-tracked field reads null (not undefined) in host
         // mode, a pre-existing gap verified identical on the unmodified base
         // (presence-bits family, #3780), unrelated to this issue's fix.
         return JSON.stringify([n.end, n.range, m.end, m.range == null]);
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("unconditional ctor array field keeps working", async () => {
    await assertEquivalent(
      `var Box = function Box(a, b) { this.pair = [a, b]; };
       export function test(): string {
         const box = new Box(3, 5);
         box.pair[0] = 8;
         return JSON.stringify(box.pair);
       }`,
      [{ fn: "test", args: [] }],
    );
  });
});
