# Existing vector refinement PR: prepared dependency join

Continue existing PR5792, “fix(ir): refine vector backing scratch before
construction”, from published c5c87e4abdd58539e22c89d96c4259c344461d40 onto
signed predecessor c77eb9658132ee63cc4ca80128a987c15c4b1d63. Keep the existing
PR held until predecessor5789 is verified delivered through the protected
merge queue. New migration scope remains paused.

The published one-instruction ref.as_non_null refinement remains immediately
before struct.new. The current wasm-constants/lower-contracts imports survive.
The actual composed emitter matches the independently projected commuting
change:85b4a5765a5e690476828251006c97e3f0445817501ece6a6586038178f0da41.
The original published nullability test and historical handoff are unchanged,
and both complete issue histories survive. Nullable/defaultable scratch,
non-null carrier field, allocation/stack order and unsupported-capacity refusal
are unchanged. No new source admission, ABI, schema or runtime body is added.

Actual current-source validation passes56/56 assertions across four complete
files, zero skips: original component population7+10+14 and lowerer import-cycle
population25. Exact source/test/policy/fixture pins remained unchanged. The
positive construction cases validate and instantiate the real lowerer bytes;
cloned countermodels remove exactly one refinement and must fail validation.
These component checks do not certify complete prepared-program consumption.

TS7, LOC/function budgets, oracle and preservation-v1 with required core types
and nodes passed. The unchanged coercion checker through a space-free alias
measured124 files/511 sites against exact predecessor c77eb965. Conformance
synchronization changed zero files. Ordinary spaced-path empty scans receive
no credit. The independent b363f29d test262 checkout verifies53,933 raw blobs,
exact modes/inventory and canonical manifest fcaaff56, with independent objects.
Normal signed hooks and exact-head publication checks remain required.

Execution records are under .tmp/5792-queue-drain. Historical compiler-pair
execution, physical async acceptance and frontend retirement remain uncertified.
Next existing PR5793 consumes native string values; preserve its separate
component and whole-consumer denominators and do not import unpublished work.
