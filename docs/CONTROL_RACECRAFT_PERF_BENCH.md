# MuseSpark — Control, Racecraft, Performance, Benchmark

## CONTROL.md

Pursuit (lookahead 6+v·0.45, 8–34m) + tracking correction (0.5 gain) + rotation
feedforward (0.7) + slip compensation → `pursuit` angle. MPCC samples 5 steer ×
3 accel-bias rollouts over 12×55ms kinematic horizon, contouring cost
(lateral², yaw², correction², progress reward), anti-twitch preference for prior
solution. Longitudinal: `musePedals` — full throttle when combined-legal,
proportional when combined-limited, coast for |err|<0.6, causal-gate brake only.
Brake events latched (earliest startS wins, wrap-aware), trail-shaped, urgency
override. Safety caps target, emergency forces full brake. Recovery: rejoin/crawl/
controlled reverse with hysteresis.

## RACECRAFT.md

Beliefs update 15Hz, exponential-drift posteriors over HOLD/IN/OUT/MOVE/BRAKE_EARLY/
LATE. Strategy 7Hz + close-rival events. Cost J = route + blocked·w + risk −
pass·v − exit. Episodes: OBSERVE→CLOSE→DRAFT→SETUP→PULL_OUT→COMMIT→BRAKE_ATTACK→
OVERLAP→EDGE_AHEAD→CLEAR/RETAIN/COMPLETE/ABORT (+COUNTERATTACK/REPASSED states).
Outside momentum is a primary (passP base 0.72); inside dive penalized when
defended/failed; switchback rewards defender entry compromise; draft-next banks
time. Defense: INSIDE_COVER/APEX_SHIELD/EXIT_POSITIONING, one move, 4s commit.
Three-wide via corridor geometry (left/right clearance). Contact: shallow rub
tolerated, deep/T-bone triggers supervisor.

## PERFORMANCE.md

Measured (Windows, Node 22, fastLine):

- 1 car: 0.150ms/step (55× realtime) · 3 cars: 0.464ms · 6 cars: 0.918ms (9.1×)
  · 8 cars: 1.302ms (6.4×). Gate: 6/8-car real time — PASS with 7× margin.
- 6-car 120Hz step mean 0.89ms, p95 1.30ms, max 9.5ms (full physics+AI).
- Global-opt offline: ~1.2s full / 0.4s fast (cached per session, never on hot path).
- No per-frame garbage by design: preallocated 20-candidate pool, scratch
  Float64Arrays, no map/filter/sort in hot loops (sorts only over ≤13 scored).

## BENCHMARK_INTEGRATION.md (DONE 2026-09-16 — status, not plan)

Plant parity PROVEN: all 7 sim files byte-identical to benchmark host plant.
`bridge/musespark-bridge.js` (shadow pattern, host owns all physics; core AI
unchanged) + `tools/bridge-smoke.mjs` (local verification vs real host engine,
benchmark tree untouched) + `tools/install-benchmark-bridge.mjs` (mechanical
registration: bridge copy + index.js import/branch/registry + subjects.json pin).
Verified: prepare-subjects clone+pin OK; official shared-host SPRINT 89.82,
0 off/dmg/errors; same-day Astra 78.77; host-physics QUALIFYING 86.875 =
native. Benchmark-tree edits left uncommitted per precedent (files listed in
DEVELOPMENT_REPORT Checkpoint 5). No benchmark-specific physics anywhere —
host stepped everything; shadows only carry state.
