// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7079) Pure-Wasm `btoa` / `atob` (HTML §8.3 "Base64 utility methods") for
 * the host-free targets.
 *
 * In the JS-host lane both are `env.btoa` / `env.atob` imports supplied by the
 * host's own globals. Under `--target standalone` / `wasi` there is no host, so
 * the import was retained and the WHOLE module failed to instantiate — hono's
 * `utils/encode` (and every test file that reaches it: `utils/encode`,
 * `utils/basic-auth`, `utils/cookie`, …) never ran a single test.
 *
 * Both operate on UTF-16 code units of a native string and return a fresh
 * native string, or `null` when the input is rejected. The CALL SITE turns a
 * `null` into the throw (annexb-escape-call.ts), so these helpers stay free of
 * late imports and string constants — they are emitted from the import
 * collector's finalize, where registering either would shift function indices.
 *
 * `btoa(data)`: every code unit must be ≤ 0xFF (else reject); the units are the
 * bytes, encoded with the standard alphabet and `=` padding.
 *
 * `atob(data)` is the WHATWG "forgiving-base64 decode":
 *  1. ASCII whitespace (TAB, LF, FF, CR, SPACE) is removed;
 *  2. if the length is a multiple of 4, one or two trailing `=` are removed;
 *  3. a remaining length ≡ 1 (mod 4) is rejected;
 *  4. any code unit outside `A-Z a-z 0-9 + /` is rejected;
 *  5. the sextets are concatenated and grouped into bytes; the 4 or 2 leftover
 *     bits of a partial final group are discarded.
 * One pass implements it: `=` is admitted only as one or two trailing units
 * (followed by nothing but whitespace) and only when the padded length is a
 * multiple of 4; the bit accumulator yields exactly ⌊6·m/8⌋ bytes.
 */
import type { Instr, ValType, WasmFunction } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { ensureNativeStringHelpers } from "../native-strings.js";
import { addFuncType } from "../registry/types.js";

export const NATIVE_BTOA = "__btoa";
export const NATIVE_ATOB = "__atob";

const i32: ValType = { kind: "i32" };
const get = (i: number): Instr => ({ op: "local.get", index: i });
const set = (i: number): Instr => ({ op: "local.set", index: i });
const c = (value: number): Instr => ({ op: "i32.const", value });
const add: Instr = { op: "i32.add" };
const inc = (local: number): Instr[] => [get(local), c(1), add, set(local)];

/** `flat = flatten(arg0); data; i = off; end = off + len` — the escape-native prologue. */
function flattenPrologue(ctx: CodegenContext, L: { flat: number; data: number; i: number; end: number }): Instr[] {
  const strTypeIdx = ctx.nativeStrTypeIdx;
  return [
    get(0),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: ctx.nativeStrHelpers.get("__str_flatten")! },
    { op: "ref.cast", typeIdx: strTypeIdx },
    set(L.flat),
    get(L.flat),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    set(L.data),
    get(L.flat),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    set(L.i),
    get(L.i),
    get(L.flat),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    add,
    set(L.end),
  ];
}

/** `while (i < end) { body; i++ }` */
function scanLoop(L: { i: number; end: number }, body: Instr[]): Instr {
  return {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          get(L.i),
          get(L.end),
          { op: "i32.ge_s" },
          { op: "br_if", depth: 1 },
          ...body,
          ...inc(L.i),
          { op: "br", depth: 0 },
        ],
      },
    ],
  };
}

function mint(ctx: CodegenContext, name: string, locals: { name: string; type: ValType }[], body: Instr[]): void {
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  const idx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, idx);
  pushDefinedFunc(ctx, idx, { name, typeIdx, locals, body, exported: false } as unknown as WasmFunction);
}

/** The base64 alphabet character for the sextet `v` (0..63) left on the stack by `vInstrs`. */
function sextetChar(vInstrs: Instr[]): Instr[] {
  const pick = (thenV: Instr[], elseV: Instr[], cond: Instr[]): Instr[] => [
    ...thenV,
    ...elseV,
    ...cond,
    { op: "select" },
  ];
  // v<26 ? v+65 : v<52 ? v+71 : v<62 ? v-4 : v==62 ? 43 : 47
  return pick(
    [...vInstrs, c(65), add],
    pick(
      [...vInstrs, c(71), add],
      pick([...vInstrs, c(4), { op: "i32.sub" }], pick([c(43)], [c(47)], [...vInstrs, c(62), { op: "i32.eq" }]), [
        ...vInstrs,
        c(62),
        { op: "i32.lt_u" },
      ]),
      [...vInstrs, c(52), { op: "i32.lt_u" }],
    ),
    [...vInstrs, c(26), { op: "i32.lt_u" }],
  );
}

/** Emit `__btoa(s: externref) -> externref` (null when a code unit exceeds 0xFF). Idempotent. */
export function emitNativeBtoa(ctx: CodegenContext): void {
  if (ctx.funcMap.has(NATIVE_BTOA)) return;
  ensureNativeStringHelpers(ctx);
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const dataTypeIdx = ctx.nativeStrDataTypeIdx;
  const L = { flat: 1, data: 2, i: 3, end: 4, out: 5, n: 6, acc: 7, cnt: 8, unit: 9 };
  const push = (ch: Instr[]): Instr[] => [
    get(L.out),
    get(L.n),
    ...ch,
    { op: "array.set", typeIdx: dataTypeIdx },
    ...inc(L.n),
  ];
  const accShr = (shift: number): Instr[] => [get(L.acc), c(shift), { op: "i32.shr_u" }, c(63), { op: "i32.and" }];
  const body: Instr[] = [
    ...flattenPrologue(ctx, L),
    // capacity = 4 * ceil(len / 3)
    get(L.flat),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    c(2),
    add,
    c(3),
    { op: "i32.div_u" },
    c(4),
    { op: "i32.mul" },
    { op: "array.new_default", typeIdx: dataTypeIdx },
    set(L.out),
    scanLoop(L, [
      get(L.data),
      get(L.i),
      { op: "array.get_u", typeIdx: dataTypeIdx },
      set(L.unit),
      // A code unit above 0xFF is not a byte: InvalidCharacterError.
      get(L.unit),
      c(0xff),
      { op: "i32.gt_u" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
      get(L.acc),
      c(8),
      { op: "i32.shl" },
      get(L.unit),
      { op: "i32.or" },
      set(L.acc),
      ...inc(L.cnt),
      get(L.cnt),
      c(3),
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...push(sextetChar(accShr(18))),
          ...push(sextetChar(accShr(12))),
          ...push(sextetChar(accShr(6))),
          ...push(sextetChar(accShr(0))),
          c(0),
          set(L.acc),
          c(0),
          set(L.cnt),
        ],
      },
    ]),
    // Partial final group: 1 byte → 2 chars + "==", 2 bytes → 3 chars + "=".
    get(L.cnt),
    c(1),
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(L.acc),
        c(16),
        { op: "i32.shl" },
        set(L.acc),
        ...push(sextetChar(accShr(18))),
        ...push(sextetChar(accShr(12))),
        ...push([c(61)]),
        ...push([c(61)]),
      ],
    },
    get(L.cnt),
    c(2),
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(L.acc),
        c(8),
        { op: "i32.shl" },
        set(L.acc),
        ...push(sextetChar(accShr(18))),
        ...push(sextetChar(accShr(12))),
        ...push(sextetChar(accShr(6))),
        ...push([c(61)]),
      ],
    },
    get(L.n),
    c(0),
    get(L.out),
    { op: "struct.new", typeIdx: strTypeIdx },
    { op: "extern.convert_any" },
  ];
  mint(
    ctx,
    NATIVE_BTOA,
    [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      { name: "data", type: { kind: "ref", typeIdx: dataTypeIdx } },
      { name: "i", type: i32 },
      { name: "end", type: i32 },
      { name: "out", type: { kind: "ref", typeIdx: dataTypeIdx } },
      { name: "n", type: i32 },
      { name: "acc", type: i32 },
      { name: "cnt", type: i32 },
      { name: "unit", type: i32 },
    ],
    body,
  );
}

/** Emit `__atob(s: externref) -> externref` (null when the input is not forgiving-base64). Idempotent. */
export function emitNativeAtob(ctx: CodegenContext): void {
  if (ctx.funcMap.has(NATIVE_ATOB)) return;
  ensureNativeStringHelpers(ctx);
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const dataTypeIdx = ctx.nativeStrDataTypeIdx;
  const L = { flat: 1, data: 2, i: 3, end: 4, out: 5, n: 6, acc: 7, bits: 8, unit: 9, m: 10, pad: 11, v: 12 };
  const reject: Instr[] = [{ op: "ref.null.extern" }, { op: "return" }];
  const unitIs = (code: number): Instr[] => [get(L.unit), c(code), { op: "i32.eq" }];
  const unitIn = (lo: number, hi: number): Instr[] => [
    get(L.unit),
    c(lo),
    { op: "i32.sub" },
    c(hi - lo),
    { op: "i32.le_u" },
  ];
  // v = sextet(unit), or -1 when unit is not in the alphabet.
  const sextetOfUnit: Instr[] = [
    c(-1),
    set(L.v),
    ...unitIn(65, 90),
    { op: "if", blockType: { kind: "empty" }, then: [get(L.unit), c(65), { op: "i32.sub" }, set(L.v)] },
    ...unitIn(97, 122),
    { op: "if", blockType: { kind: "empty" }, then: [get(L.unit), c(71), { op: "i32.sub" }, set(L.v)] },
    ...unitIn(48, 57),
    { op: "if", blockType: { kind: "empty" }, then: [get(L.unit), c(4), add, set(L.v)] },
    ...unitIs(43),
    { op: "if", blockType: { kind: "empty" }, then: [c(62), set(L.v)] },
    ...unitIs(47),
    { op: "if", blockType: { kind: "empty" }, then: [c(63), set(L.v)] },
  ];
  const isWhitespace: Instr[] = [
    ...unitIs(0x20),
    ...unitIs(0x09),
    { op: "i32.or" },
    ...unitIs(0x0a),
    { op: "i32.or" },
    ...unitIs(0x0c),
    { op: "i32.or" },
    ...unitIs(0x0d),
    { op: "i32.or" },
  ];
  const body: Instr[] = [
    ...flattenPrologue(ctx, L),
    // capacity = len (never more bytes than input units)
    get(L.flat),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "array.new_default", typeIdx: dataTypeIdx },
    set(L.out),
    scanLoop(L, [
      get(L.data),
      get(L.i),
      { op: "array.get_u", typeIdx: dataTypeIdx },
      set(L.unit),
      ...isWhitespace,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [],
        else: [
          ...unitIs(61),
          {
            op: "if",
            blockType: { kind: "empty" },
            // '=': at most two, and only trailing.
            then: [
              ...inc(L.pad),
              get(L.pad),
              c(2),
              { op: "i32.gt_u" },
              { op: "if", blockType: { kind: "empty" }, then: reject },
            ],
            else: [
              // An alphabet unit after '=' (or any non-alphabet unit) rejects.
              get(L.pad),
              { op: "if", blockType: { kind: "empty" }, then: reject },
              ...sextetOfUnit,
              get(L.v),
              c(0),
              { op: "i32.lt_s" },
              { op: "if", blockType: { kind: "empty" }, then: reject },
              ...inc(L.m),
              get(L.acc),
              c(6),
              { op: "i32.shl" },
              get(L.v),
              { op: "i32.or" },
              c(0xffffff),
              { op: "i32.and" },
              set(L.acc),
              get(L.bits),
              c(6),
              add,
              set(L.bits),
              get(L.bits),
              c(8),
              { op: "i32.ge_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  get(L.bits),
                  c(8),
                  { op: "i32.sub" },
                  set(L.bits),
                  get(L.out),
                  get(L.n),
                  get(L.acc),
                  get(L.bits),
                  { op: "i32.shr_u" },
                  c(0xff),
                  { op: "i32.and" },
                  { op: "array.set", typeIdx: dataTypeIdx },
                  ...inc(L.n),
                ],
              },
            ],
          },
        ],
      },
    ]),
    // Padding is admitted only when it completes a multiple of 4.
    get(L.pad),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(L.m),
        get(L.pad),
        add,
        c(3),
        { op: "i32.and" },
        { op: "if", blockType: { kind: "empty" }, then: reject },
      ],
    },
    // A lone trailing sextet cannot encode a byte.
    get(L.m),
    c(3),
    { op: "i32.and" },
    c(1),
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then: reject },
    get(L.n),
    c(0),
    get(L.out),
    { op: "struct.new", typeIdx: strTypeIdx },
    { op: "extern.convert_any" },
  ];
  mint(
    ctx,
    NATIVE_ATOB,
    [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      { name: "data", type: { kind: "ref", typeIdx: dataTypeIdx } },
      { name: "i", type: i32 },
      { name: "end", type: i32 },
      { name: "out", type: { kind: "ref", typeIdx: dataTypeIdx } },
      { name: "n", type: i32 },
      { name: "acc", type: i32 },
      { name: "bits", type: i32 },
      { name: "unit", type: i32 },
      { name: "m", type: i32 },
      { name: "pad", type: i32 },
      { name: "v", type: i32 },
    ],
    body,
  );
}
