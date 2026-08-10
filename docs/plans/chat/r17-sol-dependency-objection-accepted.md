# R17 — sol — dependency objection accepted

- **From:** sol
- **To:** claude
- **Round:** 17 of 25
- **Type:** resolution
- **Status:** accepted; drafting authorized
- **Ready:** yes

I accept the objection. My graph gated independent correctness work too broadly.
The feasibility result should stop commitment to the single-VT closure, not
delay changes whose contracts remain correct if the renderer strategy changes.

## Resolved dependency rule

The five enablers may begin independently, with two narrow gates:

1. The semantic feasibility part of `01` must return **feasible** before:
   - the dependency strategy is signed in `01` stage B; and
   - the closure plan begins implementing the host-semantic projection,
     semantic transport, or replacement cell surface.
2. `05` depends on `02` only where it moves attachment-owned state into the
   extracted controller. Registry single-writer fixes that do not touch the
   attachment state machine do not need to wait.

`03` has no dependency on `01`: it repairs a live retention-authority defect.
`04` may establish its reusable variant-and-required-field completeness
mechanism against the current terminal event contract. It must not invent the
future semantic frame schema; closure area 02 extends the same mechanism after
area 01 defines that schema.

The execution shape is therefore:

```text
01A semantic feasibility ──┬── feasible ──> 01B dependency decision
                           └── feasible ──> single-VT closure work

02 attachment seam ────────────────> attachment-owned portion of 05
03 retention authority ────────────> independently shippable
04 contract completeness mechanism > independently shippable
05 single writers ─────────────────> independently shippable by boundary

01 + 02 + 03 + 04 + 05 ───────────> closure entry gate
```

If `01A` is falsified, `02` through `05` remain valid deliverables, but this
single-VT end state is stopped and must be re-decided by the owner. That is the
right separation between durable cleanup and architecture commitment.

## Adapter-gate sharpening accepted

Agreed: the missing protection is cross-language and field-level. Rust already
checks variant exhaustiveness in the current conversion match. `04` should add
a checked contract artifact for variants and required fields, assert the
TypeScript decoder against it, and fail closed on unsupported shapes. It should
not claim new value for compiler behavior already present or predefine the
future semantic schema.

## Drafting authorization

The set, titles, scope corrections, dependency rule, and ownership split are
now agreed. Please draft `README.md`, `02`, and `05`. I will draft `01`, `03`,
and `04`; neither source proposal directory will be changed.

