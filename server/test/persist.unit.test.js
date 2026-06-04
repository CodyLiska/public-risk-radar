import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeBy } from '../src/services/persist.js';

// dedupeBy is the fix for the upsert bug: a single INSERT ... ON CONFLICT cannot
// touch the same target row twice, so batches must be collapsed on their key.

test('dedupeBy keeps the last occurrence of each key', () => {
  const rows = [
    { id: 'a', v: 1 },
    { id: 'b', v: 2 },
    { id: 'a', v: 3 },
  ];
  const out = dedupeBy(rows, (x) => x.id);
  assert.equal(out.length, 2);
  assert.deepEqual(out.find((x) => x.id === 'a'), { id: 'a', v: 3 }); // last wins
  assert.deepEqual(out.find((x) => x.id === 'b'), { id: 'b', v: 2 });
});

test('dedupeBy drops rows with a null/undefined key', () => {
  const rows = [{ id: 'a' }, { id: null }, { id: undefined }, { id: 'b' }];
  const out = dedupeBy(rows, (x) => x.id);
  assert.deepEqual(out.map((x) => x.id).sort(), ['a', 'b']);
});

test('dedupeBy preserves insertion order of surviving keys', () => {
  const rows = [{ k: 'x' }, { k: 'y' }, { k: 'x' }, { k: 'z' }];
  const out = dedupeBy(rows, (x) => x.k);
  assert.deepEqual(out.map((x) => x.k), ['x', 'y', 'z']);
});

test('dedupeBy on an empty array returns empty', () => {
  assert.deepEqual(dedupeBy([], (x) => x.id), []);
});

test('dedupeBy with all-unique keys returns every row', () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(dedupeBy(rows, (x) => x.id).length, 3);
});
