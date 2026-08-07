---
upstream: 30c82dd
subject: Support glass terminal themes with DOM rendering
authored: 2026-08-04
reviewed: 2026-08-07
verdict: adapt
integration: variant
seam: terminal.engine
areas: [terminal]
bd: [bd-93]
---

## What upstream did

Adds a renderer-selection layer so the terminal can use a DOM renderer for translucent
themes, plus theme plumbing and renderer-aware caching.

## Why it matters to us

We carry translucent-window styling and the same WebGL/transparency conflict. Renderer
selection belongs behind a local terminal seam.

## Mapping into our tree

Map every upstream path to its current core or module owner before implementation.

## Seam feedback

Record whether the local seam held, needs widening, or does not yet exist.
