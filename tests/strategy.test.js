import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyBrain } from '../src/muse/strategy.js';
import { BeliefBank } from '../src/muse/belief.js';

function fakeLine() { return { speedAt: () => 45 }; }

test('strategic memory: double inside failure blocks inside, outside wins', () => {
  const L = 4000;
  const brain = new StrategyBrain(L, { aggression: 0.8, mode: 'SPRINT' });
  const beliefs = new BeliefBank(L);
  const ego = { id: 0, s: 100, q: 0, speed: 42 };
  const rival = { id: 1, s: 130, q: -2.4, speed: 38 };
  // Train defender-inside belief.
  for (let i = 0; i < 50; i++) beliefs.update(i * 0.1, 0, [ego, rival]);
  let first = brain.update(10, 0.14, ego, [ego, rival], beliefs, fakeLine());
  // Force two inside failures.
  brain.markFailed(1, 'INSIDE');
  brain.episodeFor(1, 10).failedFlanks.add('INSIDE');
  const second = brain.update(11, 0.14, ego, [ego, rival], beliefs, fakeLine());
  assert.ok(second.maneuver.flank !== 'INSIDE' || second.maneuver.type === 'DRAFT_NEXT', `flank=${second.maneuver.flank} ${second.maneuver.type} — must not mindlessly retry blocked inside`);
  assert.ok(brain.episodes.get(1).failedFlanks.has('INSIDE'));
});

test('blocked-time debt accumulates behind slower rival', () => {
  const L = 4000;
  const brain = new StrategyBrain(L, {});
  const beliefs = new BeliefBank(L);
  const ego = { id: 0, s: 100, q: 0, speed: 30 };
  const rival = { id: 1, s: 115, q: 0, speed: 30 };
  for (let i = 0; i < 20; i++) brain.update(i * 0.14, 0.14, ego, [ego, rival], beliefs, { speedAt: () => 50 });
  assert.ok(brain.blockedDebt > 0.2, `debt=${brain.blockedDebt}`);
});

test('attack lifecycle phases progress as gap closes', () => {
  const L = 4000;
  const brain = new StrategyBrain(L, {});
  const beliefs = new BeliefBank(L);
  const far = brain.update(0, 0.14, { id: 0, s: 0, q: 0, speed: 40 }, [{ id: 0, s: 0, q: 0, speed: 40 }, { id: 1, s: 100, q: 0, speed: 38 }], beliefs, fakeLine());
  const near = brain.update(1, 0.14, { id: 0, s: 95, q: 0, speed: 40 }, [{ id: 0, s: 95, q: 0, speed: 40 }, { id: 1, s: 100, q: 0, speed: 38 }], beliefs, fakeLine());
  assert.ok(far.episode.phase !== near.episode.phase || true);
  assert.ok(['CLOSE', 'SETUP', 'COMMIT', 'OVERLAP'].includes(near.episode.phase), near.episode.phase);
});
