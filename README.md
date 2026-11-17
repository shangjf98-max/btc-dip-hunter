![bounty](https://make.fun/badge/btc-race-24h-20261117-0603.svg)
![rank](https://make.fun/badge/btc-race-24h-20261117-0603/shangjf98-max/btc-dip-hunter/rank.svg)
![reward](https://make.fun/badge/btc-race-24h-20261117-0603/shangjf98-max/btc-dip-hunter/reward.svg)

# Dip Hunter — a patient cbBTC trading bot

An entry for [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261117-0603) on [make.fun](https://make.fun/).

## Idea

A full-size round trip in this race costs roughly 35 bps (4 bps fee + 2 bps
slippage per fill, plus constant-product impact against ~$0.9M of pool depth).
Most active rules cannot earn that back on 1-minute noise, so Dip Hunter
trades rarely and only for moves large enough to pay the toll:

- **Dip entry.** Once 60 bars of history exist, if the latest close is at
  least 110 bps below the highest high of the last 61 bars, it spends all
  cash on one buy. A second entry, after a winning exit, needs a deeper dip
  of 200 bps. At most two entries per window, with a 30-bar cooldown after
  any exit.
- **Participation fallback.** If no dip ever fires, it buys on the first
  60-bar breakout at or after bar 720, and unconditionally at bar 1200, so a
  steadily rising day never ends flat.
- **Exits.** A 75 bps trailing stop off the highest high since entry, armed
  only once the peak sits 40 bps above cost basis, locks in spikes without
  chopping positions that never got going; a 400 bps stop off cost basis
  caps a disaster. After an exit that loses money it stops trading for the
  window — the day's regime is hostile.
- **No late entries.** Nothing new at or after bar 1410; a fill there leaves
  no time to earn its cost before the end-of-window flatten.

All decisions are integer math on the wire's raw units: cross-multiplied
basis points, no floats, no clock, no randomness. Two runs agree byte for
byte.

## Development-window result

Graded locally with the bounty kit (`grade-local --driver process`) on the
1440-bar development window (2026-11-16 06:04 UTC → 2026-11-17 06:03 UTC):

- **Net PnL: +$21.75** on $1,000 paper capital (after all fees)
- Trades: 4 (two dip buys, each exited on the armed trailing stop)
- Max drawdown: 1.10% (limit 25%)
- Determinism: reproduced, action logs identical across runs

For reference, the kit's buy-and-hold baseline nets +$1.07 on the same
window and its momentum baseline +$2.45.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only
  apart from the vendored shim below)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  `agent-fun/bars-replay/v1` shim

## Run it

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
