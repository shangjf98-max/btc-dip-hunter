// Dip Hunter: a patient single-asset cbBTC bot for the 24-hour bars race.
//
// The race charges roughly 35 bps for a full-size round trip (4 bps fee + 2 bps
// slippage per fill, plus constant-product impact against ~$0.9M of pool depth),
// so the bot trades rarely and only for moves large enough to pay that toll.
// Its whole playbook is one idea: buy a sharp pullback, then sit on it.
//
//   - Dip entry: once 60 bars of history exist, if the latest close is at least
//     120 bps below the highest high of the last 61 bars (the 60 before it plus
//     its own), spend all cash on one full-size buy. At most two entries per
//     window, with a 30-bar cooldown after any exit.
//   - Participation fallback: if no dip ever fires, buy on the first 60-bar
//     breakout at or after bar 720 (a steadily rising day has no dips to buy),
//     and buy unconditionally at bar 1200 so the window never ends flat.
//   - Exits: a 250 bps trailing stop off the highest close since entry locks in
//     a spike without chopping through normal pullbacks, and a 400 bps stop
//     off cost basis caps a disaster. After an exit that loses money the bot
//     stops trading: the day's regime is hostile and a second dip is likely
//     another falling knife.
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
const DIP_BPS = 120n;
/** Give-back allowed from the highest close since entry before selling. */
const TRAIL_BPS = 250n;
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
/** Recorded-bar index before which no entry may fire (cooldown after an exit). */
let coolUntil = -1;
/** Batch seq until which a sent buy is awaited before it may be re-decided. */
let pendingBuyUntil = -1;
/** Highest close since the current position opened (null while flat). */
let peak: bigint | null = null;
/** The close on the bar the current position's buy was decided on. */
let entrySignalClose = 0n;
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
    const holding = held !== undefined;

    // A fill observed: count the entry, and seed the trailing peak with the
    // close the buy was decided on (the dip bar) as well as today's close.
    if (holding && !wasHolding) {
      entries += 1;
      pendingBuyUntil = -1;
      const close = state.close(symbol);
      peak = close === null ? entrySignalClose : close > entrySignalClose ? close : entrySignalClose;
    }
    if (!holding) peak = null;
    wasHolding = holding;

    // Gap minute for our symbol: no new price, nothing to decide.
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const high = BigInt(bar.h);
    // The recorded-bar index of this bar (0-based), the clock every cutoff uses.
    const idx = barsSeen;

    if (!state.warmingUp && holding && held !== undefined) {
      // Trail first: the peak includes this close, so a fresh high never exits.
      if (peak !== null && close > peak) peak = close;
      const value = state.value(symbol, held.qty, close);
      const stopped = value * BPS < held.cost * (BPS - STOP_BPS);
      const trailed = peak !== null && close * BPS < peak * (BPS - TRAIL_BPS);
      if (stopped || trailed) {
        if (value < held.cost) blocked = true;
        coolUntil = idx + COOLDOWN_BARS;
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }

    if (!state.warmingUp && !holding && !blocked && entries < MAX_ENTRIES && idx < ENTRY_CUTOFF_BAR) {
      const awaitingFill = state.seq <= pendingBuyUntil;
      if (!awaitingFill && idx >= coolUntil) {
        let buy = false;
        if (idx >= LOOKBACK_BARS) {
          // Dip: this close 120+ bps under the highest high of the last 61 bars.
          let windowHigh = high;
          for (let i = Math.max(0, highs.length - LOOKBACK_BARS); i < highs.length; i++) {
            if (highs[i]! > windowHigh) windowHigh = highs[i]!;
          }
          if (close * BPS < windowHigh * (BPS - DIP_BPS)) buy = true;
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
            entrySignalClose = close;
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
