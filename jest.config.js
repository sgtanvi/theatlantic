module.exports = {
  testEnvironment: 'node',
  testTimeout: 30000,
  testMatch: ['**/tests/**/*.test.js'],
  // Serial execution required: all test files share one postgres database.
  // Parallel runs cause beforeEach(cleanDatabase) from one suite to delete
  // rows that another suite just inserted, producing FK violations and
  // missing-row failures.
  maxWorkers: 1,
};
