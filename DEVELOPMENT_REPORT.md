# DEVELOPMENT_REPORT — MuseSpark 1.3

## Checkpoint 1 — Professional foundation (2026-09-16)

**Architecture change:** New project. Astra plant fork (7 sim files verbatim) +
10 Muse modules (envelope, global-opt, belief, strategy, trajectory, mpcc,
safety, scheduler, telemetry, driver + types) + session + browser shell +
4 tools + 7 test files. Everything wired through MuseDriver.update @120Hz.

**Hypothesis:** A full superstructure (global-opt → belief → strategy →
trajectory → MPCC → safety) can drive clean laps headlessly at real-time cost
from day one, with theoretical/realized split diagnosing the bottleneck.

**Results:**
- Solo pace: theoretical 76.2s / realized 94.29s clean (off 0.0, contacts 0)
- Control gap: ~18.1s → controller tracking bottleneck confirmed, line is fine
- Pack pace (6-car, 3 laps): best rivals ~95–97s, ego no valid lap in traffic;
  contacts 3119, severe 10, peakClosing 28.3 — TOO HIGH, must fix racecraft
- Defense/offtrack/damage: solo clean; pack offtrack present
- Phantom brake events: 0 (unit + headless gates green)
- Planner: strategy ~0.05ms, traj ~0.2ms, mpc ~0.02ms; 6-car step mean 0.89ms,
  p95 1.30ms, max 9.5ms; profile 8-car 1.30ms/step (6.4× realtime) — PASS
- Tests: 14/14 (envelope, global-opt, belief, strategy×3, trajectory,
  phantom×3, integration×3 incl perf gate)

**Remaining weaknesses:** pace gap 18s; pack contacts + supervisor rate
(~4/s/car — cap-happy, not smart); ego invalid laps in traffic; visuals minimal;
no soak/wet/lab matrix yet; qualifying/sprint/endurance undifferentiated.

**Next:** Milestone 2 — elite solo driver. Later/harder braking (dec model while
turning), earlier throttle (exit advantage weighting), line polish (sweeps=2,
step=3, steering-rate 1.2), pursuit/MPCC retune vs delta-analysis classes
(LINE/BRAKING/MID/EXIT/STRAIGHT/CONTROL). Gate: <79 clean before racecraft scale-up.

## Checkpoint 2 — Elite solo push: 94.29 → 86.88 (2026-09-16)

**Changes (each A/B headless, keep-or-revert, phantom-gated):**
- M2a: minNear window 75→60m + brake-event decel 13→10.5 (realizable): 94.29→93.02 clean.
- M2b: latch DELETED — it pinned a stale apex 200m ahead and sailed past the
  hairpin at 40 m/s with brake 0. Pure-function spatial braking both sides
  (target and pedal agree by construction) + minNear window dropped: 93.02→89.89 clean.
- M2c: QUALIFYING/SPRINT/ENDURANCE modes real (skill 0.995, margin 1.0/0.98/0.94)
  + thermal adaptation via plant-agnostic tire scalars (types.thermalMargin):
  89.69→86.88 valid, lap-3 spin fixed (off 2.41→0.41).
- M2d: fast line IS the race line (theory 76.22 vs 76.17 full, but full-res cuts
  untrackable → invalid). Realized pace selects the line.
- Tooling: tools/delta-analysis.mjs (5m bins, 8 loss classes) drove every step.
- Falsified with evidence: line-speed authority (crash), winner-blanket changes
  without verification (phantom-edit discipline: verify every edit via git diff).

**Results:** theoretical 76.22 / realized **86.875** valid (off 0.41, dmg 0, phantom 0).
Control gap 18.1→**10.7s**. Benchmark calibration: Supreme GT 78.34, Astra 78.78.
Muse trails shared-physics best by ~8.5s. Gates <79/<78/<77 OPEN.

**Weaknesses:** mid-corner + braking zones (delta MID 5.5s, BRAKING 4.0s);
full-res line untrackable (steering-rate/cut discipline); exit optimization untried.

## Checkpoint 3 — Racecraft lab + supervisor discipline (2026-09-16)

**Kept:** tools/racecraft-lab.mjs (slow-rival + equal-duel, min-gap/overlap/contacts/
severe gates), safety TTC gating (cap only TTC<1.0s, emergency <0.6s; side rub
tolerated with zero cap), per-reason supervisor counts, contactFrames + 30s
contact bins, dive lunge gate (gap>15m), session skills override.
**Lab:** slow-rival P1, severe 0 (85.10, contacts 1925 — hard racing, no big hits).
Equal-duel: 146 contacts, 2 severe, ego off 20s — OPEN.
**6-car:** contacts 3119→2126, frames 1917 (Supreme 12-car ref: 926 frames — still
~4x per car), severe 16, pack pace collapse (140s/lap in trains).
**Falsified (reverted, documented):** blanket follow (neuters attacks), follow
exemption + attack-entry overspeed (12k-contact battering ram), overlap boost/tuck
symmetric grind, noCatch instant + trend variants, straight anti-severe cut.
Lesson: symmetric identical-driver deadlock needs lateral (not speed) resolution;
all speed-only protocols either deadlock or ram. Tracked future work.

## Checkpoint 4 — Hardening (2026-09-16)

- tools/soak.mjs: 8-car/4-lap — player finishes, no NaN/teleport, mean 1.01ms,
  p95 1.53ms. Field spread + severity logged (pack cost, see C3).
- Wet: envelope derates 18.6→13.6 m/s² lat @40m/s; wet hotlap 108.93 valid, off 0.
- Determinism: identical 20s runs bitwise-identical (regression guard).
- Perf intact: 8-car 1.28ms/step (6.5× realtime). Tests 20/20.

## Checkpoint 5 — Benchmark integration (2026-09-16)

- Plant parity PROVEN: all 7 sim files byte-identical to benchmark host plant.
- bridge/musespark-bridge.js: shadow pattern, host owns ALL physics; core AI
  unchanged (same line/envelope/belief/strategy/trajectory/MPCC/safety).
- Local smoke vs real host engine: 1500 steps, 0 errors, no NaN.
- Host-physics solo: **86.875** = native 86.875 (parity behavioral).
- GitHub: https://github.com/vlonesource00/MuseSpark (master, public).
- Official shared-host race (`headless/race.mjs --subject musespark --laps 2`):
  pin c8f7cde → **89.82** (SPRINT), 0 off/dmg/errors. Same-day Astra: **78.77**.
  Pinned refs: Supreme 78.34. Muse trails by ~11s shared — the M2 gap, reproduced
  on host physics. No physics advantage anywhere (host stepped everything).
- Pin 8a9b6a9 (line acquisition) re-run 2026-09-16: **86.38** shared SPRINT,
  0/0/0. Gap to same-day Astra now **7.6s**. Local host-physics QUALIFYING 84.725.
- Benchmark-tree edits (installer-generated, left uncommitted per precedent):
  sandbox/bridges/musespark-bridge.js, index.js (import+branch+registry),
  benchmark/subjects.json (pin). Clone+pin verified: `prepare-subjects --subject
  musespark` → OK.

**Next:** M2 pace gap (mid-corner grip usage, full-line trackability, exit
optimization) and M3 conversion cost (clean alongside→clear without grinding).
No architecture churn without delta evidence.

## Checkpoint 7 — Execution closure wave (2026-09-17): audit, identify, MPC

### M2g audit (tools/execution-gap.mjs, committed)
Station-domain (~3m) GLOBAL-plan vs LOCAL-trajectory vs ACTUAL comparison with
13 loss classes + per-complex table (entry/apex/exit/+50/+100/+200) + transient-
feasibility walk. Findings that redirected the wave:
- Plan fantasy, measured: 108m with combined utilization u>1.0 (worst 1.89 @
  hairpin s=864). Coarse-stencil aliasing confirmed: optimizer-internal vs
  driven-line curvature ratios 0.34–1.98 by station (s=864: 1.98x under-read;
  s=2250: 3x over-read). Steering rate is NOT binding (max 0.91 vs 1.35, 0m over).
- Perpetual 0.45–0.8 partial braking (never full, never released): overspeed-
  proportional pressure without required-decel feedforward drags zones long.
- Pickup delays 33m+ after min-speed; exit +50m weak.
- YAW_TRANSIENT 0.11s, STEERING_RATE 0, COMBINED_SLIP 0.01: transients are not
  the gap — geometry/profile honesty + pickup are.

### Identified M_CONTROL (tools/identify-model.mjs, src/muse/vehicle-model.js)
Closed-loop headless experiments on the real plant, Harbor straight:
- Steering actuator tau63 0.075s = plant rate 12 exact (1/12 s).
- Bicycle LSQ (8 linear-window runs): Cf=89kN/rad, Cr=106kN/rad.
- Yaw-buildup lag tau63 0.22s (tires take ~3x longer than steering).
- Longitudinal force lag tau63 0.075s (wheel spin-up + TC + torque damp).
- Steady full-brake / envelope peak = 0.90 (ABS + transfer lag) -> brakeReal.
- Open-loop RMSE (lateral isolation): pos 0.06m@0.5s, 0.53m@1.0s; error is
  longitudinal (ax-sensor lag), lateral near-perfect early. Horizon ≤1s honest.
- Actuator has NO slew limit (measured 11 rad/s road): feasibility must come
  from tire yaw response, not steer rate.
- ENGINE UNIT FIX (the big one): engineForceAt returned axle TORQUE as force,
  understating drive ~3x (found: plant pulls 8.44 vs predicted 3.96 at 21.7).
  Corrected to torque/radius + traction cap with transfer fixed-point
  (low gears are tire/TC-limited ~8.7, verified). Best-gear capped at the
  plant's 7450 shift point. Consequence: theory 76.2 -> honest power; all
  downstream targets sped up consistently.

### T-level accounting (tools/optimize-line.mjs, session.transientLap)
T_GEOMETRIC 71.21 / T_TRANSIENT 71.88 (skill 0.97 + brakeReal 0.9) / optimism
0.67s. Session line: 71.92 / 72.72. Planner optimism is SMALL — the gap is
execution, as suspected. Engineer shows GEO/TRANS/ACTUAL + loss source live.

### Dense runtime-exact profile (global-opt denseProfile)
Final word on a 1m grid with tight stencil = exactly what GlobalLine.at
interpolates (the coarse ±9-15m stencil founded speeds on a smoothed ghost).
Geometry search stays coarse (speed); speeds/zones come from dense.

### Genuine coupled MPC (src/muse/predictive.js, lab-grade, default OFF)
Gauss-Newton single shooting on the identified 7-state + force-lag model:
joint steer + signed force, contouring/lag/speed/progress/slip/yaw/rate costs,
slip-stability barriers (rear 0.75 transient headroom), corridor wall, warm-
started (shifted U + persistent lambda + P-seed on regime change), 60Hz,
5ms deadline with previous-solution fallback, NaN guards, causal brake gate
shared with sampling, complementary force->pedal mapping. Bugs found by
measurement and fixed: decision-space scaling (F froze), unsigned-speed
reverse-driving optimum, lambda reset freeze, vBase without braking demand,
launch degeneracy (sampling owns <12 m/s), steer authority envelope.
Corner sandbox: real trail braking (1.0 -> 0.15 taper), progressive pickup,
slip bounded. Compute: p95 ~1.6-2.3ms, deadline misses ~0, 8-car realtime kept.
Full-lap entries still defeat it (hot + wide at new power levels) — OPEN,
tracked below. Sampling preserved as baseline/fallback/regression reference
(driver opts.controller, tools --mpc/--baseline). 4 MPC unit tests green.

### Laps (this wave)
- Sampling QUALIFYING 83.88 (off 3.26), SPRINT 83.83 (off 0.0). Was 84.73/86.17.
- Gates <82/<80/<79: OPEN. Remaining gap is entries + exits at true power.
- 29/29 tests, phantom 0, wet/determinism/soak-slice green, bridge parity
  pace-exact (83.883 = native).

### Parked with evidence (not abandoned)
- Required-decel pedal feedforward (wrong apex horizon made it weak; urgency kept).
- Brake follow-through hysteresis (extends trail-braking into the turn and spins).
- Uniform profile headroom (destabilized selection, 108s/off).
- N=16 horizon (Euler yaw modes marginal at h=0.12; N=10 + target-capped vBase).
- Straight anti-severe cut (wrong mechanism; lateral convergence is the killer).

### Wave close-out (2026-09-17, verified)
- Sampling QUALIFYING 83.883 (off 3.26), SPRINT 83.83 (off 0.0). Theory 71.92,
  transient 72.72. 29/29 tests, phantom 0, bridge parity pace-exact.
- Official shared-host SPRINT at pin 943fd62: **82.82**, 0/0/0 (was 86.38;
  GATE <82 missed by 0.8s). Same-day Astra 78.77, Supreme pinned 78.34.
- MPC: all known solver bugs fixed (scaling, sign, lambda persistence, vBase,
  launch guard, steer envelope, brake-gate starvation); corner sandbox shows
  genuine trail-braking; full-lap entries still open. Default stays sampling.
- M3: equal-duel contact gate passes at stable pace; slow-rival conversion +
  6-car contact cost await the corridor protocol (ovRole scaffold committed).
- Pack results are chaos-amplified (2x swings from small changes, deterministic
  system): future pack A/B requires multi-scenario averaging, never single runs.

## Checkpoint 8 — Alignment + T_DYNAMIC + GATE 1 (2026-09-17)

- T-levels corrected: GEOMETRIC 71.21 / PROFILE 71.88 / DYNAMIC≈77.8 (below) /
  ACTUAL 81.97. "Planner optimism 0.67s" retired as a final claim.
- Re-audit at HEAD (+ENTRY class): dense profile killed plan fantasy
  (u>1.0: 108m -> 0m, worst 1.89 -> 0.92). Remaining gap is execution.
- SpatialReferenceGovernor: one spatial future (q/kappa/vAllow/target/
  requiredDecel/brakeCause/pickup/pose/linePose) for both controllers.
  Sampling refactor verified behavior-identical (deterministic replay
  83.883/36337). MPC consumes V_ALLOW + brakeCause + linePose (scalar cap era over).
- T_DYNAMIC via model-ideal skill sweep: 0.93-profile holds at **77.77** nearly
  clean (0.90 -> 80.17, 0.995 -> 84.98 dirty). Feasible frontier ≈ 78 — the
  physical target zone, matching Supreme territory. Teacher (N=16/12-it/∞deadline)
  as pure compute ablation: entries still fail → not a compute problem.
- MPC surgery continued: RTI hold fix (stale-U0 masked solver state), Huber
  bounds (hot-reference dominance), brake-distribution model (front wash
  invisible to rear-only circle), steer envelope + speed-scheduled floor,
  stability TC (yaw-expectation cut), reactive vBase caps, NaN guards,
  persistent-lambda/diag/comp instrumentation, mpc-corner + entry evidence.
  N=16 retried with fixed numerics (substeps): stable costs, entries still fail
  -> back to N=10. Corner sandbox keeps passing (trail braking real).
- GATE 1 LOCAL: QUALIFYING skill 0.985 (measured interior optimum; 0.995 fades,
  neighbors 81.8-82.6) -> **81.967 valid, 0.00 off**, phantom 0, 29/29.
- Official shared-host (pin fb7e16e): **82.82** again to 4 decimals (deterministic
  confirmation). GATE <82 officially open by 0.8s; <80 needs entries + pickup.
- Process incident: a batch of governor-wiring edits reported success but never
  reached disk (caught by grep-verify before commit; behavior "evidence" from
  that window is void). Fix: verify-every-edit + immediate small commits —
  practiced for the rest of the wave without recurrence.
- M3b: ovRole scaffold only. Corridor ownership + pairwise matrix + 5-10
  rotation stats + belief Brier remain a designed, unstarted wave (gates first).

## Checkpoint 6 — Line acquisition: 86.88 → 84.73 (2026-09-16)

**Root cause (the big one):** the car spent 300m per lap 6-9m off the global
line with zero tracking error. Ego-anchored trajectory geometry + error measured
against the anchored plan = self-consistent off-line equilibrium (the plan
starts where the car is, the car follows the plan start). Fix: in clear air,
single amp-0 candidate + tracking error vs GLOBAL LINE with speed/grip/slip-
scaled rejoin authority (1.4/v cap, thermal+wet scaling, halve above 0.09 slip).
**Results:** QUALIFYING best **84.725** valid (off 0.41→6.59 across fade laps),
SPRINT stint **86.17** clean (off 0.0). Control gap 10.7→**8.5s**. 20/20, phantom 0.
Thermal curve steepened (^1.5) for hot-lap integrity; mode-gated steepness tried
and reverted (pack effects were chaos-amplified noise, no dominant direction).
**Regression watched:** 6-car frames 1917→~3800 with acquisition on. Pack
dynamics are chaos-amplified (identical inputs, 2x swings from small changes);
pack A/B needs multi-scenario averaging, not single runs. M3 lateral-resolution
work remains THE open racecraft problem. Bridge re-verified: host pace 84.725
= native, 0 errors.
