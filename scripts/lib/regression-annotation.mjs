// (#7551) Title of the error annotation in which the IR current-edition gate
// names its regressed tests (scripts/test262-edition-scope.ts writes it) and
// which auto-park copies into its park comment
// (scripts/auto-park-merge-group-failure.mjs reads it). One definition, so the
// writer and the reader cannot drift apart.
export const REGRESSION_ANNOTATION_TITLE = "test262 regressions (#7551)";
