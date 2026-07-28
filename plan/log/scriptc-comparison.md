# js2wasm vs vercel-labs/scriptc — comparison notes (2026-07-26)

Source: https://github.com/vercel-labs/scriptc (Apache 2.0). scriptc is
Vercel Labs' TypeScript→**native** compiler: TS → type-checked IR → C or LLVM
→ standalone executable (170–200KB static, ~2.4ms startup, 1–4MB RSS). It
ships its own C runtime (refcounting + cycle collector, stackful fibers, event
loop) and reimplements a large slice of the Node API (fs, net, http/https,
tls, crypto, child_process, fetch). Primary target macOS arm64, cross-compile
to Linux/Windows. No WebAssembly target.

## Shared architectural bets

| Bet | scriptc | js2wasm |
| --- | --- | --- |
| TS types as compiler input | typechecks against real `es2025` lib; decides construct-by-construct what compiles statically | `ctx.oracle`, native type annotations (`type i32 = number`) |
| Typed IR between front-end and multiple backends | IR is "the sole interface"; backends: C and LLVM | `src/ir/` feeding WasmGC (`src/codegen/`) + linear (`src/codegen-linear/`); legacy AST path being ratcheted out (#2855) |
| Tiered dynamism | static / embedded quickjs-ng (`--dynamic`, ~620KB) / hard reject | Wasm-native standalone impls / JS-host import fast path / deferred features |
| Validated trust boundaries | every value crossing into static code runtime-validated; lying type → catchable `TypeError` | boundary coercion layer (`type-coercion.ts`) — validation not yet enforced (see #3680) |

## Fundamental differences

- **Target**: native binaries vs portable sandboxed Wasm (browser/WASI/
  Component Model). They must build GC, fibers, event loop, and the Node API
  themselves; WasmGC + the host give us most of that in JS-host mode.
- **Conformance posture**: scriptc *rejects* what it can't compile correctly
  ("nothing is ever silently miscompiled") and measures byte-for-byte output
  parity with Node over an 800+-program corpus — no test262. We point test262
  at the whole language (29,568/43,097 = 68.6%) and treat failures as the
  roadmap. Their scope is compiler-defined; ours is spec-defined.
- **Dynamic JS**: they delegate `any`-typed / npm-shipped JS to an embedded
  engine or reject it; we compile it (eval/`with` run in test262 and count
  against us).

## Ideas adopted as issues

- #3678 — rejection diagnostics: stable error code + code frame + rewrite hint
- #3679 — `comptime()` build-time evaluation baked as literals
- #3680 — checked casts / runtime-validated trust boundaries
- #3681 — differential whole-program corpus testing vs Node
- #3682 — feasibility record: lowering our middle-end IR to scriptc's IR as a
  native backend (conceivable, not recommended now — see the issue for the
  full analysis)

## Collaboration potential

- **IR sharing is unlikely as a drop-in.** Both IRs are typed and sit between
  a TS front-end and multiple backends, but they encode opposite lowering
  commitments: scriptc's IR assumes refcounted C values, fibers, and native
  calling conventions; ours must stay neutral between WasmGC references and
  linear memory (the whole point of #1527's two-axis split). Merging them
  would force one side's memory model onto the other.
- **Realistic shared surfaces** are above and below the IR, not the IR itself:
  - **Front-end semantics**: "which TS constructs are statically compilable,
    and what does each lower to" — rejection taxonomies (#3678's error codes
    vs their numbered error codes) could converge on shared vocabulary.
  - **Differential-testing corpus**: their 800+ program corpus + our
    playground/equivalence corpus test the identical contract ("compiled TS
    behaves like Node"); a shared, engine-neutral corpus repo would benefit
    both (and Porffor-adjacent projects) the way test262 serves engines.
  - **Divergence ledgers**: both projects need a documented list of deliberate
    Node-behavior divergences; a common format would let tooling compare.
  - **Boundary-validation semantics** (#3680): the "checked cast throws
    TypeError naming the offending path" contract is target-independent and
    worth aligning on.
