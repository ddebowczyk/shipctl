# Round 14: Ledger disposition and evidence order

From: solution owner  
To: reviewer  
Round: 14 of 22  
Purpose: accept the confidence correction and bind the remaining review

## Ownership

I own this file, rounds 16, 18, 20, and 22, and every target plan. The reviewer
owns rounds 13, 15, 17, 19, and 21. Round 13's target corrections are applied by
me only; the reviewer did not edit owner files.

## Confidence correction accepted

The first twelve rounds proved that the five-area decomposition is coherent and
executable as a plan. They did not prove the unimplemented browser input stack,
semantic painter, fallback painter, host anchor representation, or selected
transport. Describing the architecture as approved remains correct; describing
implementation confidence as uniformly high would not.

Current assessment:

- the single-VT direction remains the most credible end state;
- areas 01-03 have sufficient dependency and code seams to begin gated work;
- area 04 is the decisive feasibility risk and must be falsified early;
- area 05 is mechanically clear but conditional on the first four gates; and
- more discussion cannot substitute for the packaged spikes and production
  traces named by the plans.

The next rounds therefore improve the order and precision of required evidence.
They do not manufacture paper confidence or treat an unresolved implementation
choice as proof that dual VT is desirable.

## O1 correction completed

Round 13 correctly found that parser-generated PTY replies were misclassified
as client occurrence effects.

The README and areas 01-02 now state:

- Ghostty replies remain ordered actor-to-child work;
- `RuntimeActor` writes them only back to the child;
- they never enter the semantic client domain or Tauri, control, CLI, or module
  streams; and
- production validation captures the client stream and proves reply absence.

Client occurrence effects remain title, working directory, bell, notification,
clipboard, lifecycle, and other explicitly client-visible occurrences. This is
an authority correction, not a new work area.

## Disposition of the remaining ledger

### O2: OSC 9

Accepted as a pre-protocol dependency or owner gate. Area 01 already allows only
owned binding support, a bounded non-state extractor, or named product removal.
Round 15 must test whether the bounded-extractor wording is sufficiently narrow
and whether the selected decision must precede more than the effect-union freeze.

### O3: Stable history and selection anchors

Accepted as an architecture-feasibility gate. The current plans require host
anchors, revision, eviction, and invalidation, but do not yet state whether an
opaque serializable identity can be derived safely from `TrackedGridRef` without
exposing dependency lifetime or pointer identity. Round 15 must produce the
minimum host-anchor contract and falsification cases that the plans need.

### O4: Semantic browser input and IME

Accepted as a decisive feasibility gate. The current area-04 plan lists the
events and packaged proof, but the evidence order should make this a precommit
spike before the main painter implementation. Round 17 must define the minimum
packaged trace that detects duplicate text, lost composition, wrong modifiers,
and browser-generated VT leakage.

### O5: Primary and fallback presentation

Accepted as the other decisive feasibility gate. Round 17 must define what
“independent fallback” means, how both paths consume identical semantic facts,
and the smallest capability packet that can issue a go or no-go without
inventing a technology or threshold.

### O6: CLI and control byte compatibility

Accepted as an owner decision that precedes semantic-only client cutover. The
plans already reject a hidden byte tunnel. Round 17 must identify the exact live
promises that need an explicit preserve, break, or block decision and keep the
local CLI painter separate from the protocol.

### O7: Encoding and flow control

Accepted as implementation measurement. Area 02 already requires packaged
Tauri and control evidence and forbids inherited queue limits. Round 15 must
verify that the plan also requires observable pressure, an atomic overflow
outcome, and the same decoded meaning across representations.

### O8: Production authority plus persistent model

Accepted as the cross-area integration proof. Round 19 must audit one complete
trace from PTY mutation through semantic projection and a hidden client model to
surface recreation, including host anchor invalidation and semantic recovery.

### O9: Conformance and deletion

Accepted as the fixed-point proof. Round 19 must verify that the two independent
fixture halves, production adapters, deletion inventory, and provenance-aware
negative gates cover every authority exposed by O1-O8.

## Evidence order for the remaining rounds

The remaining work is deliberately ordered by the chance of falsifying the
architecture before expensive implementation:

1. Round 15: reviewer deep audit of host anchors, OSC 9 containment, semantic
   pressure, and reply exclusion.
2. Round 16: owner reconciles that audit and applies necessary target changes.
3. Round 17: reviewer deep audit of browser semantic input, IME, primary and
   fallback painters, and CLI/control contract decisions.
4. Round 18: owner applies the decisive feasibility and sequencing changes.
5. Round 19: reviewer walks the complete production and deletion proof across
   all five areas.
6. Round 20: owner applies remaining corrections and validates the target set.
7. Round 21: reviewer performs an adversarial confidence and fixed-point audit.
8. Round 22: owner records final disposition, confidence, and whether further
   coordination or implementation evidence is needed.

## Review standard

A review concern changes the plans only when deleting it leaves the accepted
end state unmet or unproven. Implementation evidence that cannot exist before
implementation becomes an explicit early gate, stop condition, and validation
scenario. It is not falsely marked complete during planning.

No round may:

- add a sixth delivery area;
- reopen completed retention or lifecycle enablers;
- choose a renderer or codec without packaged evidence;
- invent a performance, size, timing, retry, or sample threshold; or
- preserve xterm or raw client bytes merely to raise short-term confidence.

## Status

Round 14 complete. O1 is corrected. O2-O9 are accepted and routed to evidence
owners. The remaining review now targets the three genuine architecture risks:
host anchors, semantic browser input, and a primary plus independent fallback
presentation stack.
