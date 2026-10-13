# Old direct-AST path development freeze

The user has frozen development of the old direct-AST compilation path. Do not add new language features or semantic bug fixes to its expression, statement, function/class body emitters or AST fallback routes. Implement new behavior in the authoritative IR producer/lowerers, or in genuinely shared runtime code when that is the correct semantic owner.

This is a development policy. Keep the old path available for existing CI, comparisons, emergency diagnosis and historical baselines until the separately reviewed retirement criteria are met. Do not disable/delete it, remove its CI coverage, rewrite historical results, or relabel hybrid/IR_FIRST output as complete IR output.

Shared parsing/checker/inference infrastructure used by IR, runtime/resource/provider implementations, test harnesses, measurement/reporting, source custody and build infrastructure may still be repaired or maintained. Identify the real owner and affected callers before deciding that a file is frozen: sharing a directory or importing an old module does not by itself make work an old-path feature. A change that only extends the direct AST body route remains frozen.

Existing source ownership, handoff holds and previously authorized repairs remain in force. Continue their custody, evidence and genuinely shared-runtime/harness work within the actual authorization. A hold is not released by this policy. If a remaining repair requires new old-path semantic development, move the fix to IR/shared runtime or obtain a specific owner/user disposition; do not silently take over a held source or waive its proof requirements.

Test262 numbers must identify the requested compiler path independently from backend, target and harness. Keep default/historical and explicitly selected IR results separate. IR admission requires the genuine prepared-program route, complete source/ABI/body ownership and no old AST generator fallback; a flag, selector claim, patched-function count or IR_FIRST inversion alone is insufficient. Unsupported/unavailable IR compilation remains a compilation refusal, including for runtime-negative tests. Preserve legitimate frontend parse/early negative semantics and existing historical artifacts.

The website's IR view is opt-in through `?ir`. Its toggle selects explicitly identified IR results; it must not reinterpret existing default results or present missing/unqualified IR data as a measured success. This policy adds no enforcement hooks, runtime path switch or new permission to execute, merge, publish or release a hold.
