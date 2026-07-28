const assert = require('assert/strict');

const { parseExtraArgs } = require('./index');

assert.deepEqual(parseExtraArgs(''), []);
assert.deepEqual(parseExtraArgs('   '), []);
assert.deepEqual(parseExtraArgs('--log-level=debug --remote-store-insecure'), [
  '--log-level=debug',
  '--remote-store-insecure'
]);
assert.deepEqual(parseExtraArgs('--node="github runner" --remote-store-insecure'), [
  '--node=github runner',
  '--remote-store-insecure'
]);
assert.deepEqual(parseExtraArgs("--node='github runner' --remote-store-insecure"), [
  '--node=github runner',
  '--remote-store-insecure'
]);
assert.deepEqual(parseExtraArgs('--label=a\\ b --path=C:\\tmp\\profiles'), [
  '--label=a b',
  '--path=C:\\tmp\\profiles'
]);
assert.deepEqual(parseExtraArgs('--empty ""'), [
  '--empty',
  ''
]);
assert.throws(() => parseExtraArgs('"unterminated'), /Unterminated double quote/);

console.log('index tests passed');
