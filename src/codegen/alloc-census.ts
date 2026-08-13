// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3921) Per-type WasmGC allocation census — instrumentation only, OFF unless
 * `JS2WASM_ALLOC_CENSUS=1`.
 *
 * #3780 round 4 established that allocation volume is a first-class cost in the
 * standalone lane: the acorn self-parse allocates ~43.6 MB per 226 KB source
 * and only ~10 MB of that is the AST it returns. The other ~34 MB — roughly
 * 810 bytes per token — could not be attributed, because nothing available
 * observes WasmGC allocation:
 *
 *  - V8's sampling heap profiler does not see `struct.new` (measured: 0.2 MB
 *    sampled across a 58 MB parse, all of it on one `js-to-wasm` frame);
 *  - `--trace-gc-object-stats` is unavailable on the Node build in use;
 *  - a heap snapshot cannot be taken mid-parse — the benchmark export is one
 *    synchronous call and the AST is unreachable by the time it returns;
 *  - static `struct.new` SITE counts say where allocation can happen, not how
 *    often, and reading them as volume is the extrapolation trap #3684 caught.
 *
 * So the count has to come from the emitter. After each allocation this appends
 * a **stack-neutral** `global.get / i32.const 1 / i32.add / global.set`, which
 * leaves the freshly-allocated reference exactly where it was — no body needs
 * restructuring and no type changes.
 *
 * One exported mutable `i32` global per allocated type, named after the type
 * rather than its index: `wasm-opt` renumbers types, so a `typeIdx`-keyed
 * reader would go stale, while export names survive. A companion export carries
 * the count so a reader can enumerate without guessing.
 *
 * The instrumented binary is slower and larger. That is fine — it is a
 * measurement build, and the quantity it measures is deterministic, so it does
 * not compete with the timing benchmarks.
 */
import type { Instr, TypeDef, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { reportReceiverCse } from "./receiver-cse.js"; // (#4157 B)
import { walkChildren } from "./walk-instructions.js";

/** Export-name prefix for a per-type counter. */
export const ALLOC_CENSUS_PREFIX = "__alloc_count_";

/** (#4185) Export-name prefix for a per-(caller→callee) call counter. */
export const CALL_CENSUS_PREFIX = "__call_census_";

export function allocCensusEnabled(): boolean {
  return process.env.JS2WASM_ALLOC_CENSUS === "1";
}

/**
 * (#4185) When set alongside `JS2WASM_ALLOC_CENSUS=1`, the per-type counters
 * become per-(function × type) counters — attributing each allocation to the
 * defined function whose body contains the `struct.new`/`array.new`. This is
 * how a census whose top type is allocated inside shared helper functions
 * (`__any_box_*` for `$AnyValue`) gets its first level of attribution.
 */
function allocCensusByFunc(): boolean {
  return process.env.JS2WASM_ALLOC_CENSUS_BY_FUNC === "1";
}

/**
 * (#4185) Comma-separated substrings limiting which allocated types get
 * counters (matched against the census export name, e.g. `type_75` or
 * `__fnctor_Node`). Unset = all. BY_FUNC mode without a focus can create
 * thousands of exported globals; focusing keeps the measurement build sane.
 */
function allocCensusFocus(): string[] {
  const raw = process.env.JS2WASM_ALLOC_CENSUS_FOCUS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * (#4185) Comma-separated substrings. Every direct `call`/`return_call` to a
 * defined function whose name contains one of them gets a per-(caller, callee)
 * exported counter — the second attribution level: WHO calls the allocating
 * helpers. Self-gated; usable with or without the per-type census.
 */
function callCensusTargets(): string[] {
  const raw = process.env.JS2WASM_ALLOC_CENSUS_CALLS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** (#4157) Export-name prefix for a per-function executed-entry counter. */

/** The allocation opcodes worth counting — every WasmGC heap producer. */
const ALLOC_OPS = new Set([
  "struct.new",
  "struct.new_default",
  "array.new",
  "array.new_default",
  "array.new_fixed",
  "array.new_data",
  "array.new_elem",
]);

/**
 * A readable, collision-free export suffix for a type. Struct names are
 * preferred because they are what the reader wants to see; the index is
 * appended regardless so two types that share a registered name (or none) stay
 * distinguishable.
 */
function censusName(ctx: CodegenContext, typeIdx: number): string {
  const registered = ctx.typeIdxToStructName.get(typeIdx);
  const base = registered === undefined ? "type" : registered.replace(/[^A-Za-z0-9_]/g, "_");
  return `${ALLOC_CENSUS_PREFIX}${base}_${typeIdx}`;
}

/**
 * Install the census. Call AFTER dead-type elimination and the peephole pass,
 * so the `typeIdx` on each allocation is already the final one, and before the
 * emit. Adding globals is not adding imports, so this does not disturb the
 * frozen import index space.
 */
export function installAllocCensus(ctx: CodegenContext): void {
  if (allocCensusEnabled()) installTypeCensus(ctx);
  installCallCensus(ctx);
  reportReceiverCse(); // (#4157 B) one line of evidence that the CSE fired
}

function installTypeCensus(ctx: CodegenContext): void {
  // Pass 1 — which types are actually allocated anywhere. Allocating a global
  // per declared type would bloat a module whose type table is mostly cold.
  const allocated = new Set<number>();
  for (const fn of ctx.mod.functions) collectAllocatedTypes(fn.body, allocated);
  const focus = allocCensusFocus();
  if (focus.length > 0) {
    for (const typeIdx of [...allocated]) {
      if (!focus.some((f) => censusName(ctx, typeIdx).includes(f))) allocated.delete(typeIdx);
    }
  }
  if (allocated.size === 0) return;

  // Shape report — the census export names carry only the type NAME; the
  // reader needs the per-instance size to turn counts into bytes. stderr so a
  // harness capturing stdout for counts is undisturbed.
  for (const typeIdx of [...allocated].sort((a, b) => a - b)) {
    process.stderr.write(`[alloc-census] ${censusName(ctx, typeIdx)}: ${typeShapeSummary(ctx, typeIdx)}\n`);
  }

  if (!allocCensusByFunc()) {
    // Pass 2 — one exported mutable counter per allocated type.
    const globalIdxByType = new Map<number, number>();
    for (const typeIdx of [...allocated].sort((a, b) => a - b)) {
      const globalIdx = newCounterGlobal(ctx, censusName(ctx, typeIdx));
      globalIdxByType.set(typeIdx, globalIdx);
    }
    // Pass 3 — splice the increments in.
    for (const fn of ctx.mod.functions) instrumentBody(fn.body, (typeIdx) => globalIdxByType.get(typeIdx));
    return;
  }

  // (#4185) BY_FUNC mode: one counter per (containing function × type),
  // created lazily so cold (function, type) pairs cost nothing.
  for (let i = 0; i < ctx.mod.functions.length; i++) {
    const fn = ctx.mod.functions[i]!;
    const perType = new Map<number, number>();
    instrumentBody(fn.body, (typeIdx) => {
      if (!allocated.has(typeIdx)) return undefined;
      let globalIdx = perType.get(typeIdx);
      if (globalIdx === undefined) {
        globalIdx = newCounterGlobal(ctx, `${censusName(ctx, typeIdx)}__in__${sanitize(fn.name)}_${i}`);
        perType.set(typeIdx, globalIdx);
      }
      return globalIdx;
    });
  }
}

/**
 * (#4185) Call census: exported per-(caller, callee) counters on every direct
 * `call`/`return_call` to a defined function whose name matches a target.
 */
function installCallCensus(ctx: CodegenContext): void {
  const targets = callCensusTargets();
  if (targets.length === 0) return;

  // Match callees through `ctx.funcMap` — the SAME lookup call sites used when
  // they emitted `{op:"call", funcIdx}`. Positional matching against
  // `ctx.mod.functions` does not work here: bodies carry mint-time HANDLES
  // (import-space at registration, before dead-import elimination), which the
  // emitter resolves through the layout seam at encode time; recomputing
  // "final index" from list position matched zero of 261k measured calls.
  const matched = new Map<number, string>(); // call-site funcIdx handle → callee name
  for (const [name, funcIdx] of ctx.funcMap) {
    if (targets.some((t) => name.includes(t))) matched.set(funcIdx, name);
  }
  process.stderr.write(
    `[call-census] ${matched.size} callee(s) match [${targets.join(",")}]: ${[...matched.values()].join(", ")}\n`,
  );
  if (matched.size === 0) return;
  let staticSites = 0;

  for (let i = 0; i < ctx.mod.functions.length; i++) {
    const fn = ctx.mod.functions[i]!;
    const perCallee = new Map<number, number>();
    for (const arr of everyArray(fn.body)) {
      let hit = false;
      for (const instr of arr) {
        if ((instr.op === "call" || instr.op === "return_call") && matched.has(instr.funcIdx)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      const rewritten: Instr[] = [];
      for (const instr of arr) {
        // A `return_call` never returns to the caller, so the increment must
        // precede it; for plain `call` the pre-increment is equally correct
        // (the callee cannot observe the counter) and keeps one code path.
        if ((instr.op === "call" || instr.op === "return_call") && matched.has(instr.funcIdx)) {
          let globalIdx = perCallee.get(instr.funcIdx);
          if (globalIdx === undefined) {
            globalIdx = newCounterGlobal(
              ctx,
              `${CALL_CENSUS_PREFIX}${sanitize(fn.name)}_${i}__TO__${sanitize(matched.get(instr.funcIdx)!)}`,
            );
            perCallee.set(instr.funcIdx, globalIdx);
          }
          rewritten.push(...incrementInstrs(globalIdx));
          staticSites++;
        }
        rewritten.push(instr);
      }
      arr.splice(0, arr.length, ...rewritten);
    }
  }
  process.stderr.write(`[call-census] instrumented ${staticSites} static call site(s)\n`);
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function newCounterGlobal(ctx: CodegenContext, name: string): number {
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name,
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.mod.exports.push({ name, desc: { kind: "global", index: globalIdx } });
  return globalIdx;
}

function incrementInstrs(globalIdx: number): Instr[] {
  return [
    { op: "global.get", index: globalIdx },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "global.set", index: globalIdx },
  ];
}

/** Estimated V8 pointer-compressed heap bytes for one field/element. */
function valTypeBytes(t: ValType): number {
  switch (t.kind) {
    case "i8":
      return 1;
    case "i16":
      return 2;
    case "i64":
    case "f64":
    case "v128":
      return t.kind === "v128" ? 16 : 8;
    default:
      return 4; // i32/f32 and every compressed reference kind
  }
}

/**
 * Resolve a final type index against `ctx.mod.types`, which stores rec groups
 * as ONE entry spanning `types.length` consecutive indices (mirrors the WAT
 * emitter's numbering).
 */
function resolveTypeDef(ctx: CodegenContext, typeIdx: number): TypeDef | undefined {
  let idx = 0;
  for (const t of ctx.mod.types) {
    const span = t.kind === "rec" ? t.types.length : 1;
    if (typeIdx < idx + span) return t.kind === "rec" ? t.types[typeIdx - idx] : t;
    idx += span;
  }
  return undefined;
}

/** Human-readable field breakdown + estimated per-instance bytes (8 B header). */
function typeShapeSummary(ctx: CodegenContext, typeIdx: number): string {
  let def = resolveTypeDef(ctx, typeIdx);
  if (def !== undefined && def.kind === "sub") def = def.type;
  if (def === undefined) return "unresolved type";
  if (def.kind === "array") return `array of ${def.element.kind} (${valTypeBytes(def.element)} B/elem + header)`;
  if (def.kind !== "struct") return def.kind;
  const kinds = new Map<string, number>();
  let bytes = 8; // object header
  for (const field of def.fields) {
    kinds.set(field.type.kind, (kinds.get(field.type.kind) ?? 0) + 1);
    bytes += valTypeBytes(field.type);
  }
  const breakdown = [...kinds.entries()].map(([k, n]) => `${n}×${k}`).join(" ");
  return `struct, ${def.fields.length} fields (${breakdown}), ~${bytes} B/instance`;
}

/** Every nested instruction array reachable from `instrs`, including itself. */
function everyArray(instrs: Instr[]): Instr[][] {
  const out: Instr[][] = [];
  const stack: Instr[][] = [instrs];
  while (stack.length > 0) {
    const arr = stack.pop()!;
    out.push(arr);
    for (const instr of arr) walkChildren(instr, (child) => stack.push(child));
  }
  return out;
}

function collectAllocatedTypes(instrs: Instr[], out: Set<number>): void {
  for (const arr of everyArray(instrs)) {
    for (const instr of arr) {
      const typeIdx = (instr as { op: string; typeIdx?: number }).typeIdx;
      if (ALLOC_OPS.has(instr.op) && typeof typeIdx === "number") out.add(typeIdx);
    }
  }
}

function instrumentBody(instrs: Instr[], counterForType: (typeIdx: number) => number | undefined): void {
  // Collect the arrays FIRST, then rewrite: splicing while walking would make
  // the walk revisit the instructions it just inserted.
  for (const arr of everyArray(instrs)) {
    let hit = false;
    for (const instr of arr) {
      if (ALLOC_OPS.has(instr.op) && typeof (instr as { typeIdx?: number }).typeIdx === "number") {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    const rewritten: Instr[] = [];
    for (const instr of arr) {
      rewritten.push(instr);
      const typeIdx = (instr as { typeIdx?: number }).typeIdx;
      if (!ALLOC_OPS.has(instr.op) || typeIdx === undefined) continue;
      const globalIdx = counterForType(typeIdx);
      if (globalIdx === undefined) continue;
      rewritten.push(...incrementInstrs(globalIdx));
    }
    arr.splice(0, arr.length, ...rewritten);
  }
}
