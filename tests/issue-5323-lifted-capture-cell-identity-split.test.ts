// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #5323 — one binding, two ref cells: a lifted frame minted a SECOND
 * `__boxed_<name>` cell at a forwarding call site while its own canonical cell
 * already existed at function top.
 *
 * Setup. A nested `function` declaration is lifted with its captures as leading
 * parameters. A capture it only READS arrives by value. If that same function
 * calls a sibling which captures the binding MUTABLY, it must hand that sibling
 * the shared ref cell — so `emitEagerNestedCallCaptureBoxes` (#2758) mints one
 * from the capture param in the UNCONDITIONAL function-top buffer and re-aims
 * `localMap` / `boxedCaptures` at it. That pass states its own contract plainly:
 * "the later call site then takes its already-boxed branch (no second
 * `struct.new`)".
 *
 * The defect. On a lifted frame the call site never looked. Its capture prepend
 * resolves the source through `liftedCaptureSlots` — the FROZEN leading
 * capture-param slot, consulted first precisely so a same-named body binding
 * cannot shadow the capture — and that slot still names the RAW param. So the
 * prepend saw a non-cell, minted a second cell, and re-aimed `localMap` at it.
 * The binding now has two cell slots: the frame's reads and writes address the
 * newer one, which is `local.tee`'d inside whatever control-flow arm the call
 * sits in and is therefore NULL on every path that skipped that arm.
 *
 * Measured on moment@2.30.1: `prepareConfig` declared the same ~30 `__boxed_`
 * cells twice, and all six admitted upstream suites failed with
 * `RuntimeError: dereferencing a null pointer` in that frame — 4/10. Across
 * that module 210 cells were minted twice, every one of them this exact pair
 * (function-top eager mint, then a call-site re-mint). With the fix, 10/10.
 *
 * This is NOT the conditional-arm materialisation defect (#5320): there the
 * cell is never minted on the taken path and the repair seeds it from the
 * pre-box slot. Here the cell exists and holds the live value — the call site
 * simply addressed a different one.
 *
 * The fixture is untyped `.js` behind a two-file project on purpose. Annotating
 * the receiver `: any` routes the calls through a different arm and the test
 * then passes identically with and without the fix.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * `bumpOne` is declared BEFORE the `var total` initializer, so the
 * write-after-declaration analysis records `total` as a MUTABLE capture for it —
 * that is what makes the sibling want the ref cell. Every `readAfter*` is
 * declared AFTER the initializer and only READS `total`, so each receives it by
 * value and must mint the cell itself in order to call `bumpOne`.
 *
 * The four failing shapes differ only in the control-flow arm holding that call:
 * an `if` with a `return`, a fall-through `if`, a `&&`, and a `while`. On the
 * parent commit each returns the right answer only when the arm is TAKEN; on the
 * skipped path it reads the second, never-`tee`d cell and produces 0.
 *
 * The inner functions are named differently from the module's exports on
 * purpose: `nestedFuncCaptures` is name-keyed across the whole graph, so an
 * exported wrapper sharing a name with a nested declaration makes the ENTRY
 * module's cross-module call prepend that nested function's captures — a
 * separate, pre-existing defect (`references out-of-range local(s) 1`) that
 * would mask this one.
 */
const MODULE_SOURCE = `
var makeApi = () => {
  function bumpOne() {
    return total + 1;
  }

  var total = 7;

  function readAfterIfReturn(flag) {
    if (flag) {
      return bumpOne();
    }
    return total;
  }

  function readAfterIfFallThrough(flag) {
    if (flag) {
      bumpOne();
    }
    return total;
  }

  function readAfterLogical(flag) {
    flag && bumpOne();
    return total;
  }

  function readAfterLoop(flag) {
    while (flag) {
      bumpOne();
      flag = 0;
    }
    return total;
  }

  function readAfterPlainCall() {
    bumpOne();
    return total;
  }

  return {
    readAfterIfReturn: readAfterIfReturn,
    readAfterIfFallThrough: readAfterIfFallThrough,
    readAfterLogical: readAfterLogical,
    readAfterLoop: readAfterLoop,
    readAfterPlainCall: readAfterPlainCall,
    bumpOne: bumpOne,
  };
};

var api = makeApi();

export function stepReturnArm(flag) {
  return api.readAfterIfReturn(flag);
}
export function stepFallThroughArm(flag) {
  return api.readAfterIfFallThrough(flag);
}
export function stepLogicalArm(flag) {
  return api.readAfterLogical(flag);
}
export function stepLoopArm(flag) {
  return api.readAfterLoop(flag);
}
export function stepNoArm() {
  return api.readAfterPlainCall();
}
export function siblingRead() {
  return api.bumpOne();
}
`;

const ENTRY_SOURCE = `
import { siblingRead, stepFallThroughArm, stepLogicalArm, stepLoopArm, stepNoArm, stepReturnArm } from "./mod.js";

export function viaReturnArm(flag: number): number {
  return stepReturnArm(flag);
}
export function viaFallThroughArm(flag: number): number {
  return stepFallThroughArm(flag);
}
export function viaLogicalArm(flag: number): number {
  return stepLogicalArm(flag);
}
export function viaLoopArm(flag: number): number {
  return stepLoopArm(flag);
}
export function viaNoArm(): number {
  return stepNoArm();
}
export function viaSibling(): number {
  return siblingRead();
}
`;

async function instantiate(): Promise<WebAssembly.Exports> {
  const root = mkdtempSync(join(tmpdir(), "js2-5323-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), MODULE_SOURCE);
  writeFileSync(join(root, "entry.ts"), ENTRY_SOURCE);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

type Fn = (flag: number) => number;

describe("#5323 a lifted frame keeps ONE canonical cell per capture", () => {
  it("reads the live binding when the capturing-call `if` arm is skipped", async () => {
    // Parent commit: 0 — the read addresses the cell minted inside the arm.
    const exports = await instantiate();
    expect((exports.viaReturnArm as Fn)(0)).toBe(7);
  });

  it("reads the live binding when a fall-through `if` arm is skipped", async () => {
    const exports = await instantiate();
    expect((exports.viaFallThroughArm as Fn)(0)).toBe(7);
  });

  it("reads the live binding when a `&&` arm is skipped", async () => {
    const exports = await instantiate();
    expect((exports.viaLogicalArm as Fn)(0)).toBe(7);
  });

  it("reads the live binding when a loop body never runs", async () => {
    const exports = await instantiate();
    expect((exports.viaLoopArm as Fn)(0)).toBe(7);
  });

  it("is unchanged when the arm IS taken", async () => {
    // Guards: on the parent the re-minted cell is filled on these paths, so all
    // four already pass. They fail if the fix redirects a forwarding site to a
    // cell that is not the binding's storage.
    const exports = await instantiate();
    expect((exports.viaReturnArm as Fn)(1)).toBe(8);
    expect((exports.viaFallThroughArm as Fn)(1)).toBe(7);
    expect((exports.viaLogicalArm as Fn)(1)).toBe(7);
    expect((exports.viaLoopArm as Fn)(1)).toBe(7);
  });

  it("is unchanged for an unconditional call site and for the sibling itself", async () => {
    const exports = await instantiate();
    expect((exports.viaNoArm as () => number)()).toBe(7);
    expect((exports.viaSibling as () => number)()).toBe(8);
  });
});
