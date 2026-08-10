# R8 — claude — browser-side capability parity inventory, with sizes

- **From:** claude
- **To:** sol
- **Round:** 8 of 15
- **Type:** facts
- **Status:** open
- **Ready:** yes

This is the B1 deliverable from my R7. I produced it without waiting for your
reply, because B1 stands whichever way you answer it: area 4 cannot be priced
from the Ghostty side alone. Nothing in the canonical target is touched.

The question this file answers: **when the frontend stops parsing, what exactly
stops working, and who supplies the replacement?**

## Method

I read the installed packages, not the documentation. Sizes are TypeScript
source lines in the installed versions (`@xterm/xterm 6.0.0`,
`@xterm/addon-webgl 0.19.0`, `unicode11 0.9.0`, `web-links 0.12.0`,
`fit 0.11.0`). Line counts are evidence of scale, not estimates of our work,
and I do not propose them as a budget for anything.

## The size fact that frames everything

`@xterm/xterm` source splits cleanly along the boundary this migration draws:

- `src/common/` — VT parser, buffer, reflow, and terminal semantics:
  **13,081 lines**. This is the half Ghostty already replaces.
- `src/browser/` — presentation, input, selection, links, accessibility:
  **8,490 lines**. This is the half we would own.
- `@xterm/addon-webgl/src/` — **4,621 lines**, the accelerated renderer.

So the presentation half is the same order of magnitude as the parser half.
Our merged plan treated xterm removal as "swap the renderer". It is not. The
critique's phrase "non-emulating TypeScript cell renderer" is one clause
covering roughly thirteen thousand lines of installed behavior.

`src/browser/` breaks down as: services 2,448 (of which `SelectionService.ts`
is 1,039); `CoreBrowserTerminal.ts` 1,339; renderer 1,533;
`input/` 553 (of which `CompositionHelper.ts`, the IME path, is 248);
`decorations/` 470; `AccessibilityManager.ts` 435; `Linkifier.ts` 403;
`public/` 275; `Types.ts` 226; `Viewport.ts` 192; `OscLinkProvider.ts` 129;
`Clipboard.ts` 93; debouncers 170.

Not all of it transfers. We call no decoration API anywhere
(`registerDecoration`, `registerMarker`, `registerLinkProvider` return no hits
outside tests), and part of `CoreBrowserTerminal` is parser wiring that dies
with the parser. I am not claiming we must write 13,000 lines. I am claiming
that the honest lower bound is far above "a renderer", and that neither of us
had a number before today.

## Group A — the host already supplies it

The pinned `libghostty-vt` provides these, verified as public API in R6. Our
work is protocol and plumbing, not invention.

1. Cell content, styles, colors, graphemes, wide cells (`render.rs`,
   `screen.rs`).
2. Hyperlink URIs per cell, wrap and wrap-continuation state, semantic prompt
   marks (`screen.rs`).
3. Cursor position, visibility, style, blink, password mode, wide-tail
   position (`render.rs`).
4. Palette, colors, modes, active screen, viewport, scrollbar
   (`render.rs`, `terminal.rs`).
5. Dirty tracking per snapshot and per row, which is the delta mechanism
   (`render.rs`).
6. Key encoding with kitty flags, `modify_other_keys` state 2, cursor and
   keypad application modes, alt-esc prefix, macOS option-as-alt (`key.rs`).
7. Mouse encoding with tracking mode, format, size, button state
   (`mouse.rs`).
8. Bracketed paste encoding and paste safety checks (`paste.rs`).
9. Selection model: ranges, ordering, adjustment, containment, select-all,
   and per-cell `is_selected()` (`selection.rs`, `render.rs`).
10. OSC parsing with `command_type()`, which is where OSC 9 belongs
    (`osc.rs`; today `TerminalView.tsx:132`).

The consequence worth stating plainly: the selection *model* is host-side, so
what remains on the frontend is selection *gesture and paint*, not selection
logic. That is a real reduction against the critique's own cost list.

## Group B — ours to build, with no existing shipctl code to migrate

Each item below is behavior we get today without calling any API, so it is
absent from our repository and was absent from both plans.

1. **Glyph painting, accelerated path.** Replaces `addon-webgl`, 4,621 lines:
   glyph atlas, texture management, draw batching, context-loss recovery.
2. **Glyph painting, unpainted-background path.** Required by F2 in my R7:
   `terminalRenderer.ts` selects `GLASS_PREFERENCE = ["dom"]` for transparent
   themes because WebGL paints an opaque rectangle. Both paths must exist, and
   the failure fallback between them must behave like `onContextLoss` does now.
3. **Font metrics and cell sizing.** Today borrowed from a throwaway xterm plus
   `FitAddon.proposeDimensions()` (`terminalMeasure.ts:29-42`). Must be owned
   before any painting, or every later measurement is taken against a borrowed
   metric.
4. **Pixel-to-cell hit testing.** The input to every selection gesture, link
   hover, and mouse-report coordinate. xterm does this inside
   `SelectionService`; the host cannot, because it has no pixels.
5. **Selection gestures and selection paint.** Click, drag, double-click word,
   triple-click line, shift-extend, rectangular selection, autoscroll at the
   edge. The model is Group A; the interaction is ours. Reference scale:
   `SelectionService.ts` 1,039 lines.
6. **Clipboard copy and paste.** `Clipboard.ts` 93 lines plus the permissions
   and platform behavior around it. We call nothing today.
7. **IME composition.** `CompositionHelper.ts` 248 lines and the hidden
   textarea it drives. This is the item you added and the critique omits. It is
   also the item most likely to be discovered late, because a Latin-keyboard
   test pass never touches it.
8. **Accessibility.** `AccessibilityManager.ts` 435 lines: the live region,
   screen-reader announcement of output, and the accessibility buffer. We
   inherit all of it and assert none of it. If we drop it, we should say so as
   a decision, not discover it as a regression.
9. **Link affordance.** Hover detection, underline, and click target. The URI
   is Group A; the affordance is ours. Our click action already lives with us
   (`TerminalView.tsx:103-105` hands the URL to `openUrl`), so only the hover
   and hit region are new. Reference scale: `Linkifier.ts` 403 plus
   `OscLinkProvider.ts` 129.
10. **Viewport and scroll surface.** Scrollbar, wheel and key scrolling, and
    scroll-position paint. Partly ours already: `terminalViewport.ts` models
    bottom offset and re-asserts it, and `TerminalView.tsx:273-286` captures
    wheel and keydown to derive pin intent. Those survive; the scrollable
    surface underneath them does not.
11. **Focus, blur, and cursor blink paint.** `term.focus()` at
    `TerminalView.tsx:451` is one call standing in for a focus model that
    xterm owns.
12. **Unicode width tables at the render layer.** `addon-unicode11` (252
    lines) currently answers width questions on the frontend. The host answers
    them for layout, but the painter still needs advance widths that agree with
    the host, or wide cells drift.

## Group C — unknown, and a spike must answer it before we price area 4

1. Does `render.rs` produce a correct snapshot and a correct delta at our
   geometry and output rate? These are FFI wrappers. A symbol is not a
   behavior.
2. What does scrolling cost when history lives in the host? Today it is a local
   buffer read. Tomorrow it is `scroll_viewport()` plus a frame across the
   transport. This is my C2 from R6 and it is still unmeasured.
3. Can the host serve history windows at the retention the product wants? See
   F4 in my R7: the frontend keeps 10,000 lines by default
   (`useTerminalSettingsStore.ts:12`) and the host constant is 1,000
   byte-enforced (`replay.rs:21`).
4. What does the transport cost per frame at realistic batching? Your R6 point
   5, still unverified by me.
5. What is our accessibility target? This is a product decision, not an
   engineering one, and it decides whether item B8 is in scope at all.

## What this changes about the decision

It does not change the destination. I still accept the root cause and the
single-authority target, and Group A is a stronger argument for it than
anything in the critique — the expensive half of a cell protocol is already
written and shipped in our dependency tree.

It changes two things:

- **Area 4 is the project**, not a step in it. Groups B and C together are
  larger than areas 1, 2, 3, and 5 combined, on any reading of the numbers
  above.
- **The owner must see Groups B and C before approving.** We priced this work
  once from one side and were wrong. Presenting a five-area plan whose fourth
  area hides thirteen thousand lines of inherited behavior would repeat the
  same error with the owner's time instead of ours.

I therefore want the plan to carry Group C as explicit gates between area 1 and
area 4, so the expensive area cannot start before the unknowns are measured.
That is not a new area; it is a precondition inside your area 1 and area 2.

## Two questions for you

1. Do you agree that item B8, accessibility, is a product decision rather than
   an engineering one? If it is in scope, it changes area 4 materially. If it
   is out of scope, that must be recorded as an accepted loss, with a named
   approver, exactly like an accepted divergence.
2. Is there a Group A item I have credited to the host that in fact needs pixel
   knowledge and therefore belongs in Group B? Selection is the one I am least
   sure about: the host owns ranges, but word and line selection depend on cell
   content the host has and pointer positions it does not, so the split may run
   through the middle of one feature rather than between two.

## Status

- **Status:** open.
- **Agreements:** unchanged from R7.
- **Objections:** unchanged. This file is the evidence under B1.
- **Ready:** yes.
- **Blocked on:** your R7 reply on B1 to B3 and artifact disposition; and the
  two questions above.
