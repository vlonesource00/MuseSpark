// MuseSpark strategic race optimization — multi-second / multi-corner horizon.
// Persistent attack episodes, flank memory (anti-stubbornness), blocked-time
// debt, outside/switchback primaries, joint attack+defense, three-wide corridors.
import { clamp, wrap } from '../sim/math.js';

export const PHASES = ['OBSERVE', 'CLOSE', 'DRAFT', 'SETUP', 'PULL_OUT', 'COMMIT', 'BRAKE_ATTACK', 'OVERLAP', 'EDGE_AHEAD', 'CLEAR', 'RETAIN', 'COMPLETE', 'ABORT', 'COUNTERATTACK', 'REPASSED'];

export class AttackEpisode {
  constructor(targetId, t) {
    this.episodeId = Math.floor(Math.random() * 1e9);
    this.targetId = targetId;
    this.startTime = t;
    this.blockedTime = 0;
    this.estimatedLoss = 0;
    this.primaryStrategy = 'OBSERVE';
    this.backupStrategy = 'DRAFT_NEXT';
    this.selectedFlank = 'NONE';
    this.failedFlanks = new Set();
    this.attemptCount = 0;
    this.passProbability = 0.1;
    this.commitUntil = 0;
    this.overlapDuration = 0;
    this.exitAdvantage = 0;
    this.phase = 'OBSERVE';
    this.lastUpdate = t;
  }
}

// flank: 'INSIDE' | 'OUTSIDE' | 'SWITCHBACK'
export class StrategyBrain {
  constructor(trackLength, opts = {}) {
    this.trackLength = trackLength;
    this.episodes = new Map(); // targetId -> AttackEpisode
    this.blockedDebt = 0;
    this.aggression = opts.aggression ?? 0.72;
    this.mode = opts.mode ?? 'SPRINT'; // QUALIFYING | SPRINT | ENDURANCE
    this.defense = { threatId: null, plan: 'NONE', commitUntil: 0, cost: 0 };
    this.explanation = '';
  }
  episodeFor(targetId, t) {
    if (!this.episodes.has(targetId)) this.episodes.set(targetId, new AttackEpisode(targetId, t));
    return this.episodes.get(targetId);
  }
  // Main entry: ego {s,q,speed}, rivals [{id,s,q,speed}], beliefs BeliefBank, line GlobalLine.
  update(t, dt, ego, rivals, beliefs, line) {
    const L = this.trackLength;
    // Find lead rival ahead within 120m same-pace corridor.
    let target = null, bestGap = Infinity;
    for (const r of rivals) {
      if (r.id === ego.id) continue;
      const gap = wrap(r.s - ego.s + L * 1.5, L) - L * 0.5;
      if (gap > -8 && gap < 120 && gap < bestGap) { bestGap = gap; target = { ...r, gap }; }
    }
    // Find rear threat.
    let rear = null, rearGap = Infinity;
    for (const r of rivals) {
      if (r.id === ego.id) continue;
      const gap = wrap(ego.s - r.s + L * 1.5, L) - L * 0.5;
      if (gap > -5 && gap < 60 && gap < rearGap) { rearGap = gap; rear = { ...r, gap }; }
    }
    // Blocked-time debt: losing pace behind slower rival.
    if (target && target.gap < 35 && ego.speed < target.speed + 1.5) {
      const targetV = Math.max(8, line.speedAt(ego.s + 30));
      const loss = Math.max(0, (targetV - ego.speed) / Math.max(8, targetV));
      this.blockedDebt += loss * dt;
      const ep = this.episodeFor(target.id, t);
      ep.blockedTime += loss * dt;
      ep.estimatedLoss = ep.blockedTime;
    } else {
      this.blockedDebt = Math.max(0, this.blockedDebt - dt * 0.25);
    }

    let maneuver = { type: 'HOLD_LINE', flank: 'NONE', commit: 0, targetId: target ? target.id : null, reason: 'clear air — global optimum' };
    if (this.mode === 'QUALIFYING' || !target) {
      this.explanation = 'CLEAR AIR: committed to global time-optimal line.';
      this.updateDefense(t, rear, ego);
      return { maneuver, target, rear, blockedDebt: this.blockedDebt };
    }
    const ep = this.episodeFor(target.id, t);
    const belief = beliefs.get(target.id);
    const post = belief.posterior;
    // Flank availability: a flank blocked after 2 failures until evidence changes.
    const insideBlocked = ep.failedFlanks.has('INSIDE') && (post.DEFEND_INSIDE > 0.25 || ep.failedFlanks.size >= 1);
    // Candidate evaluation: J = route_time + blocked + risk + penalties - pass_value - exit.
    const gap = target.gap;
    const closing = ego.speed - target.speed;
    const cands = [];
    // (noCatch retired 2026-09-16: instant-closing misfires in corners and
    // doubled slow-rival grinding via SWITCHBACK; trend variant trapped the
    // car in wake-offtrack. Patience is handled by DRAFT_NEXT economics.)
    // OUTSIDE MOMENTUM (primary, not fallback)
    {
      const defendOut = post.DEFEND_OUTSIDE + post.MOVE_OUTSIDE * 0.5;
      const passP = clamp(0.72 - defendOut * 0.9 + (ep.selectedFlank === 'OUTSIDE' ? 0.06 : 0) - (ep.failedFlanks.has('OUTSIDE') ? 0.35 : 0), 0.03, 0.92);
      const routeCost = 0.24 - Math.min(0.2, Math.max(0, closing) * 0.02);
      const J = routeCost + (1 - passP) * 1.6 + defendOut * 0.8 - passP * 1.9 - 0.35;
      cands.push({ type: 'OUTSIDE_MOMENTUM', flank: 'OUTSIDE', passP, J, risk: defendOut > 0.4 ? 'MED' : 'LOW', reason: `outside carry; defendOut ${(defendOut * 100) | 0}%` });
    }
    // INSIDE DIVE (gated: no long-range lunges — gap>15m kills it. Lunges
    // from distance arrive with unsurvivable closing speed: severe contacts.)
    {
      const defendIn = post.DEFEND_INSIDE + post.LATE_DEFEND * 0.4;
      let passP = clamp(0.62 - defendIn * 1.1 - (insideBlocked ? 0.4 : 0), 0.02, 0.9);
      const lunge = gap > 15;
      if (lunge) passP *= 0.3;
      const J = 0.1 + (1 - passP) * 1.8 + defendIn * 1.0 - passP * 1.7 + (insideBlocked ? 0.9 : 0) + (lunge ? 1.5 : 0);
      cands.push({ type: 'INSIDE_DIVE', flank: 'INSIDE', passP, J, risk: defendIn > 0.4 ? 'HIGH' : 'MED', blocked: insideBlocked, reason: insideBlocked ? `inside BLOCKED (failed before, defendIn ${(defendIn * 100) | 0}%)` : `gap ${gap.toFixed(1)}m defendIn ${(defendIn * 100) | 0}%` });
    }
    // SWITCHBACK (defender compromises exit)
    {
      const entryComp = post.DEFEND_INSIDE > 0.35 ? 0.7 : 0.3;
      const passP = clamp(0.35 + entryComp * 0.4 - (ep.failedFlanks.has('SWITCHBACK') ? 0.25 : 0), 0.03, 0.85);
      const J = 0.42 + (1 - passP) * 1.4 - passP * 1.8 - entryComp * 0.4;
      cands.push({ type: 'SWITCHBACK', flank: 'SWITCHBACK', passP, J, risk: 'LOW', reason: `defender entry compromise ${(entryComp * 100) | 0}%` });
    }
    // DRAFT_NEXT (patient)
    {
      const passP = 0.3;
      const J = 0.55 + ep.blockedTime * 0.35 - 0.2;
      cands.push({ type: 'DRAFT_NEXT', flank: 'NONE', passP, J, risk: 'LOW', reason: `bank time, debt ${ep.blockedTime.toFixed(2)}s` });
    }
    cands.sort((a, b) => a.J - b.J);
    let pick = cands[0];
    // Commitment: hold flank unless unsafe/blocked/dominated (anti-twitch).
    if (ep.selectedFlank !== 'NONE' && t < ep.commitUntil) {
      const current = cands.find((c) => c.flank === ep.selectedFlank);
      if (current && current.J < pick.J + 0.55 && !current.blocked) pick = current;
    } else if (pick.flank !== ep.selectedFlank && ep.selectedFlank !== 'NONE') {
      // Require clear dominance to switch (hysteresis 0.3).
      const current = cands.find((c) => c.flank === ep.selectedFlank);
      if (current && pick.J > current.J - 0.3) pick = current;
    }
    if (pick.flank !== ep.selectedFlank) {
      ep.attemptCount += pick.flank === 'NONE' ? 0 : 1;
      ep.selectedFlank = pick.flank;
      ep.commitUntil = t + 4.5;
    }
    ep.primaryStrategy = pick.type;
    ep.passProbability = pick.passP;
    ep.phase = gap < 8 ? 'OVERLAP' : gap < 20 ? 'COMMIT' : gap < 45 ? 'SETUP' : 'CLOSE';
    ep.lastUpdate = t;
    // Phase mapping to lifecycle naming.
    maneuver = { type: pick.type, flank: pick.flank, commit: ep.commitUntil - t, targetId: target.id, passP: pick.passP, J: pick.J, reason: pick.reason, risk: pick.risk };
    const saving = clamp(ep.blockedTime * 0.9 + pick.passP * 1.4, 0, 4);
    this.explanation = `SELECTED: ${pick.type} | pass ${(pick.passP * 100) | 0}% | debt ${ep.blockedTime.toFixed(2)}s | save ~${saving.toFixed(2)}s | ${pick.reason}` +
      (cands[1] ? ` | rejected ${cands[1].type} (${(cands[1].passP * 100) | 0}%, ${cands[1].reason})` : '');
    this.updateDefense(t, rear, ego);
    // Joint attack+defense: keep both maneuver and defense live simultaneously.
    return { maneuver, target, rear, blockedDebt: this.blockedDebt, episode: ep };
  }
  markFailed(targetId, flank) {
    const ep = this.episodes.get(targetId);
    if (ep && flank && flank !== 'NONE') ep.failedFlanks.add(flank);
  }
  markPassed(targetId) {
    const ep = this.episodes.get(targetId);
    if (ep) { ep.phase = 'COMPLETE'; }
  }
  updateDefense(t, rear, ego) {
    if (!rear || rear.gap > 45) { this.defense = { threatId: null, plan: 'NONE', commitUntil: 0, cost: 0 }; return; }
    // One move, no weaving. Cover inside if threat close; else exit positioning.
    const plan = rear.gap < 18 ? 'INSIDE_COVER' : rear.gap < 35 ? 'APEX_SHIELD' : 'EXIT_POSITIONING';
    if (this.defense.plan !== plan || t > this.defense.commitUntil) {
      this.defense = { threatId: rear.id, plan, commitUntil: t + 4.0, cost: rear.gap < 18 ? 0.35 : 0.12 };
    }
  }
  // Three-wide corridor geometry: left/right clearance + future pinch.
  corridor(ego, rivals, halfWidth) {
    let left = ego.q + halfWidth, right = halfWidth - ego.q;
    for (const r of rivals) {
      if (r.id === ego.id) continue;
      if (Math.abs(r.s - ego.s) > 25) continue;
      const clearance = Math.abs(r.q - ego.q) - 2.0; // car widths ~2m
      if (r.q < ego.q) left = Math.min(left, Math.abs(clearance));
      else right = Math.min(right, Math.abs(clearance));
    }
    return { leftClear: Math.max(0, left), rightClear: Math.max(0, right), threeWide: left < 3 && right < 3 };
  }
}
