// Per-file test timeout for integration and E2E suites. Set here (setupFilesAfterEnv) rather
// than with `testTimeout`, which Jest ignores inside a multi-project run (test/jest-all.json).
jest.setTimeout(30_000);
