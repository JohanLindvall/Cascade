import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toastsHeld } from './toastHold.ts';

test('a mouse resting on the stack holds the toasts', () => {
  assert.equal(toastsHeld({ hovered: true, pointer: 'mouse', focused: false }), true);
});

test('the :hover a tap leaves behind does not', () => {
  // A phone: the stack still matches :hover after a tap on a toast, until
  // the next tap somewhere else. Held, no toast would leave until then.
  assert.equal(toastsHeld({ hovered: true, pointer: 'touch', focused: false }), false);
  assert.equal(toastsHeld({ hovered: true, pointer: 'pen', focused: false }), false);
  assert.equal(toastsHeld({ hovered: true, pointer: null, focused: false }), false);
});

test('the keyboard in the stack holds the toasts, whatever the pointer did', () => {
  assert.equal(toastsHeld({ hovered: false, pointer: null, focused: true }), true);
  assert.equal(toastsHeld({ hovered: true, pointer: 'touch', focused: true }), true);
});

test('a mouse that has moved away does not', () => {
  assert.equal(toastsHeld({ hovered: false, pointer: 'mouse', focused: false }), false);
});
