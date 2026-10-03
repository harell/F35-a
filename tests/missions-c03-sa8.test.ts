/**
 * #114 item 2 (playtest 2026-10-02 bc94edd, 1.3-i): c03 Iron Hand on Recruit could run forever. On
 * seed 3 the SA-8 shot down every SDB the bot sent, and with no rearming (#63) a player in that spot
 * is left with nothing to do and no end. Now:
 *  - after the player's second bomb / missile shot down by the SA-8, Darkstar marks it, steers the
 *    player to it and calls a low run-in from the west (the `munitions_shot_down` condition);
 *  - the mission has a 15-minute time limit, with a Darkstar call 3 minutes before it and the
 *    runner's HUD countdown (2:00, 1:00, 0:30). The slowest bot win over 6 seeds × 4 difficulties
 *    is 675 s (Pilot seed 3), so no normal win comes near 900 s.
 * Repro: npx vite-node tools/playtest/bot-sweep.ts -- --missions=c03 --diffs=recruit --seeds=4 --maxT=960 --log --json=<file>
 */
import { describe, expect, it } from 'vitest';
import '../tests/linz-setup';
import { C03_TIME_LIMIT } from '../src/missions/content/campaign1';
import { missionById, terrainPadsFor } from '../src/missions';
import type { MissileEntity } from '../src/sim/entities';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { harness, shieldPlayer } from './missions-helpers';
import { runPlaythrough } from './missions-bot';

const c03 = missionById('c03')!;
const CALL = /Gecko is shooting your weapons down/;

/** A 'munition:end' for one of the player's bombs, shot down by `siteId`'s point defence. */
function shotDown(h: ReturnType<typeof harness>, siteId: number): void {
  const p = h.world.player!;
  const fake = { shooterId: p.id, interceptedBy: siteId, def: { category: 'bomb', id: 'gbu39' } } as unknown as MissileEntity;
  h.events.emit('munition:end', { missile: fake, position: p.position.clone(), reason: 'selfdestruct', targetId: null });
}

describe('#114: c03 — Darkstar calls the SA-8 after the second weapon it shoots down', () => {
  it('one loss: no call; the second: the call, the SA-8 marked and the steering cue on it', () => {
    const h = harness(c03, 'recruit');
    h.run(1, () => shieldPlayer(h));
    const sa8 = h.world.sams.find((s) => s.groupId === 'rangi_sa8')!;
    const sa6 = h.world.sams.find((s) => s.groupId === 'rangi_sa6')!;
    shotDown(h, sa8.id);
    shotDown(h, sa6.id); // a loss to another site doesn't count toward the SA-8's
    h.run(5, () => shieldPlayer(h));
    expect(h.of('radio').some((r) => CALL.test(r.text))).toBe(false);
    shotDown(h, sa8.id);
    h.run(5, () => shieldPlayer(h));
    const calls = h.of('radio').filter((r) => CALL.test(r.text));
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/east shore/);
    expect(calls[0].text).toMatch(/low from the west, behind the volcano/);
    expect(sa8.known).toBe(true);
    expect(h.runner.currentWaypoint?.id).toBe('wp_sa8');
  });

  it('the SA-8 already dead: no call', () => {
    const h = harness(c03, 'recruit');
    h.run(1, () => shieldPlayer(h));
    const sa8 = h.world.sams.find((s) => s.groupId === 'rangi_sa8')!;
    h.world.applyDamage(sa8, 99_999, h.world.player!.id, 'aargm');
    shotDown(h, sa8.id);
    shotDown(h, sa8.id);
    h.run(5, () => shieldPlayer(h));
    expect(h.of('radio').some((r) => CALL.test(r.text))).toBe(false);
  });
});

describe('#114: c03 — a time limit, so a sortie with nothing left to drop ends', () => {
  it('15 minutes, well clear of the slowest bot win (675 s), shown on the briefing', () => {
    expect(c03.timeLimit).toBe(C03_TIME_LIMIT);
    expect(C03_TIME_LIMIT).toBeGreaterThanOrEqual(675 + 180);
    // the score's par time stays what it was (parTime would otherwise default to the time limit)
    expect(c03.script.parTime).toBe(420);
  });

  it('Darkstar warns 3 minutes before, then the HUD counts down, then the mission fails "Out of time"', () => {
    const h = harness(c03, 'recruit');
    h.world.player!.position.set(-30000, 7000, 30000); // far from the fight
    h.run(0.2);
    const w = h.world as unknown as { time: number };
    w.time = C03_TIME_LIMIT - 181;
    h.run(0.5, () => shieldPlayer(h));
    expect(h.of('radio').some((r) => /Darkstar\. Three minutes/.test(r.text))).toBe(false);
    // (the radio queue plays the call once the channel is free: a few seconds at most)
    h.run(15, () => shieldPlayer(h));
    expect(h.of('radio').some((r) => /Darkstar\. Three minutes/.test(r.text))).toBe(true);
    expect(h.runner.state).toBe('running');
    w.time = C03_TIME_LIMIT - 0.5;
    h.run(1, () => shieldPlayer(h));
    expect(h.of('hud:message').some((m) => /SECONDS REMAINING/.test(m.text))).toBe(true);
    expect(h.runner.state).toBe('failed');
    expect(h.runner.result(h.world).reason).toBe('Out of time');
  });

  // the playtest's run: Recruit seed 3, the SA-8 shoots down SDBs at 262 s and 441 s (and 625 s)
  it('Recruit seed 3 (was still running at 900 s): Darkstar calls the SA-8, and the run ends by the time limit', { timeout: 300_000 }, () => {
    const t = new TerrainQueryImpl(runSync(generateTerrain({ theater: c03.theater, seed: c03.seed, resolution: 512, features: allFeatures(c03.theater, []), pads: terrainPadsFor(c03) })));
    const r = runPlaythrough('c03', 'recruit', 3, t, { maxT: C03_TIME_LIMIT + 60, log: true });
    const msg = `${r.state}@${r.t}s ${r.reason} ${r.objectives}`;
    expect(r.state, msg).not.toBe('running');
    expect(r.t, msg).toBeLessThanOrEqual(C03_TIME_LIMIT + 1);
    if (r.state === 'failed') expect(r.reason, msg).toMatch(/Out of time|Shot down|Crashed/);
    const call = r.events.find((e) => CALL.test(e));
    expect(call, msg).toBeTruthy();
    // it comes right after the second SDB lost to the SA-8
    const losses = r.events.filter((e) => /RADIO DARKSTAR: \w+ shot down by SA-8/.test(e)).map((e) => Number(e.trim().split(' ')[0]));
    expect(losses.length, msg).toBeGreaterThanOrEqual(2);
    expect(Number(call!.trim().split(' ')[0]) - losses[1], msg).toBeLessThanOrEqual(5);
  });
});
