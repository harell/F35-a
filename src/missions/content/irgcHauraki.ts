/**
 * F35-A — IRGC campaign, mission 2: "Straight Outta Hauraki" (#82, epic #72).
 *
 * An oil tanker leaves the Ports of Auckland for Singapore, out through the Rangitoto Channel into
 * the Hauraki Gulf. Fast boats from the IRGC mother ship come for her: three suicide boats on the
 * short clock (they reach her about 2 minutes in), three Peykaap II missile boats on the long one
 * (in launch range 3–4 minutes in, and a Kowsar can't be shot down: kill the boat first) and two
 * air-defence boats escorting them, the only boats that shoot back. Two hits sink the tanker.
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
 * The player: on CAP over the upper Waitematā at 15,000 ft, nose on the suicide boats 16 km away.
 * A StormBreaker glides at ~170–200 m/s, so a ripple released in the first half-minute lands well
 * ahead of the 2-minute clock; one released from 10 km after a minute's run-in lands too late. Pressing
 * on at this height flies into the AD boats' radar SAM (12 km, up to 20,000 ft): climb, or stand off.
 */
const g02Start = { x: -10500, z: -4500, altitude: 4500, heading: 68, speed: 250, fuel: 0.9 };

const S = G02_GROUPS;
const chase = { chase: G02_TANKER.group };
const strike = { strike: { group: G02_TANKER.group } };

export const G02: MissionDef = mission({
  id: 'g02',
  kind: 'campaign',
  index: 2,
  title: 'Straight Outta Hauraki',
  subtitle: 'Escort the tanker out through the Gulf — boat swarm',
  timeOfDay: 'day',
  weather: 'scattered',
  briefing: [
    `The tanker ${G02_TANKER.name} has sailed from the Ports of Auckland for Singapore and is heading out through the Rangitoto Channel into the Hauraki Gulf. The IRGC mother ship has put its fast boats in the water to stop her. Clear the way.`,
    'Three suicide boats are racing down the Gulf straight at her: they reach her in about two minutes. Three Peykaap II missile boats follow. They stop at launch range three to four minutes from now and count down, and a Kowsar sea-skimmer cannot be shot down: kill each boat before its countdown ends. Two air-defence boats escort them, with a Tor-type radar SAM good to 20,000 ft and shoulder-launched missiles inside 5 km. They are the only boats that shoot at you.',
    'Two hits sink her: a ram, a Kowsar, or one of your own bombs. Bring StormBreakers. A GBU-53/B tracks a moving boat; a JDAM or a GBU-39 does not, and this mission does not offer them. The StormBreaker glides slowly from long range, so release early on the suicide boats. A bomb aimed at a boat alongside the tanker can hit her instead. Close in on those with the gun: you have 360 rounds today.',
  ],
  recommendedLoadout: 'strike_sdb2_full',
  // only loadouts with a bomb that can hit a moving boat (GBU-31 / GBU-39 can't: #65's c08 trap)
  allowedLoadouts: ['strike_sdb2_full', 'strike_sdb2'],
  player: g02Start,
  // eight boats, eight bombs at most: the gun is part of the plan (#77)
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
      // the short clock: three suicide boats down the Gulf, about 2 minutes from her
      target('sb1', S.suicide, 'suicide_boat', { x: 4900, z: -10600 }, chase),
      target('sb2', S.suicide, 'suicide_boat', { x: 5300, z: -10750 }, chase),
      target('sb3', S.suicide, 'suicide_boat', { x: 4500, z: -10800 }, chase),
      // Veteran up: a fourth one (seven boats to sink, eight bombs)
      target('sb4', S.suicide, 'suicide_boat', { x: 5700, z: -10950 }, { ...chase, minDifficulty: 'veteran' }),
      // the long clock: three missile boats further out, in launch range 3–4 minutes in
      target('mb1', S.missile, 'missile_boat', { x: 7650, z: -18450 }, strike),
      target('mb2', S.missile, 'missile_boat', { x: 9000, z: -17900 }, strike),
      target('mb3', S.missile, 'missile_boat', { x: 6400, z: -19000 }, strike),
      // Ace: a fourth one (eight boats to sink with eight bombs: the gun, or a ram she survives)
      target('mb4', S.missile, 'missile_boat', { x: 10300, z: -17300 }, { ...strike, minDifficulty: 'ace' }),
    ],
    sams: [
      // air-defence boats: one rides with each wave
      site('ad1', S.ad, 'ad_boat', { x: 4900, z: -11300 }, { escort: S.suicide }),
      site('ad2', S.ad, 'ad_boat', { x: 7700, z: -19200 }, { escort: S.missile }),
    ],
    objectives: [
      { id: 'o_tanker', kind: 'protect', group: G02_TANKER.group, label: `Protect the ${G02_TANKER.name} (two hits sink her)`, primary: true },
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
        id: 't_suicide_dead',
        when: { kind: 'group_destroyed', group: S.suicide },
        delay: 2,
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Suicide boats are all down. Missile boats still closing from the north: get them before they launch.' }],
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
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Eight IRGC fast boats in the Gulf, heading for the tanker. Suicide boats lead, missile boats behind, two air-defence boats with them. Weapons free on the boats.', priority: 2 },
    ],
    successText: 'The Gulf is clear and the Kōtuku Star is on her way to Singapore. Good hunting, Viper.',
  },
});
