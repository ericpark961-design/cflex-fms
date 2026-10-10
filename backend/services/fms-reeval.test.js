// node --test backend/services/fms-reeval.test.js
//
// The queue is the only thing standing between "re-think when evidence changes"
// and an unbounded bill, so its two guards get tested directly.
const test = require('node:test');
const assert = require('node:assert');
const R = require('./fms-reeval');

const fakeDb = {};
const nextTick = () => new Promise(r => setTimeout(r, 5));

test.afterEach(() => R.reset());

test('a burst of triggers collapses into one run', async () => {
  R.reset();
  const first = R.queue(fakeDb, 1, 'metrics', { immediate: true });
  const second = R.queue(fakeDb, 1, 'adjacent_alarm', { immediate: true });
  const third = R.queue(fakeDb, 1, 'action_result', { immediate: true });
  assert.equal(first.queued, true);
  assert.equal(second.reason, 'coalesced');
  assert.equal(third.reason, 'coalesced');
  await nextTick();
  assert.equal(R.recentCount(1), 1, 'three triggers, one re-evaluation');
});

test('the hourly cap stops a pathological incident', async () => {
  R.reset();
  for (let i = 0; i < R.MAX_PER_HOUR; i++) {
    const q = R.queue(fakeDb, 2, 'metrics', { immediate: true });
    assert.equal(q.queued, true, `run ${i + 1} allowed`);
    await nextTick();
  }
  assert.equal(R.recentCount(2), R.MAX_PER_HOUR);
  const over = R.queue(fakeDb, 2, 'metrics', { immediate: true });
  assert.equal(over.queued, false);
  assert.match(over.reason, /상한/);
});

test('an unknown trigger is refused rather than silently accepted', () => {
  R.reset();
  const q = R.queue(fakeDb, 3, 'vibes');
  assert.equal(q.queued, false);
  assert.match(q.reason, /unknown trigger/);
  assert.equal(R.queue(fakeDb, 'not-a-number', 'metrics').queued, false);
});

test('the default delay is the 60 s debounce window', () => {
  R.reset();
  const q = R.queue(fakeDb, 4, 'engineer_note');
  assert.equal(q.in_ms, R.DEBOUNCE_MS);
  assert.equal(R.DEBOUNCE_MS, 60000);
  assert.equal(R.recentCount(4), 0, 'nothing has run yet');
});
