/**
 * F35-A — IRGC campaign, mission 2: "Straight Outta Hauraki" (#82, epic #72).
 *
 * An oil tanker leaves the Ports of Auckland for Singapore, out through the Rangitoto Channel into
 * the Hauraki Gulf. Fast boats from the IRGC mother ship come for her: three suicide boats on the
 * short clock (they reach her about 2 minutes in; two on Recruit), three Peykaap II missile boats on
 * the long one (they come in a minute into the mission, too late for the opening ripple, and are in
 * launch range 3–4 minutes in; a Kowsar can't be shot down: kill the boat first) and two air-defence
 * boats escorting the waves, the only boats that shoot back, and they see a stealth jet up close
 * (SamTypeData.closeCue). Two hits sink the tanker.
 *
 * The geometry is tuned on the real LINZ coast (tests/missions-g02.test.ts): every boat starts in
 * open water with a clear run to the tanker, and the clocks above hold untouched.
 */
import type { MissionDef } from '../../core/contracts';
import type { XZ } from '../schema';
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
    `The tanker ${G02_TANKER.name} has sailed from the Ports of Auckland for Singapore and is heading out through the Rangitoto Channel into the Hauraki Gulf. The IRGC mother ship has put its fast boats in the water to stop her. Clear the way.`,
    'Suicide boats are racing down the Gulf straight at her: they reach her in about two minutes. Peykaap II missile boats come in from the north about a minute into the fight, too late for your first release. They stop at launch range three to four minutes from now and count down, and a Kowsar sea-skimmer cannot be shot down: kill each boat before its countdown ends. An air-defence boat rides with each wave, with a Tor-type radar SAM good to 20,000 ft and 12 km and shoulder-launched missiles inside 5 km. They are the only boats that shoot at you. Stealth will not hide you from them up close: their trackers pick you up inside about 9 km, and inside 12 km the moment your bay opens.',
    'Two hits sink her: a ram, a Kowsar, or one of your own bombs. Bring StormBreakers. A GBU-53/B tracks a moving boat; a JDAM or a GBU-39 does not, and this mission does not offer them. The StormBreaker glides slowly from long range, so release early on the suicide boats. You start at 10,000 ft with every boat out of reach: height is range, so climb on the way in or press in under the escorts\' missiles. A bomb aimed at a boat alongside the tanker can hit her instead. Close in on those with the gun: you have 360 rounds today. Take all eight StormBreakers: with four, the boats they cannot cover are gun passes under the escorts\' missiles.',
  ],
  recommendedLoadout: 'strike_sdb2_full',
  // only loadouts with a bomb that can hit a moving boat (GBU-31 / GBU-39 can't: #65's c08 trap)
  allowedLoadouts: ['strike_sdb2_full', 'strike_sdb2'],
  player: g02Start,
  // up to eight bombs for six to nine boats: on Ace the gun is part of the plan (#77)
  gunAmmo: 360,
  script: {
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
      // Veteran up: a fourth one (seven boats to sink, eight bombs)
      target('sb4', S.suicide, 'suicide_boat', { x: 5700, z: -10950 }, { ...chase, minDifficulty: 'veteran' }),
      // Ace: a fifth one (nine boats to sink, eight bombs: the gun is part of the plan)
      target('sb5', S.suicide, 'suicide_boat', { x: 4100, z: -11050 }, { ...chase, minDifficulty: 'ace' }),
      // the long clock: three missile boats come in at G02_MISSILE_WAVE_AT, ~9 km north of her, in launch range 3–4 minutes in
      target('mb1', S.missile, 'missile_boat', { x: 7420, z: -17690 }, strike),
      target('mb2', S.missile, 'missile_boat', { x: 8770, z: -17140 }, strike),
      target('mb3', S.missile, 'missile_boat', { x: 6170, z: -18240 }, strike),
      // Ace: a fourth one too, carrying both its Kowsars (two countdowns, and two hits sink her)
      target('mb4', S.missile, 'missile_boat', { x: 10070, z: -16540 }, { ...strike, strike: { group: G02_TANKER.group, missiles: 2 }, minDifficulty: 'ace' }),
    ],
    sams: [
      // air-defence boats: one rides with each wave (the second comes in with the missile boats)
      site('ad1', S.ad, 'ad_boat', { x: 4900, z: -11300 }, { escort: S.suicide }),
      site('ad2', S.ad, 'ad_boat', { x: 7470, z: -18440 }, { escort: S.missile, spawn: wave2 }),
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
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. IRGC fast boats in the Gulf, heading for the tanker: suicide boats with an air-defence boat. The mother ship is putting missile boats in the water behind them. Weapons free on the boats.', priority: 2 },
    ],
    successText: 'The Gulf is clear and the Kōtuku Star is on her way to Singapore. Good hunting, Viper.',
    // the IRGC campaign's last mission: the win plays its ending (playtest 2026-10-02 bc94edd, 1.4-e)
    campaignFinale: true,
  },
});
