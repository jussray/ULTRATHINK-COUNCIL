/**
 * Run every Node test file and fail closed if any test is failed, skipped,
 * cancelled, or still TODO. No tests (or no usable TAP summary) is failure.
 * This guards the test suite, not live Council Bus or provider integrations.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

export function parseTapSummary(tap) {
  if (typeof tap !== 'string') throw new Error('TAP text required');
  const found = new Map();
  for (const line of tap.split(/\r?\n/)) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) ([0-9]+)$/.exec(line);
    if (!match) continue;
    if (found.has(match[1])) throw new Error(`Repeated TAP summary: ${match[1]}`);
    found.set(match[1], Number(match[2]));
  }
  for (const key of KEYS) {
    if (!found.has(key) || !Number.isSafeInteger(found.get(key))) {
      throw new Error(`Missing or invalid TAP summary: ${key}`);
    }
  }
  return Object.fromEntries(found);
}

export function verifyTapSummary(tap) {
  const counts = parseTapSummary(tap);
  if (counts.tests === 0) throw new Error('No tests executed');
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) {
    if (counts[key] !== 0) throw new Error(`Tests ${key}: ${counts[key]}`);
  }
  if (counts.pass !== counts.tests) {
    throw new Error(`Incomplete test execution: ${counts.pass}/${counts.tests} passed`);
  }
  return counts;
}

function discoverTestFiles(folder, base, output) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = resolve(folder, entry.name);
    if (entry.isDirectory()) discoverTestFiles(full, base, output);
    else if (entry.isFile() && /\.test\.(?:mjs|cjs|js)$/.test(entry.name)) {
      output.push(relative(base, full));
    }
  }
}

export function runStrictTests(cwd = process.cwd()) {
  const files = [];
  discoverTestFiles(resolve(cwd, 'test'), cwd, files);
  files.sort();
  if (!files.length) throw new Error('No test files discovered');
  // Nested runner tests inherit NODE_TEST_CONTEXT from their test worker.
  // Remove it for the child CLI so we actually run the intended test files.
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) throw child.error;
  const counts = verifyTapSummary(child.stdout ?? '');
  if (child.status !== 0) throw new Error(`Node test runner failed: exit ${child.status}`);
  console.log(`Strict test gate: ${counts.pass}/${counts.tests} passed, zero failed/skipped/todo/cancelled.`);
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runStrictTests(); }
  catch (error) { console.error(`Strict test gate failed: ${error.message}`); process.exitCode = 1; }
}