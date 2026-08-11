# Terminal link behavior

Shipctl's terminal makes a link out of what the host marked as a link, and
nothing else. A URL written in plain output stays plain text.

This page is the recorded decision behind the `links.plain-text` entry in
`core/frontend/terminal/scenarios/capabilityRegister.ts`, whose disposition is
`changed`.

## The decision

Decided by Dariusz Debowczyk, product owner, on 2026-08-11: links can be
displayed as plain text. Plain-output URL detection is removed from the
terminal and is not a migration obligation.

## What changes for a reader

Today the xterm surface loads the web-links addon, which finds URLs in output
with a pattern of its own and makes them clickable. The semantic terminal does
not. A URL that a program prints without marking it is text the reader can
select and copy, like any other text.

## What stays

OSC 8 hyperlinks are unaffected. A program that marks a link gets a link: the
host projects the marked run, the client paints its underline, and a click
opens it through the platform opener. That path is covered by
`core/frontend/terminal/tests/terminalLinkTargets.test.ts` and
`core/frontend/terminal/tests/terminalPointerRouter.test.ts`.

## Why the behavior was not reproduced

A pattern written into the client would make the client a second authority over
what the terminal holds. The host is the semantic authority for every other
terminal fact, and a URL pattern is a guess about meaning, not a fact the host
reported. Reproducing the addon would either move that guess into the client or
require the host to project matches it does not make.

The alternative — projecting plain-text matches in the host — remains open if
the product later wants the behavior back. It is a feature request against this
decision, not an unclosed migration gap.
