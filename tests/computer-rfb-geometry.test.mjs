import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const candidateRoot = process.env.DECKIDE_CANDIDATE_PACKAGE_ROOT;
const rfbModule = candidateRoot
  ? pathToFileURL(path.join(candidateRoot, 'dist/computer/rfb.js')).href
  : new URL('../src/computer/rfb.ts', import.meta.url).href;
const { RfbClientGate, RfbServerProtocolError } = await import(rfbModule);

const WIDTH = 1440;
const HEIGHT = 960;
const version = (minor) => Buffer.from(`RFB 003.${minor}\n`, 'ascii');
const securityOffer = Buffer.from([1, 2]);
const security33 = Buffer.from([0, 0, 0, 2]);
const challenge = Buffer.from('synthetic-rfb-ch', 'ascii');
const response = Buffer.from('synthetic-rfb-rs', 'ascii');
const success = Buffer.alloc(4);

function serverInit(width = WIDTH, height = HEIGHT, name = 'sealed desktop') {
  const label = Buffer.from(name, 'utf8');
  const result = Buffer.alloc(4 + 16 + 4 + label.length);
  result.writeUInt16BE(width, 0);
  result.writeUInt16BE(height, 2);
  result.writeUInt32BE(label.length, 20);
  label.copy(result, 24);
  return result;
}

function gate(input = () => true) { return new RfbClientGate(WIDTH, HEIGHT, input); }

/** Establish the prefix through ClientInit, leaving the server-init witness pending. */
function authenticatedPrefix(target, minor = '008') {
  assert.deepEqual(Buffer.concat(target.observeServer(version(minor))), version(minor));
  assert.deepEqual(target.acceptClient(version(minor)), [version(minor)]);
  const offer = minor === '003' ? security33 : securityOffer;
  assert.deepEqual(Buffer.concat(target.observeServer(offer)), offer);
  if (minor !== '003') assert.deepEqual(target.acceptClient(Buffer.from([2])), [Buffer.from([2])]);
  assert.deepEqual(Buffer.concat(target.observeServer(challenge)), challenge);
  assert.deepEqual(target.acceptClient(response), [response]);
  assert.deepEqual(Buffer.concat(target.observeServer(success)), success);
  assert.deepEqual(target.acceptClient(Buffer.from([1])), [Buffer.from([1])]);
}

function pointer(x, y, mask = 1) {
  const value = Buffer.alloc(6);
  value[0] = 5; value[1] = mask;
  value.writeUInt16BE(x, 2); value.writeUInt16BE(y, 4);
  return value;
}
function update(x, y, width, height) {
  const value = Buffer.alloc(10);
  value[0] = 3;
  value.writeUInt16BE(x, 2); value.writeUInt16BE(y, 4);
  value.writeUInt16BE(width, 6); value.writeUInt16BE(height, 8);
  return value;
}
function key(code, down = true) {
  const value = Buffer.alloc(8);
  value[0] = 4; value[1] = down ? 1 : 0;
  value.writeUInt32BE(code, 4);
  return value;
}

test('3.8 and 3.7 fragmented handshakes seal 1440x960 before input or framebuffer data', () => {
  for (const minor of ['008', '007']) {
    const seen = [];
    const target = gate((kind, active) => { seen.push([kind, active]); return true; });
    const feed = (bytes) => Buffer.concat([...bytes].flatMap((byte) => target.observeServer(Buffer.from([byte]))));
    assert.deepEqual(feed(version(minor)), version(minor));
    assert.deepEqual(target.acceptClient(version(minor)), [version(minor)]);
    assert.deepEqual(feed(securityOffer), securityOffer);
    assert.deepEqual(target.acceptClient(Buffer.from([2])), [Buffer.from([2])]);
    assert.deepEqual(feed(challenge), challenge);
    assert.deepEqual(target.acceptClient(response), [response]);
    assert.deepEqual(feed(success), success);
    assert.deepEqual(target.acceptClient(Buffer.from([1])), [Buffer.from([1])]);
    const init = serverInit();
    assert.deepEqual(feed(init), init, 'split dimensions forward only once complete and matching');
    target.assertServerComplete();
    assert.deepEqual(target.acceptClient(update(0, 0, WIDTH, HEIGHT)), [update(0, 0, WIDTH, HEIGHT)]);
    assert.deepEqual(target.acceptClient(pointer(WIDTH - 1, HEIGHT - 1)), [pointer(WIDTH - 1, HEIGHT - 1)]);
    assert.deepEqual(target.acceptClient(key(0x61)), [key(0x61)]);
    assert.deepEqual(seen, [['pointer', true], ['key', true]]);
  }
});

test('3.3 handshake and coalesced server-init plus message keep the exact witness', () => {
  const target = gate();
  authenticatedPrefix(target, '003');
  const trailingFrame = Buffer.from([0, 0, 0, 0]);
  const combined = Buffer.concat([serverInit(), trailingFrame]);
  assert.deepEqual(Buffer.concat(target.observeServer(combined)), combined);
  target.assertServerComplete();
  assert.deepEqual(target.acceptClient(update(WIDTH - 1, HEIGHT - 1, 1, 1)),
    [update(WIDTH - 1, HEIGHT - 1, 1, 1)]);
});

test('mismatched 1280x720 dimensions are rejected before either dimension byte is forwarded', () => {
  const target = gate();
  authenticatedPrefix(target);
  const actual = serverInit(1280, 720);
  assert.deepEqual(target.observeServer(actual.subarray(0, 2)), []);
  assert.throws(() => target.observeServer(actual.subarray(2)),
    (error) => error instanceof RfbServerProtocolError && error.phase === 'server_init' &&
      error.reason === 'mismatch');
  assert.throws(() => target.assertServerComplete(),
    (error) => error instanceof RfbServerProtocolError && error.reason === 'incomplete');
});

test('server-close and unexpected negotiation never certify an incomplete handshake', () => {
  const empty = gate();
  assert.throws(() => empty.assertServerComplete(), /RFB server version incomplete/);
  assert.deepEqual(empty.observeServer(version('008')), [version('008')]);
  assert.throws(() => empty.observeServer(securityOffer),
    (error) => error instanceof RfbServerProtocolError && error.phase === 'security' &&
      error.reason === 'unexpected');
  assert.throws(() => empty.assertServerComplete(), /incomplete/);

  const incomplete = gate();
  authenticatedPrefix(incomplete);
  assert.deepEqual(incomplete.observeServer(serverInit().subarray(0, 3)), []);
  assert.throws(() => incomplete.acceptClient(pointer(1, 1)), /server init is incomplete/);
  assert.throws(() => incomplete.assertServerComplete(),
    (error) => error instanceof RfbServerProtocolError && error.phase === 'server_init' &&
      error.reason === 'incomplete');
});

test('unsupported offers, unauthenticated result and oversized metadata fail closed', () => {
  const noPassword = gate();
  noPassword.observeServer(version('008'));
  noPassword.acceptClient(version('008'));
  assert.throws(() => noPassword.observeServer(Buffer.from([1, 1])), /security unsupported/);

  const failedAuth = gate();
  failedAuth.observeServer(version('008'));
  failedAuth.acceptClient(version('008'));
  failedAuth.observeServer(securityOffer);
  failedAuth.acceptClient(Buffer.from([2]));
  failedAuth.observeServer(challenge);
  failedAuth.acceptClient(response);
  assert.throws(() => failedAuth.acceptClient(Buffer.from([1])), /authentication result is incomplete/);
  assert.throws(() => failedAuth.observeServer(Buffer.from([0, 0, 0, 1])), /result unsupported/);

  const oversized = gate();
  authenticatedPrefix(oversized);
  const header = serverInit().subarray(0, 24);
  header.writeUInt32BE(65537, 20);
  assert.throws(() => oversized.observeServer(header), /server_init unsupported/);
  assert.throws(() => gate().acceptClient(Buffer.alloc(256 * 1024 + 1)), /Invalid RFB client data/);
});

test('input bounds use the sealed geometry and parsed gates retain no secret bytes', () => {
  const target = gate();
  authenticatedPrefix(target);
  target.observeServer(serverInit());
  target.assertServerComplete();
  assert.throws(() => target.acceptClient(pointer(WIDTH, HEIGHT - 1)), /pointer event/);
  assert.throws(() => gate().acceptClient(Buffer.alloc(256 * 1024 + 1)), /Invalid RFB client data/);
  const separate = gate();
  authenticatedPrefix(separate);
  separate.observeServer(serverInit());
  assert.throws(() => separate.acceptClient(update(0, 0, WIDTH + 1, HEIGHT)), /update exceeds/);
  const heldKeys = gate();
  authenticatedPrefix(heldKeys);
  heldKeys.observeServer(serverInit());
  for (let code = 1; code <= 32; code++)
    assert.deepEqual(heldKeys.acceptClient(key(code)), [key(code)]);
  assert.throws(() => heldKeys.acceptClient(key(33)), /Too many held keys/);
  const buffers = Object.values(separate).filter(Buffer.isBuffer);
  for (const buffer of buffers) {
    assert.ok(!buffer.includes(challenge), 'server challenge must not be retained in gate state');
    assert.ok(!buffer.includes(response), 'client response must not be retained in gate state');
  }

  const handshake = gate();
  handshake.observeServer(version('008'));
  handshake.acceptClient(version('008'));
  handshake.observeServer(securityOffer);
  handshake.acceptClient(Buffer.from([2]));
  handshake.observeServer(challenge);
  handshake.acceptClient(response);
  const heldBuffers = Object.values(handshake).filter(Buffer.isBuffer);
  for (const buffer of heldBuffers) {
    assert.ok(!Buffer.from(buffer.buffer).includes(response),
      'consumed client response must not survive in a zero-length buffer backing store');
  }
});
