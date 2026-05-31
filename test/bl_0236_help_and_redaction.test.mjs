import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_PATH = resolve('dist/cli/main.js');

function runCli(args, options = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    ...options,
  });
  return { code: res.status ?? 0, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

const ABS_PATH_RE = /(\/home\/|\/Users\/|[A-Za-z]:\\\\)/;

test('ato gate --help exits 0 and is side-effect free', () => {
  const r = runCli(['gate', '--help']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
  assert.match(r.out, /Usage:\s+ato gate run\|explain/);
  assert.doesNotMatch(r.out, /\[gate\]\s+start|eslint/);
});

test('ato gate run --help exits 0 and is side-effect free', () => {
  const r = runCli(['gate', 'run', '--help']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
  assert.doesNotMatch(r.out, /\[gate\]\s+start|eslint/);
});

test('ato gate explain rejects unknown options', () => {
  const r = runCli(['gate', 'explain', '--unknown-option', '--json']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Unknown option: --unknown-option/);
});

test('ato lock status --json redacts absolute paths', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ato-lock-status-'));
  mkdirSync(join(cwd, '.ato'), { recursive: true });
  writeFileSync(
    join(cwd, '.ato', 'config.json'),
    `${JSON.stringify({
      version: 1,
      targetId: 'tmp',
      storeDir: '.ato',
      fingerprintSeed: 'lock-status-redaction',
    })}\n`,
    'utf8',
  );
  writeFileSync(
    join(cwd, 'AGENTS.md'),
    '<!-- ATO_PROTOCOL_VERSION: 1 -->\n<!-- ATO_MIN_CLI_VERSION: 0.1.0 -->\n',
    'utf8',
  );
  const r = runCli(['lock', 'status', '--json'], { cwd });
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.out}`);
  assert.doesNotMatch(r.out, ABS_PATH_RE);
});
