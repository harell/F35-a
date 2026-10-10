/**
 * F35-A — IRGC campaign, mission 2: "Straight Outta Hauraki" (#82, epic #72).
 *
 * An oil tanker leaves the Ports of Auckland for Singapore, out through the Rangitoto Channel into
 * the Hauraki Gulf. The IRGC Navy's fast boats from the Guard's mother ship come for her: three suicide boats on the
 * short clock (they reach her about 2 minutes in; two on Recruit), three Peykaap II missile boats on
 * the long one (they come in a minute into the mission, too late for the opening ripple, and are in
 * launch range 3–4 minutes in; a Kowsar can't be shot down: kill the boat first) and two air-defence
 * boats escorting the waves, with a third on Pilot and Veteran as a picket in the inner harbour under the
 * jet's run-in: the only boats that shoot back, and they see a stealth jet up close (SamTypeData.closeCue).
 * Two hits sink the tanker.
 *
 * The geometry is tuned on the real LINZ coast (tests/missions-g02.test.ts): every boat starts in
 * open water with a clear run to the tanker, and the clocks above hold untouched.
 */
import type { MissionDef } from '../../core/contracts';
import type { XZ } from '../schema';
import { AARGM_RULE } from '../../core/data';
import { mission, target, site } from './common';

const DS = 'DARKSTAR';

/** The tanker (MissionDef ids and the name her crew's radio calls go out under). */
export const G02_TANKER = {
  id: 'tanker',
  group: 'tanker',
  name: 'MT Kōtuku Star',
  /** In the Rangitoto Channel, abeam Rangitoto's west coast, outbound (m). */
  start: { x: 4300, z: -7300 } as XZ,
  /** Out of the channel and north up the Gulf to the Tiritiri Channel and the open sea. */
  path: [
    { x: 4700, z: -10000 },
    { x: 6500, z: -15000 },
    { x: 8400, z: -21000 },
    { x: 8600, z: -26000 },
    { x: 8600, z: -35000 },
  ] as XZ[],
  /** m/s (≈ 12 kt: a loaded VLCC working up to speed in the channel). */
  speed: 6,
} as const;

/** Boat groups (mission group ids). */
export const G02_GROUPS = { suicide: 'suicide_boats', missile: 'missile_boats', ad: 'ad_boats' } as const;

/**
 * The missile boats and their air-defence escort come in on a trigger (#115): the mother ship puts
 * them in the water this many seconds into the mission, about 10 km north of the tanker, so one
 * opening ripple can't cover both waves. Untouched, they reach launch range and start counting down
 * at about 3.6 minutes and launch at about 3.9 (the 3–4 minute clock of #82). A StormBreaker from
 * 20 km glides about two minutes onto a stopped boat, so the second release has to come within about
 * a minute of their arrival, or from closer in, inside the escort's reach.
 * A time, not "half the suicide wave gone": the long clock stays the same whatever the player does
 * about the short one (the bot's first bombs land at 95–105 s, which would push the launch past 4
 * minutes), and an untouched suicide wave still meets them (tests/missions-g02.test.ts). 60 s, not 90:
 * at 90 the bot, egressing from its first ripple, was 0/24 (its second release came too late).
 */
export const G02_MISSILE_WAVE_AT = 60;

/**
 * The player: on CAP over west Auckland at 10,000 ft, nose on the suicide boats 21 km away; the missile
 * boats are 27 km away. From this height a StormBreaker reaches only ~11.5 km, so at the start nothing
 * is in reach (the missile boats not even from 20,000 ft): climb on the way in (height is range) or press
 * in, and at 10,000 ft the release point is inside the AD boats' radar SAM (12 km, up to 20,000 ft).
 * The competent bot's ripple on the suicide boats goes at 20–30 s and lands ~15 s before the first
 * ram (tests/missions-bot.ts); a release after much dithering lands too late.
 */
const g02Start = { x: -15000, z: -2700, altitude: 3000, heading: 68, speed: 250, fuel: 0.9 };

/**
 * Veteran's third escort's picture of the jet (SamSiteDef.closeCue; the AD boat's own is 9 km): the mother
 * ship cues it on a jet inside `range` m whatever its shaping, so its rounds meet the jet running in to the
 * opening release, not only its open bay (playtest r2). At 13.5 km its first pair comes from 13 km a second or
 * two before the opening release: a pilot on the run-in pickles, then beams (the bot: Veteran 5/6, 12–16 rounds
 * at the jet; playtest r4). The range is sharp: from 14 km the pair comes before the release cue, and beaming it
 * first costs the opening ripple and the tanker (14 km: 1/6, 15 km: 0/6).
 */
export const G02_ESCORT_CUE = { range: 13_500, bayRange: 12_000 } as const;

const S = G02_GROUPS;
const chase = { chase: G02_TANKER.group };
const wave2 = { kind: 'time', t: G02_MISSILE_WAVE_AT } as const;
const strike = { strike: { group: G02_TANKER.group }, spawn: wave2 };

export const G02: MissionDef = mission({
  id: 'g02',
  kind: 'campaign',
  index: 2,
  title: 'Straight Outta Hauraki',
  subtitle: 'Escort the tanker through the Gulf boat swarm',
  timeOfDay: 'day',
  weather: 'scattered',
  briefing: [
    `The tanker ${G02_TANKER.name} is leaving through the Rangitoto Channel for Singapore. The Guard's mother ship has put fast boats in the water to stop her. Two hits sink her: a ram, a missile or your own bomb.`,
    'Two clocks. Suicide boats race down the Gulf and reach her in about two minutes. Missile boats arrive from the north after a minute and fire three to four minutes in: their missiles cannot be shot down, so sink the boats first. An air-defence boat rides with each wave, and on Pilot and Veteran another guards the harbour: the only boats that shoot at you.',
    `StormBreakers track a moving boat but glide slowly: release early on the suicide boats. Open on each escort with an AARGM-ER: ${AARGM_RULE}. A bomb alongside the tanker can hit her: gun those boats, and Veteran's third escort. Tip: you start out of reach: climb on the way in.`,
  ],
  recommendedLoadout: 'strike_maritime',
  // air-to-ground only, the weapons that kill a moving boat (#136): StormBreakers for any boat, an
  // AARGM-ER for each air-defence boat's radar. No AMRAAM (nothing hostile flies), no GBU-31
  // (it can't hit a moving boat: #65's c08 trap).
  allowedLoadouts: ['strike_maritime'],
  // Maritime Strike (the StormBreaker, AARGM-ER and gun on boats), then Gulf Defence: beating the
  // air-defence boats' missiles, where players got stuck (the debrief points there too)
  lessons: ['t04', 't05'],
  player: g02Start,
  // eight bombs for five to seven boats: the gun covers the spare boats (#77)
  gunAmmo: 360,
  script: {
    // the built-in hints: the first mission that shoots back gets the MISSILE! defence prompt (beam
    // it, CMS every few seconds), and the first air-to-ground one the TGT / IN RANGE steps (player feedback
    // 2026-10-08: stuck here on Recruit, unable to evade the AD boats' missiles)
    autoHints: true,
    parTime: 300,
    ground: [
      target(G02_TANKER.id, G02_TANKER.group, 'ship', G02_TANKER.start, {
        team: 'neutral',
        vessel: 'tanker',
        hitsToSink: 2,
        name: G02_TANKER.name,
        path: G02_TANKER.path,
        speed: G02_TANKER.speed,
      }),
      // the short clock: three suicide boats down the Gulf, about 2 minutes from her (two on Recruit, #115)
      target('sb1', S.suicide, 'suicide_boat', { x: 4900, z: -10600 }, chase),
      target('sb2', S.suicide, 'suicide_boat', { x: 5300, z: -10750 }, chase),
      target('sb3', S.suicide, 'suicide_boat', { x: 4500, z: -10800 }, { ...chase, minDifficulty: 'pilot' }),
      // Veteran: a fourth one (seven boats to sink, eight bombs)
      target('sb4', S.suicide, 'suicide_boat', { x: 5700, z: -10950 }, { ...chase, minDifficulty: 'veteran' }),
      // the long clock: three missile boats come in at G02_MISSILE_WAVE_AT, ~9 km north of her, in launch range 3–4 minutes in
      target('mb1', S.missile, 'missile_boat', { x: 7420, z: -17690 }, strike),
      target('mb2', S.missile, 'missile_boat', { x: 8770, z: -17140 }, strike),
      target('mb3', S.missile, 'missile_boat', { x: 6170, z: -18240 }, strike),
    ],
    sams: [
      // air-defence boats: one rides with each wave (the second comes in with the missile boats)
      site('ad1', S.ad, 'ad_boat', { x: 4900, z: -11300 }, { escort: S.suicide }),
      site('ad2', S.ad, 'ad_boat', { x: 7470, z: -18440 }, { escort: S.missile, spawn: wave2 }),
      // Veteran: a third rides ahead of the suicide wave on the jet's side of the channel, cued on the jet as it runs
      // in to the opening release (G02_ESCORT_CUE)
      site('ad3', S.ad, 'ad_boat', { x: 2400, z: -6900 }, { escort: S.suicide, escortAft: -4000, escortRight: 2500, minDifficulty: 'veteran', closeCue: G02_ESCORT_CUE }),
      // Pilot and Veteran: a picket in the inner harbour off the city, 11.5 km from the start (outside its reach), under the jet's run-in:
      // the stand-off release on the suicide boats (15–16 km out, 4 km up) falls 6–7 km from it, inside its real
      // envelope (playtest r2: with the escorts alone the bot won 6/6 untouched on every difficulty). Killing it
      // with an AARGM, or a run-in clear of it, opens the stand-off again
      site('ad_h', S.ad, 'ad_boat', { x: -3500, z: -2500 }, { minDifficulty: 'pilot' }),
    ],
    objectives: [
      {
        id: 'o_tanker',
        kind: 'protect',
        group: G02_TANKER.group,
        label: `Protect the ${G02_TANKER.name} (two hits sink her)`,
        primary: true,
        // safe once both waves are sunk and no Kowsar is still in the air: a boat sunk just after its
        // launch doesn't call its missile back (the win used to come before the Kowsar landed)
        until: { kind: 'all', of: [{ kind: 'objective', id: 'o_suicide', state: 'complete' }, { kind: 'objective', id: 'o_missile', state: 'complete' }, { kind: 'munitions_clear', group: S.missile }] },
      },
      { id: 'o_suicide', kind: 'destroy', groups: [S.suicide], label: 'Sink the suicide boats', primary: true },
      { id: 'o_missile', kind: 'destroy', groups: [S.missile], label: 'Sink the missile boats before they launch', primary: true },
      // the escorts are the priority puzzle, not the job: sinking them costs time (and bombs),
      // leaving them means their missiles when you go down for a gun pass
      { id: 'o_ad', kind: 'destroy', groups: [S.ad], label: 'Sink the air-defence boats', primary: false },
    ],
    waypoints: [
      { id: 'wp_suicide', label: 'Suicide boats', kind: 'target', x: 4800, z: -10000, objective: 'o_suicide' },
      { id: 'wp_missile', label: 'Missile boats', kind: 'target', x: 7500, z: -17000, objective: 'o_missile' },
    ],
    triggers: [
      {
        id: 't_master',
        when: { kind: 'time', t: 12 },
        actions: [{ kind: 'radio', from: G02_TANKER.name, text: 'Viper, Kōtuku Star. We can see boats coming down the Gulf at us, fast. We cannot outrun them. Over to you.' }],
      },
      {
        id: 't_suicide_close',
        when: { kind: 'all', of: [{ kind: 'time', t: 75 }, { kind: 'not', of: { kind: 'group_destroyed', group: S.suicide } }] },
        actions: [{ kind: 'radio', from: G02_TANKER.name, text: 'Boats one mile off the bow and closing! Get them off us!', priority: 2 }],
      },
      {
        id: 't_missile_wave',
        when: { kind: 'group_spawned', group: S.missile },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. New contacts: missile boats in the water north of the tanker, an air-defence boat with them, closing. Kill them before they reach launch range.', priority: 2 }],
      },
      {
        // the long StormBreaker glide on the missile boats is quiet: her master calls them closing
        id: 't_missile_close',
        when: { kind: 'all', of: [{ kind: 'time', t: 155 }, { kind: 'group_spawned', group: S.missile }, { kind: 'not', of: { kind: 'group_destroyed', group: S.missile } }] },
        actions: [{ kind: 'radio', from: G02_TANKER.name, text: 'Viper, Kōtuku Star. We have the missile boats on radar, about five miles and closing. They will stop and fire soon.', priority: 2 }],
      },
      {
        id: 't_suicide_dead',
        when: { kind: 'group_destroyed', group: S.suicide },
        delay: 2,
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Suicide boats are all down. Missile boats are the threat now: get them before they launch.' }],
      },
      {
        id: 't_missile_dead',
        when: { kind: 'group_destroyed', group: S.missile },
        delay: 2,
        actions: [{ kind: 'radio', from: G02_TANKER.name, text: 'That is the last of the missile boats. Thank you, Viper.' }],
      },
    ],
    hints: [{ id: 'h_boats', text: 'Boats: TGT, StormBreaker, release early. Kill the missile boats before they count down', when: { kind: 'time', t: 6 }, duration: 8 }],
    opening: [
      // two calls: one was 4 subtitle pages on a phone (tests/hud-textbudget.test.ts allows 3)
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. IRGC Navy fast boats in the Gulf, heading for the tanker: suicide boats with an air-defence boat.', priority: 2 },
      { kind: 'radio', from: DS, text: 'The mother ship is putting missile boats in the water behind them. Weapons free on the boats.', priority: 2 },
    ],
    successText: 'The Gulf is clear and the Kōtuku Star is on her way to Singapore. Good hunting, Viper.',
  },
});
