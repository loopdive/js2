// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6787 — `Array.prototype.push` read the receiver's `length` before it
// evaluated its argument, so an argument that pushed onto (or popped from) the
// same array was overwritten. The fix evaluates the arguments first — but only
// pays for that when an argument can actually run code. These assertions pin
// the code shape on both lowerings:
//
//   - the IR lane (`a.push(x)`, one plain argument) and the legacy unrolled lane
//     (`a.push(x, x)`, which the IR leaves to legacy) keep a side-effect-free
//     argument at its store: nothing but the receiver load precedes the length
//     read, no spill local, no extra call, no extra allocation;
//   - an argument that calls a function is evaluated BEFORE the length read —
//     the only delta is the temp local that carries its value across it.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Fn {
  wat: string;
  /** Instruction lines (no declarations), trimmed. */
  ops: string[];
  /** Index of the receiver's length read: `struct.get <vec> 0` on parameter 0's vec type. */
  lenRead: number;
}

async function compileFn(src: string): Promise<Fn> {
  const r = await compile(src, { fileName: "t.ts", emitWat: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const lines = (r.wat ?? "").split("\n");
  const start = lines.findIndex((l) => l.trimStart().startsWith("(func $p "));
  expect(start, "no $p in WAT").toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    body.push(lines[i]!);
    for (const ch of lines[i]!) depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
    if (depth <= 0) break;
  }
  const wat = body.join("\n");
  const vec = wat.match(/^\s*\(func \$p \(param \(ref null (\d+)\)/)?.[1];
  expect(vec, `receiver is not a vec ref:\n${body[0]}`).toBeDefined();
  const ops = body
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("(func") && !l.startsWith("(local") && !l.startsWith(")"));
  return { wat, ops, lenRead: ops.indexOf(`struct.get ${vec} 0`) };
}

const count = (ops: string[], re: RegExp) => ops.filter((op) => re.test(op)).length;

describe("#6787 push argument order — the fast path stays fast", () => {
  it("IR lane: `a.push(x)` reads the length straight off the receiver load", async () => {
    const fn = await compileFn(`export function p(a: number[], x: number): number { return a.push(x); }`);
    expect(fn.lenRead).toBeGreaterThan(0);
    // Receiver loads only — the scalar argument is not spilled ahead of the read.
    expect(fn.ops.slice(0, fn.lenRead).every((op) => op.startsWith("local.get "))).toBe(true);
    expect(count(fn.ops, /^call_ref /)).toBe(0);
  });

  it("IR lane: `a.push(g())` calls `g` before the length read", async () => {
    const fn = await compileFn(`export function p(a: number[], g: () => number): number { return a.push(g()); }`);
    const callArg = fn.ops.findIndex((op) => op.startsWith("call_ref "));
    expect(callArg).toBeGreaterThanOrEqual(0);
    expect(fn.lenRead).toBeGreaterThan(callArg);
  });

  it("legacy lane: `a.push(x, x)` keeps both arguments at their stores", async () => {
    const fn = await compileFn(`export function p(a: number[], x: number): number { return a.push(x, x); }`);
    expect(fn.wat).not.toContain("__argord_");
    expect(fn.lenRead).toBeGreaterThan(0);
    // The receiver is tee'd straight into the read; nothing is spilled before it.
    expect(count(fn.ops.slice(0, fn.lenRead), /^local\.set /)).toBe(0);
    // The only allocation is the grow arm's new backing array.
    expect(count(fn.ops, /^(struct\.new|array\.new)/)).toBe(1);
    expect(count(fn.ops, /^array\.new_default /)).toBe(1);
    // The only call builds the null-receiver TypeError inside its throw arm.
    expect(count(fn.ops, /^call /)).toBe(count(fn.ops, /^throw /));
  });

  it("legacy lane: an effectful argument list is spilled — one temp per argument, run before `length`", async () => {
    const fn = await compileFn(
      `export function p(a: number[], x: number, g: () => number): number { return a.push(x, g()); }`,
    );
    expect(fn.wat.match(/\(local \$__argord_/g)?.length).toBe(2);
    const callArg = fn.ops.findIndex((op) => op.startsWith("call_ref "));
    expect(callArg).toBeGreaterThanOrEqual(0);
    expect(fn.lenRead).toBeGreaterThan(callArg);
  });
});
