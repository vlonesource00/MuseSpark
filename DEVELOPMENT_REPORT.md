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
  **best 89.82** (SPRINT), 0 off, 0 dmg, 0 errors. Same-day Astra: **78.77**.
  Pinned refs: Supreme 78.34. Muse trails by ~11s shared — the M2 gap, reproduced
  on host physics. No physics advantage anywhere (host stepped everything).
- Benchmark-tree edits (installer-generated, left uncommitted per precedent):
  sandbox/bridges/musespark-bridge.js, index.js (import+branch+registry),
  benchmark/subjects.json (pin). Clone+pin verified: `prepare-subjects --subject
  musespark` → OK.

**Next:** M2 pace gap (mid-corner grip usage, full-line trackability, exit
optimization) and M3 conversion cost (clean alongside→clear without grinding).
No architecture churn without delta evidence.
