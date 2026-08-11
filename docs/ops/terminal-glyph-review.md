# Terminal glyph review

A recorded human observation. It exists because no self-driven scenario can
replace it.

The packaged scenario harness can prove that a Unicode corpus painted without
throwing, that host-supplied spans were the ones used, and that the frame times
were what they were. It cannot prove that a combining mark landed on the right
base glyph, that a fallback font is legible, or that a wide cell looked wide.
Those are perceptual facts, and a reader is the instrument.

This procedure is the proof cited by `unicode.glyph-fits-span` in
`core/frontend/terminal/scenarios/capabilityRegister.ts`.

## When to run it

Before the area-05 cutover, and again after any change to the painter, the font
stack, or the host's occupancy reporting.

Run it on each platform the app ships to. The engines differ — WKWebView on
macOS, WebKitGTK on Linux, WebView2 on Windows — and font fallback is the part
most likely to differ with them.

## What to prepare

A packaged build, not a dev server. Font fallback and rasterization are
properties of the shipped binary and its platform, and a dev build in a
different engine answers a different question.

## What to look at

Print the area-01 semantic corpus into a terminal and compare each row against
the host's reported occupancy for that row. For every case below, the question
is the same: **does what you see occupy exactly the columns the host said, and
is it legible?**

1. **Combining marks** — a base letter with one, two and three combining
   diacritics. The cluster occupies one column. No mark is clipped by the cell
   edge or drawn over the neighbouring glyph.
2. **Wide cells** — CJK ideographs, Hiragana, Hangul. Each occupies two columns,
   and the continuation column holds no second glyph.
3. **Variation selectors** — a base character with VS15 (text) and VS16 (emoji).
   The two render differently, and the emoji form occupies the columns the host
   reported rather than the columns the font would prefer.
4. **Joiner sequences** — a ZWJ emoji family or profession sequence. It renders
   as one glyph where the platform supports it, and as its component glyphs
   where it does not. Either is acceptable; what is not is a glyph overflowing
   its reported span.
5. **Fallback fonts** — a script absent from the configured terminal font
   (Devanagari, Thai, Arabic). The fallback glyph is legible and stays inside
   the host span.
6. **Ambiguous width** — box drawing, arrows, Greek. Whatever the host reported
   is what is drawn; the font's own idea of the width does not win.
7. **The cursor** — placed after each of the above, the cursor sits where a
   reader would expect, not shifted by a glyph's actual ink width.

## What to record

For each numbered case: pass, fail, or not-applicable-on-this-platform, with a
screenshot for anything that is not a plain pass. Record the platform, the app
version, and the configured terminal font.

File the result beside the run in `research/`, dated. A pass with no recorded
evidence is not a pass — the point of this procedure is that somebody looked,
and the record is what says so.

## What a failure means

A glyph that overflows its host span is not a painter bug to be worked around
by measuring text in the frontend. Measuring there creates a second width
authority, which area 04 forbids for the same reason the plan forbids a second
VT. Either the host's occupancy is wrong — an area-01 defect — or the cluster
cannot be painted in that span and needs a recorded, owner-approved
presentation limitation.
