// The deploy's test gate when the tests run with coverage: reads Vitest's JSON results and fails only on a failed test or
// suite, or on missing / empty results. Under V8 coverage the busy main process can make Vitest report internal
// "[vitest-worker]: Timeout calling onTaskUpdate" errors, and exit 1, after every test has passed; those must not
// block the deploy. Pull requests still run the plain `npx vitest run` (ci.yml), where any unhandled error fails.
//
//   node tools/check-test-results.mjs [coverage/test-results.json]
import fs from 'node:fs';

const file = process.argv[2] ?? 'coverage/test-results.json';
if (!fs.existsSync(file)) {
  console.error(`no test results at ${file}: the test run did not finish`);
  process.exit(1);
}
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
const failedFiles = (r.testResults ?? []).filter((t) => t.status === 'failed').map((t) => t.name);
console.log(`tests: ${r.numPassedTests}/${r.numTotalTests} passed, ${r.numFailedTests} failed; files: ${r.numFailedTestSuites} failed of ${r.numTotalTestSuites}`);
if (!r.numTotalTests || r.numFailedTests > 0 || r.numFailedTestSuites > 0 || failedFiles.length) {
  for (const f of failedFiles) console.error(`failed: ${f}`);
  process.exit(1);
}
