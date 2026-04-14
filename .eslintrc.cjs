/**
 * Boundary rule: oliver-agent cannot import from apps/*.
 *
 * Oliver is a harness that should be extractable to a standalone repo
 * via `git subtree split --prefix=packages/oliver` at any time. Importing
 * from apps/* would couple the harness to Kotte and break extraction.
 *
 * If you need something from apps/*:
 *   1. Copy the function into packages/oliver/src/lib/
 *   2. Extract it into a shared package (e.g., @repo/database)
 *   3. Refactor the caller to pass it in via ctx or config
 */
module.exports = {
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              "@/*",
              "../../../apps/*",
              "../../apps/*",
              "../apps/*",
              "apps/*",
            ],
            message:
              "packages/oliver cannot import from apps/* — boundary violation. Either copy the function into packages/oliver/src/lib/ or extract it into a shared package.",
          },
        ],
      },
    ],
  },
};
