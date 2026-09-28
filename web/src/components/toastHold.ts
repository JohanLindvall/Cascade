/** What the toast stack is asked when a toast's time is up. */
export interface StackAtExpiry {
  /** Whether the stack matches :hover. */
  hovered: boolean;
  /** The pointerType of the last pointer to come over the stack, if any has. */
  pointer: string | null;
  /** Whether keyboard focus is inside the stack. */
  focused: boolean;
}

/**
 * Whether toasts must wait rather than leave. Nothing leaves while a mouse
 * rests on the stack or the keyboard is in it: a message must not vanish
 * under the eyes, or the Tab key, reading it.
 *
 * Only a mouse rests. A touch screen leaves :hover on whatever was tapped
 * last until the next tap somewhere else, so a hold that asked :hover alone
 * kept every toast, and each one after it, from the moment one was tapped.
 */
export function toastsHeld({ hovered, pointer, focused }: StackAtExpiry): boolean {
  return (hovered && pointer === 'mouse') || focused;
}
