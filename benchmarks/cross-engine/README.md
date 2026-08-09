# Cross-engine axis benchmark (#3684)

Decomposes runtime performance **by axis** across three engines running the
**same source file** with **identical checksums**:

- **node** (V8, JIT) — the reference
- **Porffor** (`/home/user/porffor`, JS → C → native, `cc -O3 -flto`)
- **js2 standalone** (`--target standalone`, pure WasmGC, zero imports)

## Why this exists

A single aggregate number (e.g. "compiled acorn parses N× slower") conflates
independent axes and has produced wrong conclusions. In particular it
conflates the **js2 host lane's** JS-bridge tax with **codegen quality** — two
completely different problems with different owners. Per-axis numbers separate
them.

`axes-core.js` is deliberately plain ES5 so all three engines accept it
verbatim. Every bench returns a checksum; all three engines must agree, or the
measurement is void.

## Running it

```bash
# node + Porffor (both read the same generated driver)
node benchmarks/cross-engine/run-node-porffor.mjs

# js2 standalone (compiles the same core, times each exported bench)
node --import tsx benchmarks/cross-engine/run-js2.mjs
```

`run-js2.mjs` embeds the string subject in 4 KB chunks — a single 35 KB string
literal overflows the compiler's expression recursion.

## Reading the results

Report **min-of-5** after a warmup call. The absolute numbers are
machine-specific; only the **ratios between engines on the same axis** are
meaningful, and only when the checksums match.

> **Always re-run all three legs together.** Absolute ms are NOT comparable
> across container restarts — this is not a small effect. Measured 2026-07-27:
> after a restart the same node build ran the numeric axis in 2.46 ms where the
> previous instance did 1.25 ms, i.e. **the whole box was ~2x slower**.
> Re-running only the js2 leg and diffing against a previous session's node
> numbers reported "numeric regressed 95%" when nothing had changed — the real
> same-machine ratio was flat at 0.98x. `uptime` is the tell: a low value means
> a fresh instance and every stored absolute is void.

Axes below ~0.1 ms are loop-bound rather than measuring the named operation —
scale the iteration count up before drawing a conclusion. (The first cut of
this harness "measured" `charCodeAt` at a size where deleting `charCodeAt`
entirely did not change the time.)
