// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6938 — a declaration-level JSDoc `@param {Packet}` on a top-level function
// made `ensureStructForType` (eager parameter-type registration in
// `collectDeclarations`) mint a phantom `__anon_N` struct for the instance type
// of function-constructor `Packet`. That struct is never allocated (instances
// are `$__fnctor_Packet` / externref), so every slot typed by it guard-cast the
// real instance to null, and the member store `next.link = this` on an
// unpinned receiver pinned to it and threw (gc) / trapped (standalone).
// Octane richards (#874) hit exactly this.
//
// Fix: `isFnctorInstanceType` (fnctor-instance-names.ts) is shared by
// `resolveWasmType` and `ensureStructForType` (which now never registers such
// a type), and `resolveStructName` answers a fnctor instance type in lockstep
// with `resolveWasmType` (the reserved `__fnctor_<Name>` struct for an approved
// standalone fnctor, otherwise no struct, i.e. the dynamic path).
//
// Every fixture is real JS compiled through the public `compile()` with
// `allowJs`, run on the gc host and standalone lanes, and compared against
// node evaluating the same source.

import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

type Lane = "gc" | "standalone";

function nodeOracle(src: string): unknown {
  const body = src.replace(/^export function main/m, "function main") + "\nreturn main();";
  return new Function(body)();
}

async function runLane(src: string, lane: Lane): Promise<unknown> {
  const result = await compile(src, {
    fileName: "fixture.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  if (!result.success) throw new Error(`compile failed: ${result.errors.map((e) => e.message).join(" | ")}`);
  let exports: Record<string, unknown>;
  if (lane === "standalone") {
    const mod = await WebAssembly.compile(result.binary);
    exports = (await WebAssembly.instantiate(mod, {})).exports as Record<string, unknown>;
  } else {
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setInstance?.(instance);
    exports = instance.exports as Record<string, unknown>;
  }
  return (exports.main as () => unknown)();
}

async function expectAllLanes(src: string, expected: unknown): Promise<void> {
  expect(nodeOracle(src)).toBe(expected);
  for (const lane of ["gc", "standalone"] as const) {
    expect(await runLane(src, lane), lane).toBe(expected);
  }
}

/** `.tmp/6938/r11.js` (triage minimization), verbatim. */
const R11 = `// Minimized from Octane richards.js (#874): Packet.prototype.addTo traps at
// \`next.link = this\` although \`next == null\` was false one line earlier.
/** @param {Packet} queue */
function TaskControlBlock(queue) {
  this.queue = queue;
}

function HandlerTask() {
  this.v1 = null;
}
HandlerTask.prototype.run = function (packet) {
  this.v1 = packet.addTo(this.v1);
};

function Packet(id) {
  this.link = null;
  this.id = id;
}
/** @param {Packet} queue */
Packet.prototype.addTo = function (queue) {
  this.link = null;
  if (queue == null) return this;
  var next = queue;
  while (next.link != null) next = next.link;
  next.link = this;
  return queue;
};

export function main() {
  var h = new HandlerTask();
  h.run(new Packet(1));
  h.run(new Packet(2));
  return h.v1.link.id;
}
`;

/** `.tmp/6938/r15.js` — kind-routed queues + richards' peek/next loop, verbatim. */
const R15 = `/** @param {Packet} queue */
function TaskControlBlock(queue) {
  this.queue = queue;
}
function HandlerTask() {
  this.v1 = null;
  this.v2 = null;
}
HandlerTask.prototype.run = function (packet) {
  if (packet.kind == 1) {
    this.v1 = packet.addTo(this.v1);
  } else {
    this.v2 = packet.addTo(this.v2);
  }
  if (this.v1 != null && this.v1.kind == 7) {
    this.v1 = this.v1.link;
  }
};
function Packet(id, kind) {
  this.link = null;
  this.id = id;
  this.kind = kind;
}
/** @param {Packet} queue */
Packet.prototype.addTo = function (queue) {
  this.link = null;
  if (queue == null) return this;
  var peek, next = queue;
  while ((peek = next.link) != null)
    next = peek;
  next.link = this;
  return queue;
};
export function main() {
  var h = new HandlerTask();
  h.run(new Packet(1, 1));
  h.run(new Packet(2, 1));
  h.run(new Packet(3, 1));
  return h.v1.link.link.id;
}
`;

/** Declaration-level annotation on the fnctor's OWN ctor param (richards.js:512). */
const SELF_LINK = `/** @param {Packet} link */
function Packet(link, id) {
  this.link = link;
  this.id = id;
}
/** @param {Packet} queue */
Packet.prototype.addTo = function (queue) {
  this.link = null;
  if (queue == null) return this;
  var peek, next = queue;
  while ((peek = next.link) != null) next = peek;
  next.link = this;
  return queue;
};
function H() { this.v1 = null; }
H.prototype.run = function (packet) { this.v1 = packet.addTo(this.v1); };
export function main() {
  var h = new H();
  var q = new Packet(null, 1);
  q = new Packet(q, 2);
  h.run(q);
  h.run(new Packet(null, 3));
  var n = 0, p = h.v1;
  while (p != null) { n = n * 10 + p.id; p = p.link; }
  return n;
}
`;

/**
 * Unpinned receiver of an approved standalone fnctor: `this.s.suspend()` where
 * `s` is checker-typed by a declaration-level annotation. The phantom struct
 * used to route this through compileCallablePropertyCall's fnctor dynamic
 * dispatch by accident; with it gone, `resolveStructName` must hand back
 * `__fnctor_Sched` or the call falls to the graceful tail and answers
 * undefined on standalone (measured: `main -> 0`).
 */
const UNPINNED_METHOD_CALL = `/** @param {Sched} s */
function Task(s) { this.s = s; }
Task.prototype.run = function () { return this.s.suspend(); };
function Sched() { this.cur = null; this.n = 0; }
Sched.prototype.suspend = function () { this.n++; return this.cur; };
Sched.prototype.add = function (t) { this.cur = t; };
export function main() { var s = new Sched(); var t = new Task(s); s.add(t); var r = t.run(); return s.n + (r === t ? 10 : 0); }
`;

/** Same call, receiver typed by inference only (no annotation, no phantom ever). */
const UNPINNED_METHOD_CALL_INFERRED = `function Task(s) { this.s = new Sched(); this.s.add(this); }
Task.prototype.run = function () { return this.s.suspend(); };
function Sched() { this.cur = null; this.n = 0; }
Sched.prototype.suspend = function () { this.n++; return this.cur; };
Sched.prototype.add = function (t) { this.cur = t; };
export function main() { var t = new Task(); var r = t.run(); return t.s.n + (r === t ? 10 : 0); }
`;

describe("#6938 fnctor instance type never becomes a phantom anon struct", () => {
  it("r11: member store through an unpinned Packet receiver (gc + standalone)", async () => {
    await expectAllLanes(R11, 2);
  });

  it("r15: richards addTo loop, kind-routed queues (gc + standalone)", async () => {
    await expectAllLanes(R15, 3);
  });

  it("ctor-level @param {Packet} on Packet's own link field (gc + standalone)", async () => {
    await expectAllLanes(SELF_LINK, 23);
  });

  it("method call on an unpinned, annotation-typed approved fnctor receiver", async () => {
    await expectAllLanes(UNPINNED_METHOD_CALL, 11);
  });

  it("method call on an unpinned, inference-typed approved fnctor receiver", async () => {
    await expectAllLanes(UNPINNED_METHOD_CALL_INFERRED, 11);
  });

  it("no __anon struct carrying a fnctor's prototype method names is registered", async () => {
    for (const target of [undefined, "standalone" as const]) {
      const result = await compile(R11, {
        fileName: "fixture.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
        emitWat: true,
        ...(target ? { target } : {}),
      });
      expect(result.success).toBe(true);
      const anonWithAddTo = result.wat
        .split("\n")
        .filter((l) => /\(type \$__anon_\d+ \(struct/.test(l) && /\$addTo\b/.test(l));
      expect(anonWithAddTo, String(target ?? "gc")).toEqual([]);
    }
  });
});

describe("#6938 negative controls", () => {
  it("r11 without the declaration-level JSDoc", async () => {
    await expectAllLanes(
      R11.replace("/** @param {Packet} queue */\nfunction TaskControlBlock", "function TaskControlBlock"),
      2,
    );
  });

  it("r11 without the method-level JSDoc", async () => {
    await expectAllLanes(
      R11.replace("/** @param {Packet} queue */\nPacket.prototype.addTo", "Packet.prototype.addTo"),
      2,
    );
  });

  it("non-fnctor anon-struct param: stores through an annotated object-literal type still work", async () => {
    await expectAllLanes(
      `/** @param {{ x: number, y: number }} o */
function bump(o) { o.x = o.x + o.y; return o; }
export function main() {
  var a = { x: 1, y: 2 };
  bump(a);
  var b = bump({ x: 10, y: 5 });
  return a.x * 100 + b.x;
}
`,
      315,
    );
  });

  it("a class named Packet keeps its own struct", async () => {
    await expectAllLanes(
      `class Packet {
  constructor(id) { this.link = null; this.id = id; }
  /** @param {Packet} queue */
  addTo(queue) {
    this.link = null;
    if (queue == null) return this;
    var next = queue;
    while (next.link != null) next = next.link;
    next.link = this;
    return queue;
  }
}
/** @param {Packet} q */
function first(q) { return q.id; }
export function main() {
  var q = new Packet(1).addTo(null);
  q = new Packet(2).addTo(q);
  return first(q) * 10 + q.link.id;
}
`,
      12,
    );
  });

  it("fnctor instances passed through annotated params keep their fields", async () => {
    await expectAllLanes(
      `/** @param {Point} p */
function norm1(p) { return Math.abs(p.x) + Math.abs(p.y); }
function Point(x, y) { this.x = x; this.y = y; }
Point.prototype.scale = function (k) { this.x = this.x * k; this.y = this.y * k; return this; };
export function main() {
  var p = new Point(-2, 3);
  p.scale(2);
  return norm1(p);
}
`,
      10,
    );
  });
});
