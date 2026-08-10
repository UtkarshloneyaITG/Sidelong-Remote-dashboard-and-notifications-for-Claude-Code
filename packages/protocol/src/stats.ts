/**
 * The Analysis panel's arithmetic.
 *
 * Pure, and here rather than in the renderer for one reason: this is the only
 * number in the product that is DERIVED rather than tallied, it is the one most
 * likely to be quoted at somebody, and it had a real bug that only a test would
 * have caught. Everything in this file is a function of its arguments.
 */

/** One local day of counts. Every field is a tally of events that arrived. */
export interface DayCounts {
  prompts: number;
  /** Prompts answered with Allow/Deny on the bar. */
  answered: number;
  answeredMs: number;
  /** Prompts that cleared without the bar being touched. */
  elsewhere: number;
  elsewhereMs: number;
  /**
   * Time saved, banked once per answered prompt at the moment it resolved.
   *
   * Deliberately NOT recomputable from the fields above: the credit for a prompt
   * uses the baseline as it stood when that prompt resolved, and later data must
   * not change it. See `savings` for why.
   */
  savedMs: number;
  tools: number;
  turns: number;
  sessions: number;
}

/**
 * Below this many samples in EITHER group, no figure is shown at all.
 *
 * A difference of means from one sample each is noise with a decimal point.
 */
export const MIN_SAMPLES = 3;

export interface Savings {
  /** Mean saved per prompt answered on the bar, over the range. */
  perPrompt: number;
  /** Sum of what was banked. Never a mean re-multiplied by a count. */
  total: number;
  answered: number;
  elsewhere: number;
}

/**
 * Sum the banked savings over a range.
 *
 * The bug this shape exists to prevent: the figure used to be computed as
 * `(mean elsewhere - mean bar) x answered`, recomputed from scratch every
 * render. Both means move as new prompts arrive, so answering one slow prompt
 * today lowered the total attributed to last Tuesday, and the number on screen
 * went DOWN. Time already saved cannot be un-saved.
 *
 * Now each prompt is credited once, when it resolves, against the baseline then
 * available, and that credit is never revisited. For a FIXED set of days this
 * function is monotonic: adding prompts can only add.
 *
 * Returns null rather than zero when either group is too thin, or when nothing
 * has been banked -- the panel then says why instead of showing a confident 0.
 */
export function savings(rows: readonly DayCounts[]): Savings | null {
  let answered = 0;
  let elsewhere = 0;
  let savedMs = 0;
  for (const c of rows) {
    answered += c.answered;
    elsewhere += c.elsewhere;
    savedMs += c.savedMs;
  }
  if (answered < MIN_SAMPLES || elsewhere < MIN_SAMPLES) return null;
  if (savedMs <= 0) return null;
  return { perPrompt: savedMs / answered, total: savedMs, answered, elsewhere };
}

/**
 * The same range again, immediately before it, so a total can be compared with
 * something. Null unless the whole previous window is present and non-zero: a
 * percentage against nothing is a division by zero wearing a percent sign.
 */
export function trend(
  all: readonly { blockedMs: number }[],
  range: number,
): { delta: number; prev: number } | null {
  if (all.length < range * 2) return null;
  const sum = (rows: readonly { blockedMs: number }[]): number =>
    rows.reduce((a, d) => a + d.blockedMs, 0);
  const prev = sum(all.slice(-range * 2, -range));
  if (prev <= 0) return null;
  return { delta: (sum(all.slice(-range)) - prev) / prev, prev };
}
