import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function runCli(args) {
  const res = spawnSync(process.execPath, ['dist/cli/main.js', ...args], { encoding: 'utf8' });
  return { code: res.status ?? 0, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

const ABS_PATH_RE = /(\/home\/|\/Users\/|[A-Za-z]:\\\\)/;

test('ato gate --help exits 0 and is side-effect free', () => {
  const r = runCli(['gate', '--help']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
  assert.match(r.out, /Usage:\s+ato gate run\|retry\|explain/);
  assert.doesNotMatch(r.out, /\[gate\]\s+start|eslint/);
});

test('ato gate run --help exits 0 and is side-effect free', () => {
  const r = runCli(['gate', 'run', '--help']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
  assert.doesNotMatch(r.out, /\[gate\]\s+start|eslint/);
});

test('ato lock status --json redacts absolute paths', () => {
  const r = runCli(['lock', 'status', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
  assert.doesNotMatch(r.out, ABS_PATH_RE);
});
