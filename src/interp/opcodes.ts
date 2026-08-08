// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — Bytecode interpreter ISA: opcode set + i32 packed encoding.
//
// This is the single source of truth for the register+accumulator opcode set
// (ADR-0019). It is authored in the js2wasm-compilable TypeScript subset — the
// same discipline `src/ir/backend/bytecode-vm.ts` proves (`export const OP =
// {...}`, plain integer members usable as `switch` case labels, no `enum`, no
// numeric `_` separators). E2 (#2928) self-compiles this file; E1 runs it in
// Node.
//
// ── The machine (doc §13 / #3101 "The machine") ──────────────────────────────
// One implicit accumulator `acc` (boxed-any) + a per-frame register file
// `regs[0..regCount)` (boxed-any, mutable). Most ops read/write `acc`; binary
// ops take one register operand and compute `acc = op(regs[r], acc)`.
//
// Register convention (E1 decision, documented in the ADR — the #3101 prose
// left `this`/receiver placement unspecified):
//   regs[0]                      = the receiver (`this`)
//   regs[1 .. 1+paramCount)      = the declared parameters
//   regs[1+paramCount .. )       = locals + expression temporaries
// `__interp_enter` seeds regs[0]=thisArg and regs[1..]=args; a `ThisExpression`
// lowers to `Ldar 0`. Keeping the receiver in a normal register means the
// `$Frame` layout stays exactly the #3101/#2864-coordinated shape (no extra
// field).

// ── Opcode numbers ───────────────────────────────────────────────────────────
// Every opcode is 0..63 so bit 7 (0x80) is always free as the WIDE flag and
// `word & 0x7f` recovers the opcode regardless of the flag. Do NOT renumber a
// landed value: the encoder, loop and disassembler index by it.
//
// #3101's header says "34 ops"; its opcode TABLE enumerates 37 distinct
// mnemonics (verified by count: 9 const/reg + 12 arith/cmp + 4 property +
// 4 variable + 3 call + 4 control + 1 exception). The "34" predates 3 table
// additions; E1 implements all 37 enumerated ops. (ADR-0019 records this.)
export const Op = {
  // ── const / register moves (pool load → acc; acc ↔ reg) ──
  LdaConst: 0, //  LdaConst c      ; acc = consts[c]
  LdaUndef: 1, //  LdaUndef        ; acc = undefined
  LdaNull: 2, //   LdaNull         ; acc = null
  LdaTrue: 3, //   LdaTrue         ; acc = true
  LdaFalse: 4, //  LdaFalse        ; acc = false
  LdaZero: 5, //   LdaZero         ; acc = 0
  Star: 6, //      Star r          ; regs[r] = acc
  Ldar: 7, //      Ldar r          ; acc = regs[r]
  Mov: 8, //       Mov a, b        ; regs[b] = regs[a]

  // ── arithmetic / comparison (acc = op(regs[r], acc); ToPrimitive/ToNumber
  //    live in the generic runtime-op helpers, NOT the loop — doc §13) ──
  Add: 9, //       Add r           ; acc = regs[r] +  acc
  Sub: 10, //      Sub r           ; acc = regs[r] -  acc
  Mul: 11, //      Mul r           ; acc = regs[r] *  acc
  Div: 12, //      Div r           ; acc = regs[r] /  acc
  Mod: 13, //      Mod r           ; acc = regs[r] %  acc
  Neg: 14, //      Neg             ; acc = -acc
  Not: 15, //      Not             ; acc = !acc   (logical NOT, ToBoolean)
  TypeOf: 16, //   TypeOf          ; acc = typeof acc
  Eq: 17, //       Eq r            ; acc = regs[r] ==  acc  (abstract equality)
  StrictEq: 18, // StrictEq r      ; acc = regs[r] === acc  (strict equality)
  Lt: 19, //       Lt r            ; acc = regs[r] <  acc
  Le: 20, //       Le r            ; acc = regs[r] <= acc

  // ── property (route through the SAME dynamic MOP the AOT path uses) ──
  GetProp: 21, //  GetProp c       ; acc = acc[consts[c]]           (named key)
  GetElem: 22, //  GetElem r       ; acc = acc[regs[r]]             (dynamic key)
  SetProp: 23, //  SetProp c, r    ; regs[r][consts[c]] = acc       (named key)
  SetElem: 24, //  SetElem rK, rV  ; regs[rV][regs[rK]] = acc       (dynamic key)

  // ── variables (env-record chain rooted at global — doc §14) ──
  LdGlobal: 25, // LdGlobal c      ; acc = global[consts[c]]        (root-only)
  StGlobal: 26, // StGlobal c      ; global[consts[c]] = acc        (root-only)
  LdName: 27, //   LdName c        ; acc = <resolve consts[c]>      (chain walk)
  StName: 28, //   StName c        ; <assign consts[c]> = acc       (chain walk)

  // ── calls (callee in acc; contiguous register arg-window at rArgsBase:
  //    regs[rArgsBase]=receiver, regs[rArgsBase+1 .. rArgsBase+argc]=args) ──
  Call: 29, //     Call rBase, argc      ; acc = call(acc, window)
  Construct: 30, //Construct rBase, argc ; acc = construct(acc, window)
  CallBuiltin: 31, // CallBuiltin id, rBase, argc ; acc = builtin id(window)

  // ── control (absolute PCs) ──
  Jump: 32, //     Jump t          ; pc = t
  JumpIfTrue: 33, //JumpIfTrue t   ; if (isTruthy(acc)) pc = t
  JumpIfFalse: 34, //JumpIfFalse t ; if (!isTruthy(acc)) pc = t
  Return: 35, //   Return          ; return acc

  // ── exceptions (Throw raises; regions are a SIDE TABLE, not opcodes) ──
  Throw: 36, //    Throw           ; throw acc

  // ── comparison, part 2 (#3356 — appended to keep opcode ids stable) ──
  // `>`/`>=` are NOT desugared to swapped Lt/Le: native `<` is IsLessThan with
  // LeftFirst=true, but §13.10.1 evaluates `a > b` as IsLessThan(b, a,
  // LeftFirst=FALSE) so ToPrimitive still runs in source order (a then b).
  // Native `>`/`>=` carry that flag correctly, so they get their own opcodes.
  Gt: 37, //       Gt r            ; acc = regs[r] >  acc
  Ge: 38, //       Ge r            ; acc = regs[r] >= acc
  InitName: 39, // InitName c      ; initialize predeclared lexical name = acc
  DeleteProp: 40, //DeleteProp c    ; acc = delete acc[consts[c]]
  DeleteElem: 41, //DeleteElem r    ; acc = delete acc[regs[r]]
  DeleteName: 42, //DeleteName c    ; acc = delete <resolved consts[c]>
  Shl: 43, //       Shl r           ; acc = regs[r] << acc
  Shr: 44, //       Shr r           ; acc = regs[r] >> acc
  // ── bitwise, part 2 (#4137 — appended; ToInt32/ToUint32 live in the runtime
  //    helpers exactly like Shl/Shr, so these carry no type assumption) ──
  BitOr: 45, //     BitOr r         ; acc = regs[r] |   acc
  BitAnd: 46, //    BitAnd r        ; acc = regs[r] &   acc
  BitXor: 47, //    BitXor r        ; acc = regs[r] ^   acc
  ShrU: 48, //      ShrU r          ; acc = regs[r] >>> acc
} as const;

/** The number of distinct opcodes (0..OP_COUNT-1). */
export const OP_COUNT = 49;

/** Private CallBuiltin ids used by #2929 lexical-environment mechanics. They
 * remain scalar exports instead of fields on the frozen `Builtin` object so
 * separately compiled callable rec-groups keep their existing shape. */
export const BUILTIN_PUSH_LEXICAL_ENV = 17;
export const BUILTIN_SAVE_ENV = 18;
export const BUILTIN_RESTORE_ENV = 19;
export const BUILTIN_ASSIGN_OUTER_NAME = 20;
export const BUILTIN_DEFINE_CLASS_METHOD = 21;
export const BUILTIN_FINALIZE_CLASS = 22;
/** Object.defineProperty is interpreter-intrinsic because mapped arguments
 * must update/sever their hidden parameter correspondence after a successful
 * ordinary property definition. */
export const BUILTIN_OBJECT_DEFINE_PROPERTY = 23;
/** Bounded Phase-1 enumeration carriers. Both return a boxed value vector;
 * the emitter performs the actual loop and per-iteration binding mechanics. */
export const BUILTIN_FOR_IN_KEYS = 24;
export const BUILTIN_FOR_OF_VALUES = 25;
/** Syntactic `eval(...)` dispatch. The emitter passes the resolved callee in
 * window[0] followed by the evaluated source arguments. The loop performs the
 * required SameValue check against the realm's intrinsic eval function before
 * choosing direct evaluation; a shadow/reassignment remains an ordinary call. */
export const BUILTIN_DIRECT_EVAL = 26;
/** Enter an Object Environment Record for a sloppy `with` statement. The
 * builtin returns the previous chain head so bytecode can restore it on normal
 * and abrupt completion using the existing environment-scope machinery. */
export const BUILTIN_PUSH_OBJECT_ENV = 27;
/** Regular-expression literal construction (#4137). Intrinsic rather than an
 * `LdName "RegExp"` + `Construct` desugar so a user-shadowed `RegExp` binding
 * cannot change the meaning of `/x/g`, and a fresh object is produced on every
 * evaluation of the literal (§13.2.7.3). */
export const BUILTIN_REGEXP_CREATE = 28;

// ── Encoding (doc §"Encoding" / ADR-0019) ────────────────────────────────────
//
// One instruction = one base i32 word:  `op | (a << 8) | (b << 20)`
//   • op — bits 0..7   (opcode 0..63 in bits 0..6; bit 7 = WIDE flag)
//   • a  — bits 8..19  (12-bit unsigned: register / const-pool / small immediate)
//   • b  — bits 20..31 (12-bit unsigned: second register / small immediate)
//
// WIDE (bit 7): when operand `a` (a const-pool index or a jump target) does not
// fit in 12 bits, the base word sets bit 7 and the TRUE value of `a` follows in
// one trailing i32 word. `b` is always packed (register indices, `argc` and
// builtin ids are always < 4096, so `b` never needs to be wide).
//
// Two structural conventions on top of that:
//   • Jumps (Jump / JumpIfTrue / JumpIfFalse) are ALWAYS emitted WIDE, so a
//     forward jump reserves a full trailing target word and back-patching never
//     has to guess a size (the target is unknown at emit time).
//   • CallBuiltin carries a THIRD operand (`argc`) in a trailing word, always:
//     base word packs `a`=builtinId, `b`=rArgsBase; the trailing word is argc.
//     (builtinId/rArgsBase are always < 4096, so CallBuiltin never needs WIDE.)
export const WIDE_FLAG = 0x80;
export const OP_MASK = 0x7f;
export const OPERAND_BITS = 12;
export const OPERAND_MASK = 0xfff; // (1 << 12) - 1
export const A_SHIFT = 8;
export const B_SHIFT = 20;

/** Pack a base instruction word from an opcode (0..63) and two 12-bit operands. */
export function packWord(op: number, a: number, b: number): number {
  // `>>> 0` keeps it an unsigned 32-bit integer (f64-exact); the loop reads it
  // back with `& 0x7f` / `>>> shift`, so the sign of the top bit never matters.
  return ((op | (a << A_SHIFT) | (b << B_SHIFT)) >>> 0) as number;
}

/** Does operand value `v` fit in the packed 12-bit field? */
export function fitsOperand(v: number): boolean {
  return v >= 0 && v <= OPERAND_MASK;
}

// ── Opcode metadata (drives the disassembler + operand-arity assertions) ──────
// operandForm describes how the base word's a/b and any trailing words are used
// so the disassembler and any validator agree with the encoder/loop.
export const OperandForm = {
  None: 0, //        no operands                                (LdaUndef, Neg, Return, …)
  RegA: 1, //        a = register                               (Star, Ldar, Add, GetElem, …)
  RegAB: 2, //       a = register, b = register                 (Mov, SetElem)
  ConstA: 3, //      a = const-pool index (WIDE-capable)        (LdaConst, LdGlobal, LdName, GetProp, …)
  ConstAregB: 4, //  a = const-pool index (WIDE), b = register  (SetProp)
  Target: 5, //      a = absolute PC (always WIDE)              (Jump, JumpIfTrue, JumpIfFalse)
  RegAcountB: 6, //  a = register base, b = count               (Call, Construct)
  Builtin: 7, //     a = builtin id, b = register base, +argc word (CallBuiltin)
} as const;

/** Human-readable mnemonic + operand form for every opcode, indexed by number. */
export interface OpInfo {
  readonly name: string;
  readonly form: number;
}

// Indexed by opcode number (0..OP_COUNT-1). Kept as a plain array literal so the
// disassembler is a direct index, not a map lookup.
export const OP_INFO: OpInfo[] = [
  { name: "LdaConst", form: OperandForm.ConstA }, // 0
  { name: "LdaUndef", form: OperandForm.None }, // 1
  { name: "LdaNull", form: OperandForm.None }, // 2
  { name: "LdaTrue", form: OperandForm.None }, // 3
  { name: "LdaFalse", form: OperandForm.None }, // 4
  { name: "LdaZero", form: OperandForm.None }, // 5
  { name: "Star", form: OperandForm.RegA }, // 6
  { name: "Ldar", form: OperandForm.RegA }, // 7
  { name: "Mov", form: OperandForm.RegAB }, // 8
  { name: "Add", form: OperandForm.RegA }, // 9
  { name: "Sub", form: OperandForm.RegA }, // 10
  { name: "Mul", form: OperandForm.RegA }, // 11
  { name: "Div", form: OperandForm.RegA }, // 12
  { name: "Mod", form: OperandForm.RegA }, // 13
  { name: "Neg", form: OperandForm.None }, // 14
  { name: "Not", form: OperandForm.None }, // 15
  { name: "TypeOf", form: OperandForm.None }, // 16
  { name: "Eq", form: OperandForm.RegA }, // 17
  { name: "StrictEq", form: OperandForm.RegA }, // 18
  { name: "Lt", form: OperandForm.RegA }, // 19
  { name: "Le", form: OperandForm.RegA }, // 20
  { name: "GetProp", form: OperandForm.ConstA }, // 21
  { name: "GetElem", form: OperandForm.RegA }, // 22
  { name: "SetProp", form: OperandForm.ConstAregB }, // 23
  { name: "SetElem", form: OperandForm.RegAB }, // 24
  { name: "LdGlobal", form: OperandForm.ConstA }, // 25
  { name: "StGlobal", form: OperandForm.ConstA }, // 26
  { name: "LdName", form: OperandForm.ConstA }, // 27
  { name: "StName", form: OperandForm.ConstA }, // 28
  { name: "Call", form: OperandForm.RegAcountB }, // 29
  { name: "Construct", form: OperandForm.RegAcountB }, // 30
  { name: "CallBuiltin", form: OperandForm.Builtin }, // 31
  { name: "Jump", form: OperandForm.Target }, // 32
  { name: "JumpIfTrue", form: OperandForm.Target }, // 33
  { name: "JumpIfFalse", form: OperandForm.Target }, // 34
  { name: "Return", form: OperandForm.None }, // 35
  { name: "Throw", form: OperandForm.None }, // 36
  { name: "Gt", form: OperandForm.RegA }, // 37 (#3356)
  { name: "Ge", form: OperandForm.RegA }, // 38 (#3356)
  { name: "InitName", form: OperandForm.ConstA }, // 39 (#2929)
  { name: "DeleteProp", form: OperandForm.ConstA }, // 40 (#2929)
  { name: "DeleteElem", form: OperandForm.RegA }, // 41 (#2929)
  { name: "DeleteName", form: OperandForm.ConstA }, // 42 (#2929)
  { name: "Shl", form: OperandForm.RegA }, // 43 (#4013)
  { name: "Shr", form: OperandForm.RegA }, // 44 (#4013)
  { name: "BitOr", form: OperandForm.RegA }, // 45 (#4137)
  { name: "BitAnd", form: OperandForm.RegA }, // 46 (#4137)
  { name: "BitXor", form: OperandForm.RegA }, // 47 (#4137)
  { name: "ShrU", form: OperandForm.RegA }, // 48 (#4137)
];

// ── Builtin ids (CallBuiltin operand `a`) ────────────────────────────────────
// The interpreter-intrinsic builtins the emitter targets instead of dedicated
// opcodes (doc "Emitter notes"): object/array literals, closure creation, and a
// handful of interpreter helpers. In E2 the generic-runtime ones route through
// the #2927 audited `CallBuiltin(name, recv, argsVec)` surface; the
// interpreter-intrinsic ones (MakeClosure, ObjectLiteral, ArrayLiteral,
// GlobalThis, TypeofName) are frame-aware and handled inside the dispatch loop.
export const Builtin = {
  ObjectLiteral: 0, //  %ObjectLiteral%  — build an object from [k0,v0,k1,v1,…]
  ArrayLiteral: 1, //   %ArrayLiteral%   — build an array from [e0,e1,…]
  MakeClosure: 2, //    %MakeClosure%    — (funcMeta) → interpreted closure value
  GlobalThis: 3, //     %GlobalThis%     — the frame's global object (ThisExpression in global scope)
  TypeofName: 4, //     %TypeofName%     — (name) → typeof of a possibly-undeclared identifier
  Error: 5, //          %Error%          — construct the corresponding native error value
  TypeError: 6, //      %TypeError%
  RangeError: 7, //     %RangeError%
  SyntaxError: 8, //    %SyntaxError%
  ReferenceError: 9, // %ReferenceError%
  Number: 10, //        %Number%         — global numeric coercion
  MathMax: 11, //       %Math.max%       — common host-free Math surface
  MathMin: 12, //       %Math.min%
  MathAbs: 13, //       %Math.abs%
  MathFloor: 14, //     %Math.floor%
  MathCeil: 15, //      %Math.ceil%
  MathRound: 16, //     %Math.round%
} as const;

/** Names for the disassembler's builtin-id rendering, indexed by builtin id. */
export const BUILTIN_NAMES: string[] = [
  "ObjectLiteral",
  "ArrayLiteral",
  "MakeClosure",
  "GlobalThis",
  "TypeofName",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "Number",
  "Math.max",
  "Math.min",
  "Math.abs",
  "Math.floor",
  "Math.ceil",
  "Math.round",
  "PushLexicalEnv",
  "SaveEnv",
  "RestoreEnv",
  "AssignOuterName",
  "DefineClassMethod",
  "FinalizeClass",
  "ObjectDefineProperty",
  "ForInKeys",
  "ForOfValues",
  "DirectEval",
  "PushObjectEnv",
  "RegExpCreate",
];
