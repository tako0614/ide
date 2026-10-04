import assert from 'node:assert/strict';
import { observeDescriptorValidationFailures } from '../src/computer/descriptor-validation.ts';
import { test } from 'node:test';
import { DescriptorValidationError, rejectDescriptorValidation,
  descriptorValidationBoundary } from '../src/computer/descriptor-validation.ts';

test('validation diagnostics allow lifecycle fields but discard authority, IDs and raw exceptions', () => {
  const secret = 'secret-authority-token-private-environment';
  const rows = [];
  const listener = row => rows.push(row); const stop = observeDescriptorValidationFailures(listener);
  try {
    const cause = Object.assign(new SyntaxError(secret), { code: 'EACCES', path: secret });
    let error;
    try {
      rejectDescriptorValidation('descriptor.parse', { role: secret, pid: 321,
        field: 'comm', expected: 'python3', observed: secret, authority: secret,
        sessionId: 'a'.repeat(32), environment: secret }, cause, secret);
    } catch (caught) { error = caught; }
    assert.ok(error instanceof DescriptorValidationError);
    assert.deepEqual(error.diagnostic, { kind: 'rejection', predicate: 'descriptor.parse',
      pid: 321, field: 'comm', expected: 'python3', observed: 'INVALID',
      errno: 'EACCES', errorType: 'SyntaxError' });
    assert.equal(error.cause, undefined);
    const wrapped = descriptorValidationBoundary('lease.load.catch', error);
    assert.equal(wrapped.diagnostic.predicate, 'descriptor.parse');
    assert.equal(wrapped.code, 'EACCES');
    assert.deepEqual(wrapped.diagnostic.boundaries, ['lease.load.catch']);
    const bytes = JSON.stringify({ rows, message: error.message, stack: error.stack,
      wrapped: wrapped.diagnostic });
    assert.ok(!bytes.includes(secret)); assert.ok(!bytes.includes('a'.repeat(32)));
  } finally { stop(); }
});

test('unexpected catches retain fixed errno/type and never serialize parser text or arbitrary stack', () => {
  const secret = 'secret-parser-auth-body';
  const cause = Object.assign(new SyntaxError(secret), { code: 'SECRET', stack: secret });
  const error = descriptorValidationBoundary('lease.load.catch', cause);
  assert.deepEqual(error.diagnostic, { kind: 'catch', predicate: 'lease.load.catch', errorType: 'SyntaxError' });
  assert.ok(!JSON.stringify(error).includes(secret)); assert.ok(!error.message.includes(secret));
});

test('throwing reporters and exception getters cannot replace a validation rejection or skip its catch', async () => {
  const secret = 'private-getter-or-reporter-text';
  const stop = observeDescriptorValidationFailures(() => { throw new Error(secret); });
  const stopAsync = observeDescriptorValidationFailures(async () => { throw new Error(secret); });
  const cause = new Error(secret);
  Object.defineProperty(cause, 'code', { get() { throw new Error(secret); } });
  Object.defineProperty(cause, 'name', { get() { throw new Error(secret); } });
  let cleanupReached = false;
  try {
    try { rejectDescriptorValidation('descriptor.identity', { pid: 321, field: 'ppid', expected: 2, observed: 1 }, cause); }
    catch (error) {
      const kept = descriptorValidationBoundary('owner.start_new', error);
      cleanupReached = true;
      assert.equal(kept.diagnostic.predicate, 'descriptor.identity');
      assert.equal(kept.diagnostic.observed, 1);
      assert.ok(!JSON.stringify(kept).includes(secret));
    }
    assert.equal(cleanupReached, true);
    await new Promise(resolve => setImmediate(resolve));
  } finally { stop(); stopAsync(); }
});
