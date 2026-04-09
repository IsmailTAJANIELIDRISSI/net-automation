# Portnet Consultation Polling Analysis (LTA Collision Case)

## Context

In the Portnet consultation table, two different LTAs can share the same value in column "Numero de la DS de reference" (called `dsReference` in code), especially when they are on the same flight.

Later, after acceptance, each row gets its own distinct value in column "Reference DS" (called `refDsMead` in code), and that value is what BADR finalization uses.

Example from the reported case:

- Same `dsReference`: `30100020260004762X`
- Different accepted `refDsMead`:
  - `30100020260001813Z`
  - `30100020260001812E`

This means `dsReference` is not a unique key for one LTA.

## What the app currently does

### 1) Initial row filtering in Portnet

File: `src/portnet/portnetDsCombine.js`
Method: `getConsultationStatus(portnetRef, options)`

The app first finds all consultation rows where `dsReference == portnetRef`.
So in collision cases, it intentionally gets multiple rows.

### 2) How it disambiguates rows

Still in `getConsultationStatus`, the app tries to bind one LTA run to one table row using this priority:

1. Anchor by `consultationCreatedAtRaw` (stored from a previous poll)
2. If available, also anchor by `consultationNumeroManifeste`
3. Otherwise, use `submittedAt` time window and pick closest row by creation time
4. If no time-window match, fallback to closest row outside the window
5. Without timing info, fallback to newest acceptable non-claimed row

It also tracks `excludeRefDs` (already claimed accepted refs) so one accepted `refDsMead` is not reused by another LTA.

### 3) Polling loop orchestration

File: `electron/main.js`
Method: `monitorPendingPortnetRequests(...)`

For each pending LTA:

- It calls `getConsultationStatus(state.portnetRef, { submittedAt, excludeRefDs, anchorCreatedAtRaw, anchorNumeroManifesteRaw, preferNewest })`
- On first successful row observation, it saves anchor fields:
  - `consultationCreatedAtRaw`
  - `consultationNumeroManifeste`
- On `Acceptée`, it extracts short BADR ref from `refDsMead` and marks it claimed.
- Then it runs BADR finalization with that short ref.

### 4) BADR finalization linkage

File: `src/badr/badrDsCombineFinalize.js`
Method: `processFinalization(...)`

BADR does not query by LTA directly. It uses the accepted short reference derived from Portnet `refDsMead`.
So if Portnet row association is wrong, BADR scelles declaration can be executed for the wrong accepted declaration.

## Why this can still fail in real life

Even with current protections, ambiguity can remain when two LTAs are very close in time and metadata is similar:

- Same `dsReference`
- Similar or same creation minute (`createdAtFormatted` precision may be minute-level)
- Potentially same or unstable `numeroManifeste` values
- Poll order and page reload timing can cause temporary wrong anchor capture

In those edge cases, the app may lock onto the wrong row first, and then consistently follow that wrong anchor.

## Current behavior quality assessment

The implementation is better than simple `dsReference`-only matching because it adds:

- Time anchoring (`submittedAt` and `createdAt`)
- Secondary anchor (`numeroManifeste`)
- Claimed-ref protection (`excludeRefDs`)

But it is still probabilistic in collision-heavy scenarios, not a strict one-to-one deterministic correlation key from submission to acceptance.

## Practical problematic statement

The core problem is:

- Submission identity key in polling starts from `dsReference` (not unique per LTA)
- Final accepted identity key is `refDsMead` (unique), but only available after acceptance

So the app must guess which in-progress row belongs to which LTA before `refDsMead` appears.
That guess can be wrong when two LTAs share the same `dsReference` and are close in time.

## Suggested hardening (next step)

If we want robust handling for this scenario, we should add stronger deterministic anchors from submission time, for example:

- Capture and persist a unique submission-side field that later appears unchanged in consultation
- Increase anchor uniqueness with a multi-field fingerprint (`numeroManifeste`, voyage, date voyage, createdAt, transitaire)
- Delay claim until both `Acceptée` and a stable unique fingerprint match
- Add collision detection mode: when two rows are near-identical, require manual validation or extra checks before BADR finalize

## Update applied now (Date de creation first-anchor)

Your proposal has been implemented in the runtime flow:

- Right after submit, the app navigates to Consultation.
- It captures the newest row for the same `dsReference` and prefers status `Envoyee` or `Nouveau`.
- It immediately stores:
  - `consultationCreatedAtRaw`
  - `consultationNumeroManifeste`
    in each LTA `acheminement.json` automation state.
- Polling then starts with this anchor already available, instead of waiting to discover it later.

This reduces cross-LTA confusion when many rows share the same `dsReference`.

## Expert recommendation on your idea

Your approach is correct and is the strongest practical discriminator available in the visible Consultation grid before `refDsMead` appears.

I recommend this priority order for stable matching:

1. `createdAtFormatted` anchor captured immediately after submit
2. `numeroManifeste` as tie-breaker
3. `submittedAt` proximity fallback only when anchor capture fails

Important caveat:

- `createdAtFormatted` looks minute-precision in UI. If two submissions land in the same minute with same `dsReference`, collisions are still possible.
- In that rare case, also compare `numeroVoyage` and `dateVoyageFormatted` before accepting a row for BADR finalization.

---

This document describes current behavior as implemented, including where and why ambiguous matching can happen even when the code attempts to mitigate it.
