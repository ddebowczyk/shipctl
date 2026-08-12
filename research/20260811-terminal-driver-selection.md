# Terminal driver selection

Date: 2026-08-11

The terminal extraction replaces the former global one-parser target with one
selected terminal authority for each terminal session. A launch stores a
`TerminalDriverId`; that id selects exactly one native driver and one frontend
presentation for the life of the terminal.

`semantic-terminal` remains the build default while extraction is in progress.
Its Ghostty fixtures, wire traces, scenario register, and performance evidence
remain evidence for that module only. They do not make a claim about
`thin-terminal`, which receives ordered PTY bytes and has no semantic history
or screen authority.

Core owns PTY lifecycle, ordered byte occurrences, physical resize, and the
single child writer. A driver may interpret occurrences and return its own
module events or ordered reply bytes. A presentation may attach only when its
driver id matches the terminal descriptor.
