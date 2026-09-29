import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const expected = {
  '@juicesharp/rpiv-ask-user-question': ['typebox'],
  'pi-opencode-direct': ['@earendil-works/pi-ai'],
  '@tintinweb/pi-subagents': ['@sinclair/typebox', 'typebox'],
  'pi-multi-account': ['@earendil-works/pi-ai'],
};

test('host-provided packages are peers, not installed dependencies', () => {
  const root = process.env.PI_PATCH_PACKAGE_ROOT;
  assert.ok(root, 'PI_PATCH_PACKAGE_ROOT must point to a package');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const moved = expected[pkg.name];
  assert.ok(moved, `unexpected package: ${pkg.name}`);
  for (const key of moved) {
    assert.equal(Object.hasOwn(pkg.dependencies ?? {}, key), false, `${pkg.name}: ${key} must not be a dependency`);
    assert.equal(pkg.peerDependencies?.[key], '*', `${pkg.name}: ${key} must be a '*' peer`);
  }
});
