// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Opt-in detector for the "numeric module global adopted as a reference"
// miscompile family (#1400 / #3672).
//
// Across a real package graph, several codegen paths resolve an identifier
// through the process-wide bare-name map `ctx.moduleGlobals` rather than the
// identifier's own declaration. One package's top-level numeric then wins over
// another's lexical binding of the same spelling — ESLint's `ms` dependency
// declares `var s = 1000; var m = s * 60; …`, esquery and minimatch have
// lexical helpers named `m`/`s`. The emitted code reads the f64 global into a
// reference slot and the whole module fails validation with:
//
//   local.tee[0] expected type (ref null N), found global.get of type f64
//
// Wasm reports only the FIRST such function, so fixing one instance merely
// uncovers the next. This pass reports every instance in a single compile,
// which is what makes the family tractable — capturing and disassembling the
// 10.6 MB ESLint binary instead gets OOM-killed on a 7.8 GB box.
//
// Enable with J2W_DIAG_GLOBAL_COLLISION=1. Never runs otherwise.
import type { GlobalDef, Instr, LocalDef, ValType, WasmModule } from "../ir/types.js";

const NUMERIC = new Set(["f64", "f32", "i32", "i64"]);

function isNumeric(t: ValType | undefined): boolean {
  return t !== undefined && NUMERIC.has(t.kind);
}

function isRef(t: ValType | undefined): boolean {
  return t !== undefined && (t.kind === "ref" || t.kind === "ref_null");
}

export interface GlobalCollisionFinding {
  func: string;
  globalIdx: number;
  globalName: string;
  globalType: string;
  localIdx: number;
  localName: string;
  localType: string;
}

/**
 * Walk every function body (recursing into nested block/if/loop arms) looking
 * for `global.get <numeric>` immediately consumed by `local.set|tee <ref>`.
 */
export function findGlobalCollisions(
  mod: WasmModule,
  numParams: (f: { typeIdx: unknown }) => number,
  numImportGlobals = 0,
): GlobalCollisionFinding[] {
  const out: GlobalCollisionFinding[] = [];

  // Emitted indices address the FINAL binary's global space, where imported
  // globals occupy the low slots; `mod.globals` excludes them. Without this
  // shift every lookup names the wrong global (it reported i32 `__tdz_*` for
  // what Wasm calls f64).
  const globalType = (idx: number): GlobalDef | undefined => mod.globals[idx - numImportGlobals];

  for (const fn of mod.functions) {
    const nParams = numParams(fn);
    const localAt = (idx: number): LocalDef | undefined => (idx < nParams ? undefined : fn.locals[idx - nParams]);

    /**
     * Type produced by a single instruction, for the handful of shapes that
     * can feed a `local.set|tee`. Only cases where the answer is unambiguous —
     * everything else returns undefined and is skipped, so this under-reports
     * rather than crying wolf.
     *
     * The chained form matters: the array-receiver instance emits
     * `global.get <f64>` -> `local.tee <f64 proxy>` -> `local.tee <ref vec>`,
     * so the offending producer is the intermediate LOCAL, not the global.
     */
    const producedType = (ins: { op: string; index?: number }): { t?: ValType; desc: string } => {
      if (ins.op === "global.get" && ins.index !== undefined) {
        const g = globalType(ins.index);
        return { t: g?.type, desc: `global.get ${ins.index} ($${g?.name ?? "?"})` };
      }
      if ((ins.op === "local.get" || ins.op === "local.tee") && ins.index !== undefined) {
        const l = localAt(ins.index);
        return { t: l?.type, desc: `${ins.op} ${ins.index} ($${l?.name ?? "param"})` };
      }
      const m = /^(f64|f32|i32|i64)\./.exec(ins.op);
      if (m) return { t: { kind: m[1] } as ValType, desc: ins.op };
      return { desc: ins.op };
    };

    const walk = (body: Instr[]): void => {
      for (let i = 0; i < body.length; i++) {
        const cur = body[i] as { op: string; index?: number; then?: Instr[]; else?: Instr[]; body?: Instr[] };
        for (const arm of [cur.then, cur.else, cur.body]) if (Array.isArray(arm)) walk(arm);
        if (cur.op !== "local.set" && cur.op !== "local.tee") continue;
        if (cur.index === undefined || i === 0) continue;
        const l = localAt(cur.index);
        if (!isRef(l?.type)) continue;
        const src = producedType(body[i - 1] as { op: string; index?: number });
        if (!isNumeric(src.t)) continue;
        const gi = /global\.get (\d+)/.exec(src.desc);
        out.push({
          func: fn.name,
          globalIdx: gi ? Number(gi[1]) : -1,
          globalName: src.desc,
          globalType: src.t?.kind ?? "?",
          localIdx: cur.index,
          localName: l?.name ?? "?",
          localType: JSON.stringify(l?.type),
        });
      }
    };
    walk(fn.body);
  }
  return out;
}

/**
 * Dump the instruction window around every ref-typed `local.set|tee` in ONE
 * named function, plus the struct name behind each ref type.
 *
 * `findGlobalCollisions` assumes the previous instruction is the stack
 * producer, which is false whenever an `if`/`block` supplies the value — on the
 * ESLint graph that mis-attributes an f64 source to a nearby i32 TDZ check. The
 * window shows the real producer without writing a full validator.
 *
 * Set J2W_DIAG_FUNC to the function Wasm names in its validation error.
 */
function dumpFunctionWindows(
  mod: WasmModule,
  numParams: (f: { typeIdx: unknown }) => number,
  want: string,
  numImportGlobals: number,
): void {
  const fn = mod.functions.find((f) => f.name === want);
  if (!fn) {
    console.error(`[diag-func] no function named ${want}`);
    return;
  }
  const nParams = numParams(fn);
  const localAt = (i: number): LocalDef | undefined => (i < nParams ? undefined : fn.locals[i - nParams]);
  const typeName = (t: ValType | undefined): string => {
    const idx = (t as { typeIdx?: number } | undefined)?.typeIdx;
    if (idx === undefined) return t?.kind ?? "?";
    const d = mod.types[idx] as { kind?: string; name?: string } | undefined;
    return `${t?.kind} ${idx} (${d?.kind ?? "?"} $${d?.name ?? "?"})`;
  };
  const show = (ins: unknown): string => {
    const o = ins as { op: string; index?: number; typeIdx?: number };
    let s = o.op;
    if (o.index !== undefined) s += ` ${o.index}`;
    if (o.typeIdx !== undefined) s += ` <t${o.typeIdx}>`;
    if (o.op === "global.get" && o.index !== undefined) {
      const g = mod.globals[o.index - numImportGlobals];
      s += `  ; $${g?.name ?? "?"} : ${g?.type.kind ?? "?"}`;
    }
    if ((o.op === "local.get" || o.op === "local.set" || o.op === "local.tee") && o.index !== undefined) {
      const l = localAt(o.index);
      s += `  ; $${l?.name ?? "param"} : ${typeName(l?.type)}`;
    }
    return s;
  };
  const walk = (body: Instr[], path: string): void => {
    for (let i = 0; i < body.length; i++) {
      const cur = body[i] as { op: string; index?: number; then?: Instr[]; else?: Instr[]; body?: Instr[] };
      for (const [k, arm] of [
        ["then", cur.then],
        ["else", cur.else],
        ["body", cur.body],
      ] as const) {
        if (Array.isArray(arm)) walk(arm, `${path}/${i}.${k}`);
      }
      if (cur.op !== "local.set" && cur.op !== "local.tee") continue;
      if (cur.index === undefined) continue;
      const l = localAt(cur.index);
      if (!isRef(l?.type)) continue;
      console.error(`[diag-func] ${want} ${path}[${i}] -> $${l?.name} : ${typeName(l?.type)}`);
      for (let j = Math.max(0, i - 8); j <= i; j++) console.error(`[diag-func]      ${j}: ${show(body[j])}`);
    }
  };
  walk(fn.body, "");
}

export function reportGlobalCollisions(
  mod: WasmModule,
  numParams: (f: { typeIdx: unknown }) => number,
  numImportGlobals = 0,
): void {
  const want = process.env.J2W_DIAG_FUNC;
  if (want) dumpFunctionWindows(mod, numParams, want, numImportGlobals);
  if (!process.env.J2W_DIAG_GLOBAL_COLLISION) return;
  const findings = findGlobalCollisions(mod, numParams, numImportGlobals);
  console.error(`[global-collision] ${findings.length} numeric-global -> ref-slot site(s)`);
  for (const f of findings) {
    console.error(
      `[global-collision]   ${f.func}: global.get ${f.globalIdx} ($${f.globalName} : ${f.globalType}) ` +
        `-> local ${f.localIdx} ($${f.localName} : ${f.localType})`,
    );
  }
}
