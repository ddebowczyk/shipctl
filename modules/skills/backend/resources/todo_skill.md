---
name: shep-todos
description: Maintain this project's TODO.md as a markdown kanban board shared with the humans on the project. Use when starting, finishing, or planning work, and whenever the user mentions to-dos, tasks, the backlog, or the board.
---

# Project to-dos (TODO.md)

This repo tracks work in `TODO.md` at the repo root. The humans on this
project see that file rendered as a live kanban board (in the Shep app), so
keep it accurate as you work. The file is the single source of truth — there
is no other task database.

## Format

- `##` headings are board columns. The standard columns, in order:
  `## 📋 Backlog`, `## 🚧 In Progress`, `## ✅ Done`.
- The user may have customized the board — different column names, emoji,
  or extra columns (e.g. `## ⛔ Blocked`, `## 🔍 In Review`). Always mirror
  the file's existing structure; never rename columns or impose the standard
  set on a file that already has its own.
- Each card is one GFM task-list line: `- [ ] Short imperative title`.
- Checkbox state must agree with the column: cards in Done are `- [x]`,
  cards everywhere else are `- [ ]`.
- Sub-steps go under the card as indented child checkboxes:

  ```markdown
  - [ ] Add UTM parameters to outbound links
    - [x] frontend PR merged
    - [ ] deploy
  ```

- Keep card titles to one line. Put details, evidence, and links in indented
  child lines — not in long wrapped paragraphs.

## Protocol

1. **Starting a task?** Move its card to `## In Progress` first (add the card
   there if it doesn't exist yet).
2. **Finished?** Move the card to `## Done` and mark it `- [x]`. Never delete
   completed cards — Done is the record.
3. **Discovered new work?** Add a `- [ ]` card to `## Backlog`.
4. **Moving a card** means cutting its lines (the card plus its indented
   children) and pasting them under the target heading. Make surgical edits:
   never reorder, reformat, or rewrite other parts of the file.
5. If `TODO.md` doesn't exist and you need it, create it with the three
   standard columns and a `# To-dos` title.
6. If the user asks to reshape the board (new columns, renames, reordering),
   do it — it's their board. Just keep the invariants: `##` headings as
   columns, one `- [ ]` line per card, checked only in the done-like column.
7. **Before ending a session, make the board reflect reality.** Finished →
   move to Done. Stopped midway or waiting on the user → leave the card in
   In Progress and add a child line noting where things stand (e.g.
   `- [ ] PR #62 open, needs merge + deploy`). The next session — yours or
   another agent's — starts by reading this board, so an accurate In Progress
   column is the handoff note.
