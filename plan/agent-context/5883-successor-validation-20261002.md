# Historical Promise reader acceptance checkpoint

Subject: working tree on5c63aae46653370f5a2169dd08947d5c69b568e8,
including main2b8101b9bc9a1910ce32a26e5b74e8a503f5b471. Test infrastructure
only; no production, historical fixture, classification, allowance or gate edits.

## Evidence and preserved failures

The original pre/post-relocation176 rows and two collection failures remain in
5883-relocation-validation-exact-20261002.json.txt. Original91 failures are not
erased. The first successor run66222/83787 had836 passing assertions but exited1
on an unhandled onTaskUpdate RPC timeout. Preserve its complete raw/native
outputs, terminal and before/after manifests; it is not accepted as green.

Independent review identified a flat-only reader contract conflict. The repair
keeps that public reader and its unchanged56 controls; a separate historical
reader supplies the older authenticated view. The earlier suite now yields
between cases to avoid starving the worker's RPC. No timeout increases, skipped
cases, swallowed errors or changed assertions. New receipt formatting preserves
deep JSON equality; original receipt hashes are unchanged.

## Measured acceptance

- Second run79147/85931:892/892 across six suites, exit0, no unhandled errors,
  all7183 source/test/config pins unchanged. Original176 identities match exactly:
  layout31 and native145. Earlier216 and export24 now execute, not merely
  collect. New successor controls420 and unchanged flat controls56 pass.
- Runtime1025/86619:183/183 across thirteen suites, exit0, unchanged pins:
  original104 runtime,56 relocation and23 incoming built-in tests. Incoming
  S16's removed own-name assertion is still not certified by this population.
- Parent verified118 Git source/dependency/provenance pins, seven operands,
  47 spans,54 retained regions,27 dependencies and14 producing commits.
- Independent Sol-6.1 Medium review clears the amended reader boundaries,
  original assertions/mutants, scheduling-only yield and formatting-only receipt.

- Gates74842/86825: canonical, inventory-only, cycles, flat directory, LOC,
  function budget, coercion and oracle all exit0; frozen inputs unchanged.
  No allowance, gate or compiler baseline changes.

The reproducible exact archive includes initial failure and accepted results;
each gzip+base64 stream records length and SHA256, checked after decoding.

This reconstructs historical source obligations while authenticating current
owners. It does not claim current semantics equal the initial extraction,
complete-mode architecture acceptance, full IR equivalence or legacy retirement.
PR5883 remains held until remaining landing obligations and current protected
queue evidence justify removing that hold. No work is counted as delivered
until verified on loopdive/js2 main.
