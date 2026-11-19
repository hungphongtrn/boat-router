import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, safeLogger } from '../src/redact.mjs';

test('redacts secrets and URL queries in log messages', () => {
  const secrets = ['ghp_exampleSecret123', 'gho_exampleSecret123', 'ghu_exampleSecret123', 'ghs_exampleSecret123', 'ghr_exampleSecret123', 'github_pat_exampleSecret123', 'hnk_exampleSecret123', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature', 'bearerSecret123', 'querySecret123', 'codeSecret123', 'stateSecret123', 'jitSecret123', 'configSecret123', 'a'.repeat(48)]; // gitleaks:allow (fake fixtures)
  const input = `GitHub error https://example.test/callback?token=${secrets[9]}&other=ok ${secrets.slice(0, 8).join(' ')} Bearer ${secrets[8]} code=${secrets[10]} state=${secrets[11]} jit=${secrets[12]} encoded_jit_config=${secrets[13]} ${secrets[14]}`;
  const output = redact(input);
  for (const secret of secrets) assert.ok(!output.includes(secret), `secret leaked: ${secret}`);
  assert.match(output, /https:\/\/example\.test\/callback\?\[REDACTED\]/);
  assert.match(output, /GitHub error/);
});

test('logger redacts each argument before delivery', () => {
  const calls = [];
  safeLogger((...args) => calls.push(args))('error token=example123', 'https://example.test/?code=example456');
  assert.deepEqual(calls, [['error token=[REDACTED]', 'https://example.test/?[REDACTED]']]);
});

test('structured error messages remain valid JSON after redaction', () => {
  const input = JSON.stringify({ event: 'step_error', code: 'GitHub request failed https://api.example/callback?token=secret123&state=abc' });
  const output = redact(input);
  assert.equal(JSON.parse(output).event, 'step_error');
  assert.match(JSON.parse(output).code, /https:\/\/api\.example\/callback\?\[REDACTED\]/);
  assert.ok(!output.includes('secret123'));
  const field = JSON.parse(redact(JSON.stringify({ token: 'secret123' })));
  assert.equal(field.token, '[REDACTED]');
});

test('redacts relative URL queries and partial JWT-shaped values', () => {
  assert.equal(redact('/callback?unrecognized=hidden'), '/callback?[REDACTED]');
  assert.equal(redact('eyJhbGciOiJIUzI1NiJ9'), '[REDACTED]');
});

test('structured provider error fields are omitted from console output', () => {
  let line;
  safeLogger(value => { line = value; })(JSON.stringify({ event: 'step_error', phase: 'booting', code: 'private provider response without a recognizable token' }));
  assert.deepEqual(JSON.parse(line), { event: 'step_error', phase: 'booting', code: '[REDACTED]' });
});
