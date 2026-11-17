// Dip Hunter: a patient single-asset cbBTC bot for the 24-hour bars race.
//
// The race charges roughly 35 bps for a full-size round trip (4 bps fee + 2 bps
// slippage per fill, plus constant-product impact against ~$0.9M of pool depth),
// so the bot trades rarely and only for moves large enough to pay that toll.
// Its whole playbook is one idea: buy a sharp pullback, then sit on it.
//
//   - Dip entry: once 60 bars of history exist, if the latest close is at least
//     110 bps below the highest high of the last 61 bars (the 60 before it plus
//     its own), spend all cash on one full-size buy. A second entry, after a
//     winning exit, needs a deeper dip of 200 bps: buying the bounce after an
//     exit is how give-back turns into a loss. At most two entries per window,
//     with a 30-bar cooldown after any exit.
//   - Participation fallback: if no dip ever fires, buy on the first 60-bar
//     breakout at or after bar 720 (a steadily rising day has no dips to buy),
//     and buy unconditionally at bar 1200 so the window never ends flat.
//   - Exits: a trailing stop of 75 bps off the highest HIGH since entry, but
//     armed only once the peak sits 40 bps above cost basis, so the trail
//     locks in real spikes instead of chopping a position that never got
//     going; a 400 bps stop off cost basis caps a disaster. Tracking highs
//     rather than closes lets the trail react to a spike's top within the
//     bar that prints it, instead of waiting for a weak close to confirm
//     the give-back. After an exit that loses money the bot stops trading:
//     the day's regime is hostile and a second dip is likely another
//     falling knife.
//   - No entries after bar 1410: a fill there leaves no time to earn its cost
//     before the end-of-window flatten.
//
// Everything is integer math on the wire's raw units (cross-multiplied basis
// points, no floats, no clock, no randomness), so two runs agree byte for
// byte. History is counted in recorded bars, so gap minutes neither confuse
// the lookbacks nor the cutoffs.

import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

/** Bars of history behind the dip and breakout signals. */
const LOOKBACK_BARS = 60;
/** A close this far below the recent high counts as a dip worth buying. */
const DIP_BPS = 110n;
/** The deeper dip a second entry (after a winning exit) must wait for. */
const DIP2_BPS = 200n;
/** Give-back allowed from the highest high since entry before selling. */
const TRAIL_BPS = 75n;
/** The trail arms only once the peak is this far above cost basis. */
const ARM_BPS = 40n;
/** Loss from cost basis that forces an exit, whatever the trail says. */
const STOP_BPS = 400n;
/** Bars to wait after an exit before the next entry may fire. */
const COOLDOWN_BARS = 30;
/** Entries per window: one dip, plus one second chance after a winning exit. */
const MAX_ENTRIES = 2;
/** First bar the breakout fallback may fire on. */
const BREAKOUT_BAR = 720;
/** Bar the unconditional fallback fires on if nothing has traded yet. */
const LAST_RESORT_BAR = 1200;
/** No new entries at or after this bar: too close to the flatten. */
const ENTRY_CUTOFF_BAR = 1410;
/** Fills are bounded against the latest close; 1-minute gaps run far below this. */
const MAX_SLIPPAGE_BPS = 100;

/** The traded symbol, taken from hello (the universe holds one asset). */
let symbol = '';
/** Recorded bars so far; the index every cutoff and cooldown is measured in. */
let barsSeen = 0;
/** Closes and highs of the most recent recorded bars, oldest first. */
const closes: bigint[] = [];
const highs: bigint[] = [];
/** Entries whose fills have been observed in the account. */
let entries = 0;
/** Set once an exit loses money: no further entries for the rest of the window. */
let blocked = false;
/** Whether the exit most recently decided on would lose money at this close. */
let exitWasLosing = false;
/** Recorded-bar index before which no entry may fire (cooldown after an exit). */
let coolUntil = -1;
/** Batch seq until which a sent buy is awaited before it may be re-decided. */
let pendingBuyUntil = -1;
/** Highest high since the current position opened (null while flat). */
let peak: bigint | null = null;
/** The high on the bar the current position's buy was decided on. */
let entrySignalHigh = 0n;
/** Whether a position was held on the previous batch (for entry detection). */
let wasHolding = false;

function buyAll(state: BarsState): OrderInput[] {
  const { caps, fees } = state.hello;
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
  const slice = state.cash < byWeight ? state.cash : byWeight;
  if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
  return [{ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onHello(state) {
    symbol = state.hello.symbols[0]?.symbol ?? '';
  },
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === symbol);
    const held = state.positions.get(symbol);
    // A zero-quantity position (never sent by the real engine, but cheap to
    // guard) counts as flat: selling it would be a zero-amount order.
    const holding = held !== undefined && held.qty > 0n;

    // A fill observed: count the entry, and seed the trailing peak with the
    // high of the bar the buy was decided on (the dip bar's high); the
    // holding branch below folds in each new bar's high from here on.
    if (holding && !wasHolding) {
      entries += 1;
      pendingBuyUntil = -1;
      peak = entrySignalHigh;
    }
    // A position gone means the decided exit actually filled: only now does
    // a losing exit block further entries. (A rejected sell leaves the
    // position held, so a decision-time block would wrongly ban re-entry
    // after the price recovered and a later exit won.)
    if (!holding && wasHolding && exitWasLosing) blocked = true;
    if (!holding) peak = null;
    wasHolding = holding;

    // Gap minute for our symbol: no new price, nothing to decide.
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const high = BigInt(bar.h);
    // The recorded-bar index of this bar (0-based), the clock every cutoff uses.
    const idx = barsSeen;

    if (!state.warmingUp && holding && held !== undefined) {
      // Peak tracks highs: fold this bar's high in first, so a fresh spike
      // top raises the trail before the close is judged against it.
      if (peak !== null && high > peak) peak = high;
      const value = state.value(symbol, held.qty, close);
      const stopped = value * BPS < held.cost * (BPS - STOP_BPS);
      // The trail arms only once the peak value clears cost basis by ARM_BPS:
      // an unarmed trail would sell a dip that merely wobbled sideways.
      const peakValue = peak === null ? 0n : state.value(symbol, held.qty, peak);
      const armed = peakValue * BPS >= held.cost * (BPS + ARM_BPS);
      const trailed = armed && peak !== null && close * BPS < peak * (BPS - TRAIL_BPS);
      if (stopped || trailed) {
        exitWasLosing = value < held.cost;
        coolUntil = idx + COOLDOWN_BARS;
        // Record this bar before leaving: the exit bar is history too, and
        // every later cutoff and lookback counts recorded bars.
        closes.push(close);
        highs.push(high);
        barsSeen += 1;
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }

    if (!state.warmingUp && !holding && !blocked && entries < MAX_ENTRIES && idx < ENTRY_CUTOFF_BAR) {
      const awaitingFill = state.seq <= pendingBuyUntil;
      if (!awaitingFill && idx >= coolUntil) {
        let buy = false;
        if (idx >= LOOKBACK_BARS) {
          // Dip: this close DIP_BPS (first entry) or DIP2_BPS (second entry)
          // under the highest high of the last 61 bars.
          const dipBps = entries === 0 ? DIP_BPS : DIP2_BPS;
          let windowHigh = high;
          for (let i = Math.max(0, highs.length - LOOKBACK_BARS); i < highs.length; i++) {
            if (highs[i]! > windowHigh) windowHigh = highs[i]!;
          }
          if (close * BPS < windowHigh * (BPS - dipBps)) buy = true;
        }
        if (!buy && entries === 0) {
          // Fallbacks, only while nothing has traded yet.
          if (idx >= LAST_RESORT_BAR) {
            buy = true;
          } else if (idx >= BREAKOUT_BAR && idx >= LOOKBACK_BARS) {
            let priorHigh = closes[closes.length - LOOKBACK_BARS]!;
            for (let i = closes.length - LOOKBACK_BARS + 1; i < closes.length; i++) {
              if (closes[i]! > priorHigh) priorHigh = closes[i]!;
            }
            if (close > priorHigh) buy = true;
          }
        }
        if (buy) {
          const orders = buyAll(state);
          if (orders.length > 0) {
            entrySignalHigh = high;
            pendingBuyUntil = state.seq + 2;
            closes.push(close);
            highs.push(high);
            barsSeen += 1;
            return orders;
          }
        }
      }
    }

    closes.push(close);
    highs.push(high);
    barsSeen += 1;
    // History beyond the lookback is dead weight; keep a small margin for the
    // breakout scan. Trimming keeps the arrays short without changing signals.
    if (closes.length > LOOKBACK_BARS + 5) {
      closes.splice(0, closes.length - (LOOKBACK_BARS + 5));
      highs.splice(0, highs.length - (LOOKBACK_BARS + 5));
    }
    return [];
  },
});
