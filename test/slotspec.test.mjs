import test from 'node:test';
import assert from 'node:assert/strict';
import { lastDueSlot, nextSlot, slotsInWindow } from '../src/status.mjs';

// monthly:D:HH:MM — added for com.example.monthly-job (monthly:1:05:17)

test('monthly lastDueSlot: mid-month points back to this month\'s slot', () => {
  const due = lastDueSlot('monthly:1:05:17', new Date(2026, 7, 18, 12, 0));
  assert.deepEqual(due, new Date(2026, 7, 1, 5, 17));
});

test('monthly lastDueSlot: before the slot on day 1 points to previous month', () => {
  const due = lastDueSlot('monthly:1:05:17', new Date(2026, 7, 1, 4, 0));
  assert.deepEqual(due, new Date(2026, 6, 1, 5, 17));
});

test('monthly lastDueSlot: day 28 never rolls over a short month', () => {
  const due = lastDueSlot('monthly:28:09:00', new Date(2026, 2, 5, 12, 0));
  assert.deepEqual(due, new Date(2026, 1, 28, 9, 0));
});

test('monthly nextSlot: finds the next month within horizon', () => {
  const next = nextSlot('monthly:1:05:17', new Date(2026, 7, 18, 12, 0));
  assert.deepEqual(next, new Date(2026, 8, 1, 5, 17));
});

test('monthly slotsInWindow: slot appears only when inside ±12h', () => {
  assert.equal(slotsInWindow('monthly:1:05:17', new Date(2026, 7, 18, 12, 0)).length, 0);
  const near = slotsInWindow('monthly:1:05:17', new Date(2026, 7, 1, 10, 0));
  assert.equal(near.length, 1);
  assert.deepEqual(near[0], new Date(2026, 7, 1, 5, 17));
});
