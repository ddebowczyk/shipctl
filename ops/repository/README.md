# Repository maintenance

This capability owns the canonical inventory of the repository root in
[`root-map.yaml`](root-map.yaml). It is deliberately a map of direct root
entries, not a second ownership system for every file below them.

Run `just repository map` to see the logical groups and their descriptions.
Run `just repository validate` after changing the root. The check fails when a
physical root entry is absent from the map, a mapped item no longer exists, its
kind changes, or an item is deliberately marked `unknown`.

`unknown` is an explicit holding group, not an approval. Use it only long
enough to decide whether the item is noise to remove, belongs in an existing
group, or warrants a new logical group.
