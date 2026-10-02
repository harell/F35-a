/**
 * MISSIONS — pacing: "dead stretches" in the bot's event log (runPlaythrough(..., { log: true })).
 *
 * A dead stretch is a span of mission time with nothing for the player to hear or see happen: no
 * radio call, no HUD message, no launch (anyone's), no kill and no objective change (#59). The
 * stretch runs from the mission start to the first such event, between two of them, and from the
 * last one to the end of the run, so a silent opening and a silent tail both count.
 *
 * The log's state lines (RED / BLUE / MSL / BOT, every 5 s) are the bot's own diagnostics, not
 * something the player gets, so they never break a stretch. Log times are whole seconds.
 *
 * Used by tools/playtest/bot-sweep.ts (--log prints each run's longest stretch) and by
 * tests/missions-pacing.test.ts.
 */

/** Event-log kinds that count as "something happening" for pacing. */
export const PACING_KINDS: readonly string[] = ['RADIO', 'HUD', 'LAUNCH', 'DESTROYED', 'OBJ'];

/** Longest silence a mission may have (s): the bar from the playtest that filed #59. */
export const MAX_DEAD_STRETCH = 90;

export interface DeadStretch {
  /** Mission time the silence starts (s): the event before it, or 0. */
  from: number;
  /** Mission time it ends (s): the next event, or the end of the run. */
  to: number;
  /** to − from (s). */
  length: number;
}

/** Times (s) of the pacing events in a bot event log, in log order. */
export function pacingEventTimes(events: readonly string[]): number[] {
  const out: number[] = [];
  for (const line of events) {
    const m = /^\s*(\d+(?:\.\d+)?) (\S+)/.exec(line);
    if (m && PACING_KINDS.includes(m[2])) out.push(Number(m[1]));
  }
  return out;
}

/**
 * Every gap between pacing events in a bot event log, from t = 0 to `endT` (the run's end, s),
 * longest first. Zero-length gaps (several events in the same second) are left out.
 */
export function deadStretches(events: readonly string[], endT: number): DeadStretch[] {
  const out: DeadStretch[] = [];
  let prev = 0;
  for (const t of [...pacingEventTimes(events), endT]) {
    if (t > prev) out.push({ from: prev, to: t, length: t - prev });
    prev = Math.max(prev, t);
  }
  return out.sort((a, b) => b.length - a.length || a.from - b.from);
}

/** The longest dead stretch of a run (length 0 for an empty run). */
export function longestDeadStretch(events: readonly string[], endT: number): DeadStretch {
  return deadStretches(events, endT)[0] ?? { from: 0, to: 0, length: 0 };
}

/** "112 s (143–255)" for logs and test messages. */
export function deadStretchText(d: DeadStretch): string {
  return `${Math.round(d.length)} s (${Math.round(d.from)}–${Math.round(d.to)})`;
}
