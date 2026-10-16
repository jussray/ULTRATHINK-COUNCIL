import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTapSummary, verifyTapSummary, runStrictTests } from '../scripts/strict-tests.mjs';

const report = (overrides={}) => {
  const data = {tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...overrides};
  return ['TAP version 13', ...Object.entries(data).map(([key, value]) => `# ${key} ${value}`)].join('\n');
};
test('strict gate parses a complete TAP summary', () => {
  assert.deepEqual(verifyTapSummary(report()), {tests:2,pass:2,fail:0,cancelled:0,skipped:0,todo:0});
});
test('strict gate rejects any failed test', () => {
  assert.throws(() => verifyTapSummary(report({fail:1,pass:1})), /fail: 1/);
});
test('strict gate rejects any skipped test', () => {
  assert.throws(() => verifyTapSummary(report({skipped:1,pass:1})), /skipped: 1/);
});
test('strict gate rejects TODO tests instead of reporting green', () => {
  assert.throws(() => verifyTapSummary(report({todo:1,pass:1})), /todo: 1/);
});
test('strict gate rejects cancelled tests and incomplete counts', () => {
  assert.throws(() => verifyTapSummary(report({cancelled:1,pass:1})), /cancelled: 1/);
  assert.throws(() => verifyTapSummary(report({pass:1})), /Incomplete/);
});
test('strict gate rejects no tests, missing summary and repeated summary', () => {
  assert.throws(() => verifyTapSummary(report({tests:0,pass:0})), /No tests/);
  assert.throws(() => verifyTapSummary('TAP version 13\n# tests 1'), /Missing/);
  assert.throws(() => parseTapSummary(report()+'\n# pass 2'), /Repeated/);
});
test('strict gate reads nested test files and executes all rather than hardcoding one', () => {
  const root = mkdtempSync(join(tmpdir(),'council-strict-'));
  try {
    mkdirSync(join(root,'test','nested'),{recursive:true});
    writeFileSync(join(root,'test','nested','sample.test.mjs'),
      "import test from 'node:test'; test('works',()=>{});\n");
    const counts=runStrictTests(root);
    assert.equal(counts.tests,1);
    assert.equal(counts.skipped,0);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('strict gate detects actual runtime skip in a discovered test file', () => {
  const root=mkdtempSync(join(tmpdir(),'council-skipped-'));
  try {
    mkdirSync(join(root,'test'),{recursive:true});
    writeFileSync(join(root,'test','skip.test.mjs'),
      "import test from 'node:test'; test.skip('hidden',()=>{});\n");
    assert.throws(() => runStrictTests(root), /skipped: 1/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('strict gate detects actual runtime TODO in a discovered test file', () => {
  const root=mkdtempSync(join(tmpdir(),'council-todo-'));
  try {
    mkdirSync(join(root,'test'),{recursive:true});
    writeFileSync(join(root,'test','todo.test.mjs'),
      "import test from 'node:test'; test.todo('unfinished');\n");
    assert.throws(() => runStrictTests(root), /todo: 1/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('strict gate detects an actual failed test process', () => {
  const root=mkdtempSync(join(tmpdir(),'council-failing-'));
  try {
    mkdirSync(join(root,'test'),{recursive:true});
    writeFileSync(join(root,'test','failure.test.mjs'),
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('broken',()=>assert.equal(1,2));\n");
    assert.throws(() => runStrictTests(root), /fail: 1/);
  } finally {rmSync(root,{recursive:true,force:true});}
});