// Whether the viewport follows output is a user intent, not a buffer fact: it
// has to be decided from the gesture, because the queue writes across frames
// and the buffer has already moved by the time a chunk lands.
//
// This module classifies the gesture. `terminalViewportPin.ts` holds the intent
// it produces and applies it to a surface.

export type ScrollPinIntent =
  /** The user is reading history — stop following output. */
  | "unpin"
  /** Ambiguous movement — re-read the buffer once it settles. */
  | "resync"
  /** Input or a jump to the end — follow output again. */
  | "follow";

/** Keys that move the viewport rather than producing terminal input. */
const VIEWPORT_KEYS = ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"];

/** Viewport keys that move away from the end of the buffer. */
const BACKWARD_VIEWPORT_KEYS = ["PageUp", "Home", "ArrowUp"];

export function wheelScrollPinIntent(deltaY: number): ScrollPinIntent {
  // Scrolling up always leaves follow mode. Scrolling down only re-enters it
  // once the viewport has actually reached the bottom, which the caller reads
  // back from the buffer.
  return deltaY < 0 ? "unpin" : "resync";
}

export function keyScrollPinIntent(event: Pick<KeyboardEvent, "shiftKey" | "key">): ScrollPinIntent {
  if (!event.shiftKey || !VIEWPORT_KEYS.includes(event.key)) {
    // Ordinary terminal input: the response is what the user is waiting for.
    return "follow";
  }
  return BACKWARD_VIEWPORT_KEYS.includes(event.key) ? "unpin" : "resync";
}
