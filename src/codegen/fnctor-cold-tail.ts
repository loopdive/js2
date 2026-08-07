// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3927) Hot/cold split of the widened fnctor struct — the shape-AGNOSTIC
 * design from the issue's §7.
 *
 * ## The cost this attacks
 * A constructor whose instances take different property sets lowers to ONE
 * closed struct carrying the UNION of every property any instance ever gets.
 * Acorn's `Node` is the clean case: every ESTree node kind is the same
 * `new Node(...)`, so the struct carries 62 `externref` slots — 292 B — while
 * the median instance populates ONE of them. Measured on the standalone
 * dynamic lane (`JS2WASM_ALLOC_CENSUS=1`, current main): 32,468 `__fnctor_Node`
 * per parse × 292 B = **9.48 MB of the 12.23 MB of struct bytes allocated per
 * parse — 77.5 %**. Allocation volume is the binding constraint at this
 * operating point (#4157: the gc-engine profile bucket is the largest single
 * bucket at 23.1 % and GREW as the helper buckets shrank).
 *
 * ## Why this design and not a per-shape partition
 * #3927 §3 established, against acorn's source, that a per-SHAPE split is not
 * reachable here: there are exactly 3 `new Node` sites, all inside
 * shape-agnostic factory methods (`startNode`/`startNodeAt`/`copyNode`); the
 * discriminating `type` tag is applied at `finishNode`, AFTER the variant
 * fields are written; and `toAssignable` rewrites `node.type` and fields IN
 * PLACE on live nodes, so any static partition must keep expressions and their
 * pattern twins in the same member. The one design that survives all three is
 * shape-agnostic: keep the hot union fields inline, move the cold ones to a
 * lazily-allocated tail struct behind a single `$cold` slot. No shape needs to
 * be known at the `struct.new`.
 *
 * ## Eligibility — deliberately narrow
 * Only FLOW-GROWN fields are cold-eligible: presence-tracked, `externref`,
 * added by the receiver-flow pass in `deriveFnctorFields` rather than by a
 * `this.<f> = …` write in the constructor. That class is already excluded from
 * the typed-`this` twins (#3683 S2), from the numeric promotion (#3683 S4a) and
 * from the string promotion (#3753 S1) — every one of those declines
 * presence-tracked fields because their carrier is what answers `undefined`.
 * So the access surface a cold field can appear on is much narrower than a
 * general field's, and the split cannot collide with a physical f64/`$AnyString`
 * slot.
 *
 * ## The failure mode is degradation, not silence
 * A cold field is REMOVED from the main struct's field list. Every consumer
 * that resolves a field by NAME (`fields.findIndex(...)`) therefore answers
 * `-1` and takes its existing "not a slot on this shape" path, which is the
 * generic dynamic dispatcher — and the dispatcher IS taught the hop
 * ({@link coldFieldReadArm} / {@link coldFieldWriteArm} wired into
 * `fillMemberGetDispatch` / `fillMemberSetDispatch`). An un-taught consumer
 * thus degrades to a slower correct path instead of reading the wrong slot.
 * That is the property that makes the 9th-dogfood-wall risk class (silent
 * `undefined`) tractable here.
 *
 * ## Ranking is corpus-independent
 * Hot fields are the top-K by the static hotness weight in
 * {@link flowFieldHotnessWeights} — access sites on a flow-proved receiver of
 * this fnctor, each weighted by how many places call the routine it sits in —
 * ties broken by name ascending. Nothing about any measured corpus enters the
 * decision, so a different program gets a ranking derived from its own source.
 * See that function's doc for why a bare site COUNT is a poor proxy and what
 * the measured ceiling for any static proxy is.
 *
 * ## Default: ON in the standalone lane, at K=20
 * `JS2WASM_FNCTOR_HOT_FIELDS=<K>` overrides the limit;
 * `JS2WASM_FNCTOR_HOT_FIELDS=off` disables the split entirely, which leaves the
 * field list untouched and the emitted binary byte-identical to a build made
 * with this module absent. Host mode is never split — see
 * {@link coldTailHotFieldLimitFor}.
 */
import { ts } from "../ts-api.js";
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import {
  type PresenceSlot,
  presenceSetInstrs,
  presenceSlotOf,
  presenceTestInstrs,
  presenceWordName,
} from "./fnctor-presence-bits.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** Field name of the lazily-allocated cold tail on the main fnctor struct. */
export const COLD_TAIL_FIELD = "$cold";

/** Suffix appended to the fnctor struct name to form its cold-tail struct name. */
export const COLD_TAIL_SUFFIX = "__cold";

/**
 * Number of flow-grown fields kept INLINE by default.
 *
 * Chosen by measurement, not by interpolation — the curve is NOT smooth, and
 * the neighbouring K is materially worse. Standalone acorn self-parse,
 * deterministic census (`tests/dogfood/cold-tail-census.mjs`), bytes per
 * `__fnctor_Node` including its share of `$cold` tails:
 *
 * | K  | inline | tail rate | effective |
 * | -- | -----: | --------: | --------: |
 * | 16 |  116 B |    62.3 % |   235.7 B |
 * | **20** | **132 B** | **28.1 %** | **181.5 B** |
 * | 24 |  148 B |    25.8 % |   189.3 B |
 * | 28 |  164 B |    24.4 % |   198.2 B |
 * | 32 |  184 B |    23.9 % |   213.7 B |
 *
 * Past K=20 the tail RATE keeps falling but each extra inline slot costs 4 B on
 * every one of the 32,468 nodes, which the shrinking tail no longer repays.
 * Unsplit is 292 B.
 */
export const COLD_TAIL_DEFAULT_HOT_FIELDS = 20;

/**
 * Number of flow-grown fields kept INLINE, from `JS2WASM_FNCTOR_HOT_FIELDS`.
 *
 * Default (unset) is {@link COLD_TAIL_DEFAULT_HOT_FIELDS} — the split is ON.
 * `off` disables it entirely: no cold struct is reserved and no field list
 * changes, so the binary is byte-identical to a build made with this module
 * absent. Any other malformed value falls back to the DEFAULT and never to a
 * bare `Number(raw)`; `Number("")` is `0`, which would silently move EVERY
 * eligible field to the tail.
 *
 * `0` is a legal, meaningful value (move every flow-grown field to the tail).
 */
export function coldTailHotFieldLimit(): number | undefined {
  const raw = process.env.JS2WASM_FNCTOR_HOT_FIELDS;
  if (raw === undefined || raw === "") return COLD_TAIL_DEFAULT_HOT_FIELDS;
  if (raw.trim().toLowerCase() === "off") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return COLD_TAIL_DEFAULT_HOT_FIELDS;
  return parsed;
}

/**
 * The limit for THIS module, i.e. {@link coldTailHotFieldLimit} restricted to
 * the standalone lane.
 *
 * The gate is explicit rather than inherited from "flow-grown fields only
 * happen in standalone anyway". That argument was true and was written down,
 * but it is the wrong kind of thing to rest a shipped default on: it is a
 * property of another pass, checked nowhere, and a host build that ever did
 * grow one would silently gain a reserved type and a changed binary. Both the
 * type RESERVATION and the split itself go through here.
 */
export function coldTailHotFieldLimitFor(ctx: CodegenContext): number | undefined {
  return ctx.standalone ? coldTailHotFieldLimit() : undefined;
}

/** Cold-tail struct name for a main fnctor struct name. */
export function coldTailStructName(mainStructName: string): string {
  return `${mainStructName}${COLD_TAIL_SUFFIX}`;
}

/**
 * Name of the nearest enclosing function-like node, as a call target would
 * spell it: `function f()`, `o.m = function …`, `var f = () => …`, `{ m() {} }`.
 * `undefined` at top level or for a genuinely anonymous callee.
 */
function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
    if (
      !ts.isFunctionDeclaration(n) &&
      !ts.isFunctionExpression(n) &&
      !ts.isArrowFunction(n) &&
      !ts.isMethodDeclaration(n)
    ) {
      continue;
    }
    const own = (n as { name?: ts.Node }).name;
    if (own !== undefined && ts.isIdentifier(own)) return own.text;
    const parent = n.parent;
    if (parent && ts.isBinaryExpression(parent) && ts.isPropertyAccessExpression(parent.left)) {
      return parent.left.name.text;
    }
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    return undefined;
  }
  return undefined;
}

/**
 * Static call-site count per callee NAME, over the source files the flow map
 * actually touches. Cached per context — one syntax walk, no checker.
 */
const callSiteCountCache = new WeakMap<CodegenContext, Map<string, number>>();

function callSiteCounts(ctx: CodegenContext, files: ReadonlySet<ts.SourceFile>): Map<string, number> {
  const cached = callSiteCountCache.get(ctx);
  if (cached !== undefined) return cached;
  const counts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
      if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  for (const file of files) visit(file);
  callSiteCountCache.set(ctx, counts);
  return counts;
}

/**
 * Hotness weight per property name for one fnctor, from the SAME
 * `receiverStruct` flow map `deriveFnctorFields` grows the fields from.
 *
 * ## What the proxy has to predict, and why the obvious one fails
 * A node needs a `$cold` tail iff ANY property it carries is cold, so the
 * quantity worth predicting is a field's per-INSTANCE frequency. Counting
 * syntactic sites — the first cut — predicts it badly, and measurably so
 * (#3927, standalone acorn): `left`, `right`, `callee`, `object`, `optional`
 * are on all but every expression node yet are each assigned at 2-4 places,
 * while `declaration`, `source`, `exported`, `label`, `attributes` are assigned
 * at 5-7 places and appear on a handful of nodes in a whole program. The raw
 * counts also span only 1..25 over 60 fields, so the top-K cut lands inside a
 * large tie group and is settled by the NAME tie-break rather than by any
 * signal at all.
 *
 * ## The weighting, and why it is still corpus-independent
 * Each access site is weighted by `1 + <static call sites of its enclosing
 * function>`. The claim is about programs, not about acorn: **a property
 * assigned inside a routine the rest of the program calls from many places is
 * assigned to many more objects at run time than one assigned inside a routine
 * called from one place.** Nothing about any measured input enters — a
 * different program is ranked from its own call structure. It also spreads the
 * 1..25 range out by an order of magnitude, so far fewer fields tie.
 *
 * Deliberately NOT done: ranking by observed instance counts from a corpus run.
 * That predicts perfectly (2.7 % tail rate at K=24 vs 36.6 % measured here) and
 * is exactly the corpus dependence §7 rules out — it would bake one program's
 * node-kind mix into every other program's layout.
 */
export function flowFieldHotnessWeights(ctx: CodegenContext, flowStructName: string): Map<string, number> {
  const sites: { field: string; node: ts.Node }[] = [];
  const files = new Set<ts.SourceFile>();
  for (const [receiver, structName] of ctx.fnctorEscapeGate?.receiverStruct ?? []) {
    if (structName !== flowStructName) continue;
    const access = receiver.parent;
    if (!access || !("name" in access) || !("expression" in access)) continue;
    const propertyAccess = access as { expression: unknown; name: { text?: string } };
    if (propertyAccess.expression !== receiver) continue;
    const fieldName = propertyAccess.name?.text;
    if (!fieldName) continue;
    sites.push({ field: fieldName, node: receiver });
    files.add(receiver.getSourceFile());
  }
  const calls = callSiteCounts(ctx, files);
  const weights = new Map<string, number>();
  for (const site of sites) {
    const fn = enclosingFunctionName(site.node);
    const weight = 1 + (fn === undefined ? 0 : (calls.get(fn) ?? 0));
    weights.set(site.field, (weights.get(site.field) ?? 0) + weight);
  }
  return weights;
}

/**
 * Choose the cold set: every eligible field outside the top-K by write-site
 * count. Deterministic — the comparator falls back to the field NAME, so two
 * fields with equal counts always order the same way.
 */
export function selectColdFieldNames(
  eligible: readonly string[],
  counts: ReadonlyMap<string, number>,
  hotLimit: number,
): Set<string> {
  const ranked = [...eligible].sort((a, b) => {
    const delta = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    return delta !== 0 ? delta : a < b ? -1 : a > b ? 1 : 0;
  });
  return new Set(ranked.slice(hotLimit));
}

/** Pack presence bits + words for a standalone cold-tail field list. */
function appendColdPresenceWords(fields: FieldDef[]): void {
  fields.forEach((field, index) => {
    field.presenceTracked = true;
    field.presenceBit = index;
  });
  const wordCount = fields.length === 0 ? 0 : ((fields.length - 1) >>> 5) + 1;
  for (let word = 0; word < wordCount; word++) {
    fields.push({ name: presenceWordName(word * 32), type: { kind: "i32" }, mutable: true });
  }
}

/**
 * Split `fields` IN PLACE: remove the cold set, fill the reserved cold struct,
 * and append the `$cold` slot. No-op (and no cold type reserved) unless the
 * flag is on AND `reserveFnctorColdTailType` reserved an index for this fnctor.
 *
 * Runs BEFORE `appendFnctorInternalFields` so the main struct's presence words
 * cover exactly the fields that stayed inline.
 */
export function applyColdTailSplit(
  ctx: CodegenContext,
  fnctorName: string,
  flowStructName: string,
  fields: FieldDef[],
  onlyConditional: Map<string, boolean>,
  flowGrownNames: ReadonlySet<string>,
): void {
  const hotLimit = coldTailHotFieldLimitFor(ctx);
  if (hotLimit === undefined) return;
  const coldTypeIdx = ctx.fnctorColdTailTypeIdx?.get(fnctorName);
  if (coldTypeIdx === undefined) return;

  // Eligible = flow-grown: presence-tracked (conditional-only) `externref`.
  // A constructor-assigned field is never eligible even when conditional: the
  // `struct.new` initializer loop writes it, and moving it would force a tail
  // allocation on EVERY instance, which is the opposite of the point.
  const eligible = fields
    .filter(
      (field) =>
        flowGrownNames.has(field.name) &&
        field.type.kind === "externref" &&
        onlyConditional.get(field.name) === true &&
        !field.name.startsWith("$") &&
        !field.name.startsWith("__") &&
        !ctx.classAccessorSet.has(`${flowStructName}_${field.name}`),
    )
    .map((field) => field.name);
  if (eligible.length <= hotLimit) return;

  const coldNames = selectColdFieldNames(eligible, flowFieldHotnessWeights(ctx, flowStructName), hotLimit);
  if (coldNames.size === 0) return;

  const coldFields: FieldDef[] = [];
  for (let i = fields.length - 1; i >= 0; i--) {
    const field = fields[i]!;
    if (!coldNames.has(field.name)) continue;
    coldFields.unshift(field);
    fields.splice(i, 1);
    onlyConditional.delete(field.name);
  }
  appendColdPresenceWords(coldFields);

  // The split decision is the one thing that has to be auditable from outside:
  // "which 37 slots moved" is what a byte number cannot tell you, and it is the
  // first question when a consumer turns out not to know the hop.
  // The split decision is the one thing that has to be auditable from outside:
  // "which 37 slots moved" is what a byte number cannot tell you, and it is the
  // first question when a consumer turns out not to know the hop. The RANK is
  // printed alongside because the ordering is where the remaining headroom is
  // (see the issue's ranking section) and because a cut that lands inside a
  // large tie group is decided by the name tie-break, not by the proxy.
  if (process.env.JS2WASM_FNCTOR_COLD_DIAG === "1") {
    const counts = flowFieldHotnessWeights(ctx, flowStructName);
    const hot = eligible.filter((name) => !coldNames.has(name));
    const show = (names: readonly string[]): string => names.map((n) => `${n}:${counts.get(n) ?? 0}`).join(",");
    process.stderr.write(
      `[cold-tail] ${flowStructName}: ${hot.length} hot [${show(hot)}] / ${coldNames.size} cold [${show([...coldNames])}]\n`,
    );
  }

  const coldStructName = coldTailStructName(flowStructName);
  const coldType = ctx.mod.types[coldTypeIdx];
  if (coldType && coldType.kind === "struct") coldType.fields = coldFields;
  ctx.structFields.set(coldStructName, coldFields);
  (ctx.fnctorColdTailStructName ??= new Map()).set(flowStructName, coldStructName);
  fields.push({ name: COLD_TAIL_FIELD, type: { kind: "ref_null", typeIdx: coldTypeIdx }, mutable: true });
}

/** One cold field's physical location: the `$cold` hop plus the tail slot. */
export interface ColdFieldLocation {
  readonly mainStructTypeIdx: number;
  readonly coldSlotFieldIdx: number;
  readonly coldStructTypeIdx: number;
  readonly coldFieldIdx: number;
  readonly fieldType: ValType;
  readonly mutable: boolean;
  readonly presenceSlot?: PresenceSlot;
}

/**
 * Every cold-tail location for `propName`, across all split fnctor structs.
 * The read/write dispatchers append these arms AFTER their inline struct arms,
 * so a shape that still carries the field inline always wins.
 */
export function findColdStructsForField(ctx: CodegenContext, propName: string): ColdFieldLocation[] {
  const out: ColdFieldLocation[] = [];
  for (const [mainStructName, coldStructName] of ctx.fnctorColdTailStructName ?? []) {
    const coldFields = ctx.structFields.get(coldStructName);
    const mainFields = ctx.structFields.get(mainStructName);
    const mainStructTypeIdx = ctx.structMap.get(mainStructName);
    const coldStructTypeIdx = ctx.structMap.get(coldStructName);
    if (!coldFields || !mainFields || mainStructTypeIdx === undefined || coldStructTypeIdx === undefined) continue;
    const coldFieldIdx = coldFields.findIndex((f) => f.name === propName);
    if (coldFieldIdx < 0) continue;
    const coldSlotFieldIdx = mainFields.findIndex((f) => f.name === COLD_TAIL_FIELD);
    if (coldSlotFieldIdx < 0) continue;
    const presenceSlot = presenceSlotOf(coldFields, propName);
    out.push({
      mainStructTypeIdx,
      coldSlotFieldIdx,
      coldStructTypeIdx,
      coldFieldIdx,
      fieldType: coldFields[coldFieldIdx]!.type,
      mutable: coldFields[coldFieldIdx]!.mutable,
      ...(presenceSlot ? { presenceSlot } : {}),
    });
  }
  return out;
}

/**
 * `__cold_ensure_<Struct>(main) -> (ref $cold)` — return the instance's tail,
 * allocating and installing it on first write. Emitted once per split fnctor,
 * on demand, at the write dispatcher's FILL. Reserving no imports and no
 * globals, it is safe to mint during the fill phase (the funcIdx it takes is
 * appended; nothing already baked shifts).
 */
export function coldTailAllocatorName(mainStructName: string): string {
  return `__cold_ensure_${mainStructName}`;
}

/**
 * FINALIZE sub-pass — mint one `__cold_ensure_<Struct>` per split fnctor.
 *
 * Runs alongside `reserveVecFieldMaterializers`, i.e. BEFORE the `fill*`
 * dispatcher passes, for exactly the reason recorded there: those fills are
 * read-only over `funcMap`, so nothing they bake can shift. Minting here also
 * keeps the read fill and the write fill from racing to create the same
 * allocator.
 *
 * A never-called allocator is pruned by dead-elimination, so reserving one per
 * split struct unconditionally costs nothing in a shipped artifact.
 */
function defaultColdFieldInstrs(ctx: CodegenContext, coldStructName: string): Instr[] {
  const out: Instr[] = [];
  for (const field of ctx.structFields.get(coldStructName) ?? []) {
    out.push(field.type.kind === "i32" ? { op: "i32.const", value: 0 } : { op: "ref.null.extern" });
  }
  return out;
}

export function reserveColdTailAllocators(ctx: CodegenContext): void {
  for (const [mainStructName, coldStructName] of ctx.fnctorColdTailStructName ?? []) {
    const name = coldTailAllocatorName(mainStructName);
    if (ctx.funcMap.has(name)) continue;
    const mainStructTypeIdx = ctx.structMap.get(mainStructName);
    const coldStructTypeIdx = ctx.structMap.get(coldStructName);
    const mainFields = ctx.structFields.get(mainStructName);
    if (mainStructTypeIdx === undefined || coldStructTypeIdx === undefined || !mainFields) continue;
    const coldSlotFieldIdx = mainFields.findIndex((f) => f.name === COLD_TAIL_FIELD);
    if (coldSlotFieldIdx < 0) continue;

    const TAIL = 1; // param 0 = the main receiver, local 1 = the tail
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: mainStructTypeIdx, fieldIdx: coldSlotFieldIdx },
      { op: "local.set", index: TAIL },
      { op: "local.get", index: TAIL },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // Explicit per-field defaults rather than `struct.new_default`: the
          // emitter's `Instr` union covers `struct.new` only, and the cold list
          // is uniform (`externref` payload + `i32` presence words), so the
          // default vector is two shapes wide.
          ...defaultColdFieldInstrs(ctx, coldStructName),
          { op: "struct.new", typeIdx: coldStructTypeIdx },
          { op: "local.set", index: TAIL },
          { op: "local.get", index: 0 },
          { op: "local.get", index: TAIL },
          { op: "struct.set", typeIdx: mainStructTypeIdx, fieldIdx: coldSlotFieldIdx },
        ],
      },
      { op: "local.get", index: TAIL },
      { op: "ref.as_non_null" },
    ];
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "ref", typeIdx: mainStructTypeIdx }],
      [{ kind: "ref", typeIdx: coldStructTypeIdx }],
      `${name}_type`,
    );
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: [{ name: "__tail", type: { kind: "ref_null", typeIdx: coldStructTypeIdx } }],
      body,
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
  }
}

/**
 * Cold own-fields of one split fnctor, for the object-runtime passes that walk
 * `ctx.structFields` shape-by-shape (hasOwnProperty, `in`,
 * getOwnPropertyNames, keys, for-in, and the computed `__extern_get`). Those
 * passes see only the MAIN struct now — `isSyntheticStructName` hides the tail
 * — so without this they would report a split field as absent, which is the
 * reflective-surface half of the silent-`undefined` risk the dispatchers close.
 */
export function coldOwnFieldsFor(ctx: CodegenContext, mainStructName: string): ColdFieldLocation[] {
  const coldStructName = ctx.fnctorColdTailStructName?.get(mainStructName);
  if (coldStructName === undefined) return [];
  const coldTypeIdx = ctx.structMap.get(coldStructName);
  const out: ColdFieldLocation[] = [];
  for (const field of ctx.structFields.get(coldStructName) ?? []) {
    if (!field?.name || field.name.startsWith("$") || field.name.startsWith("__")) continue;
    for (const loc of findColdStructsForField(ctx, field.name)) {
      if (loc.coldStructTypeIdx === coldTypeIdx) out.push(loc);
    }
  }
  return out;
}

/** The exposed property name a {@link ColdFieldLocation} was found under. */
export function coldFieldNameAt(ctx: CodegenContext, loc: ColdFieldLocation): string | undefined {
  const coldStructName = ctx.typeIdxToStructName.get(loc.coldStructTypeIdx);
  const fields = coldStructName === undefined ? undefined : ctx.structFields.get(coldStructName);
  return fields?.[loc.coldFieldIdx]?.name;
}

/**
 * `i32` on the stack: 1 when the instance carries this cold field.
 *
 * `recv` must be a REPEATABLE producer of the receiver as `anyref` (the
 * object-runtime passes all use `local.get 0` + `any.convert_extern`, which is)
 * — the tail is loaded twice rather than stashed in a scratch local, because
 * those passes' arm builders are local-free by construction and a cold field is
 * by definition not on the hot path.
 */
export function coldFieldPresenceInstrs(loc: ColdFieldLocation, recv: readonly Instr[]): Instr[] {
  const loadTail: Instr[] = [
    ...recv,
    { op: "ref.cast", typeIdx: loc.mainStructTypeIdx },
    { op: "struct.get", typeIdx: loc.mainStructTypeIdx, fieldIdx: loc.coldSlotFieldIdx },
  ];
  const present: Instr[] =
    loc.presenceSlot === undefined
      ? [{ op: "i32.const", value: 1 }]
      : [
          ...loadTail,
          { op: "ref.cast", typeIdx: loc.coldStructTypeIdx },
          ...presenceTestInstrs(loc.coldStructTypeIdx, loc.presenceSlot),
        ];
  return [
    ...loadTail,
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: present,
    },
  ];
}

/** The cold field's VALUE on the stack; `absent` when the tail or bit is missing. */
export function coldFieldValueInstrs(
  loc: ColdFieldLocation,
  recv: readonly Instr[],
  resultType: ValType,
  absent: readonly Instr[],
  coerce: readonly Instr[],
): Instr[] {
  const read: Instr[] = [
    ...recv,
    { op: "ref.cast", typeIdx: loc.mainStructTypeIdx },
    { op: "struct.get", typeIdx: loc.mainStructTypeIdx, fieldIdx: loc.coldSlotFieldIdx },
    { op: "ref.cast", typeIdx: loc.coldStructTypeIdx },
    { op: "struct.get", typeIdx: loc.coldStructTypeIdx, fieldIdx: loc.coldFieldIdx },
    ...coerce,
  ];
  return [
    ...coldFieldPresenceInstrs(loc, recv),
    { op: "if", blockType: { kind: "val", type: resultType }, then: read, else: [...absent] },
  ];
}

/**
 * READ arm for one cold location, for a dispatcher whose receiver is already in
 * `srcAnyLocal` as `anyref` and whose result is `resultType`.
 *
 * `coldAnyLocal` is a scratch `anyref` the caller owns; it holds the tail
 * between the null test and the field read so the `$cold` slot is loaded once.
 * Absent (tail null, or presence bit clear) yields `absent`.
 */
export function coldFieldReadArm(
  loc: ColdFieldLocation,
  srcAnyLocal: number,
  coldAnyLocal: number,
  resultType: ValType,
  absent: Instr[],
  coerce: Instr[],
): Instr[] {
  const readField: Instr[] = [
    { op: "local.get", index: coldAnyLocal },
    { op: "ref.cast", typeIdx: loc.coldStructTypeIdx },
    { op: "struct.get", typeIdx: loc.coldStructTypeIdx, fieldIdx: loc.coldFieldIdx },
    ...coerce,
  ];
  const presenceGuarded: Instr[] =
    loc.presenceSlot === undefined
      ? readField
      : [
          { op: "local.get", index: coldAnyLocal },
          { op: "ref.cast", typeIdx: loc.coldStructTypeIdx },
          { op: "struct.get", typeIdx: loc.coldStructTypeIdx, fieldIdx: loc.presenceSlot.wordFieldIdx },
          { op: "i32.const", value: loc.presenceSlot.mask },
          { op: "i32.and" },
          { op: "i32.const", value: 0 },
          { op: "i32.ne" },
          { op: "if", blockType: { kind: "val", type: resultType }, then: readField, else: absent },
        ];
  return [
    { op: "local.get", index: srcAnyLocal },
    { op: "ref.cast", typeIdx: loc.mainStructTypeIdx },
    { op: "struct.get", typeIdx: loc.mainStructTypeIdx, fieldIdx: loc.coldSlotFieldIdx },
    { op: "local.set", index: coldAnyLocal },
    { op: "local.get", index: coldAnyLocal },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "val", type: resultType }, then: absent, else: presenceGuarded },
  ];
}

/**
 * WRITE arm for one cold location. `recvAnyLocal` holds the receiver as
 * `anyref` (already `ref.test`-proven to be the main struct); `valLocal` holds
 * the boxed value; `coldAnyLocal` is the caller's scratch `anyref`.
 */
export function coldFieldWriteArm(
  loc: ColdFieldLocation,
  recvAnyLocal: number,
  valLocal: number,
  coldAnyLocal: number,
  ensureFuncIdx: number,
  coerce: Instr[],
): Instr[] {
  const out: Instr[] = [
    { op: "local.get", index: recvAnyLocal },
    { op: "ref.cast", typeIdx: loc.mainStructTypeIdx },
    { op: "call", funcIdx: ensureFuncIdx },
    { op: "local.set", index: coldAnyLocal },
    { op: "local.get", index: coldAnyLocal },
    { op: "ref.cast", typeIdx: loc.coldStructTypeIdx },
    { op: "local.get", index: valLocal },
    ...coerce,
    { op: "struct.set", typeIdx: loc.coldStructTypeIdx, fieldIdx: loc.coldFieldIdx },
  ];
  if (loc.presenceSlot !== undefined) {
    out.push(
      ...presenceSetInstrs(loc.coldStructTypeIdx, loc.presenceSlot, [
        { op: "local.get", index: coldAnyLocal },
        { op: "ref.cast", typeIdx: loc.coldStructTypeIdx },
      ]),
    );
  }
  return out;
}
