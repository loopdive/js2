# First dormant raw-copy validation and unrun harness correction

All validation terminal; compiler slot returned. TS7 handle 46409 exit 1.
Structural command completed exit 0; real-Wasm command completed exit 1.
No process restarted, no rerun, no production activation.

Original 27: 26 pass, 1 fail (structural 11/11, original Wasm 15/16).
Supplemental 2: 1 pass, 1 fail. Total 29: 27 pass, 2 fail.
Both runtime failures occurred before copy invocation, at negated opaque-reference
identity assertions (original line 111, supplemental line 215). These cases do not
yet establish copying correctness. The log alone does not establish whether the
references actually compare equal: primitive boolean assertions will expose that.

TS7: two existing missing emission-ownership module import diagnostics in
native-proto-demand.ts; two authored BufferSource diagnostics at Wasm test 88/89.

Frozen first subject SHA256:
- module: 6ee057d700f7b0a049e5f9b7d8128a4b03459ae8992998d6c9ea2680aa5aa78f
- structural test: 14480e3f4f8f5502dc2b616dc25dfc72301d37eba590c3361911efac1f55fb8a
- Wasm test: 94a4ff36f209e68e53fe24975daa5657895193c71f14e44726965383b31d0f3b
Exact original Wasm source retained as 5748-raw-copy-first-wasm-source.ts here.

First logs (same directory), SHA256:
- 5748-raw-copy-first-ts7.log: ba5b40fd92f30fbb4abb46a10f92ed9a7efb706fe86a0ad3c64919b7599791ef
- 5748-raw-copy-first-structural.log: 1cd5afd20f2799fe49a28451dd015c2218c63046d1f4f2cc9f54fa818662b4ae
- 5748-raw-copy-first-wasm.log: 90e0285474f1556e43d41a6cd3f213272da56cea5702b003642bb70d7b7e867d

Source-only correction after terminal:
- Uint8Array.from(emitBinary(mod)) gives an owned ArrayBuffer-backed byte copy,
  without an assertion cast or changing emitted bytes.
- All three negated opaque-reference identity checks now assert Object.is(a,b)
  is false. This retains the same identity requirement, and an actual equality
  fails as true versus false rather than asking the formatter to inspect GC refs.
- Production builder, structural tests, all populations and copy expectations
  unchanged. No acceptance claim; corrected subject remains unrun.

Corrected Wasm test SHA256:
c5f4273503e8546b07d6ac057eb7efca5ae603eb622cd8877d2a912129fe56de
