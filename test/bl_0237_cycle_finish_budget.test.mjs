import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  buildFinishProgressPayload,
  buildBudgetExhaustedPayload,
} from '../dist/cli/commands/cycle-finish-budget.js';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliPath = path.join(repoRoot, 'dist', 'cli', 'main.js');

const runCli = (args, cwd) =>
  spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd });

test('cycle finish --help exits 0 and is side-effect free', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ato-cycle-help-'));
  const res = runCli(['cycle', 'finish', '--help'], tmp);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\n${res.stderr}`);
  assert.match(res.stdout, /--budget-ms/);
  const lockPath = path.join(tmp, '.ato', 'lock.json');
  assert.equal(fs.existsSync(lockPath), false, 'help should not create lock');
});

test('budget progress payload shape is stable', () => {
  const payload = buildFinishProgressPayload({
    cycleId: 'CY-0000',
    step: 'gate.run',
    elapsedMs: 123,
    budgetMs: 9000,
    now: 0,
  });
  assert.equal(payload.schema_version, 'cycle-finish-progress.v1');
  assert.equal(payload.cycle_id, 'CY-0000');
  assert.equal(payload.step, 'gate.run');
  assert.equal(payload.elapsed_ms, 123);
  assert.equal(payload.budget_ms, 9000);
  assert.equal(payload.updated_at, new Date(0).toISOString());
});

test('budget exhausted payload shape is stable', () => {
  const payload = buildBudgetExhaustedPayload({
    cycleId: 'CY-0000',
    step: 'pack.verify',
    elapsedMs: 9100,
    budgetMs: 9000,
    progressPath: '.ato/cycles/CY-0000/finish-progress.json',
  });
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'BUDGET_EXHAUSTED');
  assert.equal(payload.error.message, 'Cycle finish budget exhausted.');
  assert.equal(payload.error.details.cycle_id, 'CY-0000');
  assert.equal(payload.error.details.step, 'pack.verify');
  assert.equal(payload.error.details.elapsed_ms, 9100);
  assert.equal(payload.error.details.budget_ms, 9000);
  assert.equal(payload.error.details.progress_path, '.ato/cycles/CY-0000/finish-progress.json');
  assert.deepEqual(payload.error.details.suggested_commands, [
    'ato cycle finish --json --budget-ms 9000',
    'ato cycle finish --json --budget-ms 18000',
  ]);
});
