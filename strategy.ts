// Second-Wind Dip-Recovery Bot v8-local (Strict Creator).
//
// Idea: never chase a freshly created coin. Only buy a coin that has already
// proven it can run (price once reached 5x its creation price) and is now
// dipping 15-25% off its peak while buyers are coming back. The creator may
// take a little profit, but once the creator has sold 0.2 SOL in total the
// coin is vetoed for good. v8 tightens v6 in exactly two numbers: the creator
// veto drops from 0.5 to 0.2 SOL and each coin may only ever be entered once.
//
// Deterministic by construction: every decision comes only from the batch the
// harness hands over plus this file's own state. No clock, no random, no env,
// no IO inside the strategy.

import type { Batch, BotState, Fill, OrderInput } from "./vendor/makefun-bot.ts";

export interface Params {
  minRunup: number;
  minPeakRealSol: number;
  firstSol: number;
  addSol: number;
  maxPositionSol: number;
  maxExposureSol: number;
  tp1: number;
  tp2: number;
  trail: number;
  stopLoss: number;
  maxHold: number;
  minAge: number;
  flowWindow: number;
  minFlowSol: number;
  minFlowBuyers: number;
  lastMustBeBuy: boolean;
  maxBuyerShare: number;
  minRealSol: number;
  addStep: number;
  minBuySol: number;
  buySlipBps: number;
  fadeWindow: number;
  fadeNetSol: number;
  holdIfUp: number;
  cooldown: number;
  maxEntries: number;
  maxMain: number;
  creatorSellVetoSol: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  dipMin: number;
  dipMax: number;
}

export const DEFAULT_PARAMS: Params = {
  minRunup: 5.0,
  minPeakRealSol: 8,
  firstSol: 0.1,
  addSol: 0.2,
  maxPositionSol: 0.6,
  maxExposureSol: 5.0,
  tp1: 0.2,
  tp2: 1.0,
  trail: 0.15,
  stopLoss: 0.15,
  maxHold: 1200,
  minAge: 200,
  flowWindow: 20,
  minFlowSol: 0.02,
  minFlowBuyers: 3,
  lastMustBeBuy: true,
  maxBuyerShare: 0.5,
  minRealSol: 3,
  addStep: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  fadeWindow: 15,
  fadeNetSol: 0.05,
  holdIfUp: 0.2,
  cooldown: 150,
  maxEntries: 1,
  maxMain: 5,
  creatorSellVetoSol: 0.2,
  targetCoins: 22,
  targetFills: 100,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
  dipMin: 0.75,
  dipMax: 0.85,
};

const LAMPORTS = 1_000_000_000n;
const TX_FEE = 105_000n;
const FEE_BPS = 125n;

interface TradeNote {
  slot: number;
  isBuy: boolean;
  sol: number;
  user: string;
}

interface CoinBook {
  born: number;
  creator: string;
  startPx: number;
  topPx: number;
  topRq: number;
  makerSold: number;
  trades: TradeNote[];
  entries: number;
  lastExitSlot: number | null;
  openSlot: number | null;
  entryPx: number;
  tp1Done: boolean;
  addDone: boolean;
  best: bigint;
  isProbe: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function solOf(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

// Net value of holding `tokens` on `curve` right now: the quote the curve
// would pay for them, less the 1.25% curve fees and one tx fee.
function netValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const afterFees = gross - (gross * FEE_BPS) / 10_000n;
  const net = afterFees - TX_FEE;
  return net > 0n ? net : 0n;
}

function flowStats(book: CoinBook, slot: number, window: number): {
  buys: number;
  buyers: Set<string>;
  net: number;
  buySol: number;
  lastIsBuy: boolean;
  maxShare: number;
} {
  const from = slot - window;
  const buyers = new Set<string>();
  const perBuyer = new Map<string, number>();
  let buys = 0;
  let net = 0;
  let buySol = 0;
  let lastIsBuy = false;
  let seen = false;
  for (const t of book.trades) {
    if (t.slot <= from) continue;
    seen = true;
    lastIsBuy = t.isBuy;
    if (t.isBuy) {
      buys += 1;
      buySol += t.sol;
      net += t.sol;
      buyers.add(t.user);
      perBuyer.set(t.user, (perBuyer.get(t.user) ?? 0) + t.sol);
    } else {
      net -= t.sol;
    }
  }
  let maxShare = 0;
  for (const v of perBuyer.values()) {
    if (buySol > 0 && v / buySol > maxShare) maxShare = v / buySol;
  }
  void seen;
  return { buys, buyers, net, buySol, lastIsBuy, maxShare };
}

export function createStrategy(p: Params) {
  const books = new Map<string, CoinBook>();
  const everFilled = new Set<string>();
  const probeBuys = new Map<string, string>();
  const probeSells = new Set<string>();
  let fillCount = 0;
  let orderNo = 0;
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  let lastSeenSlot = -1;

  const nextId = (tag: string): string => {
    orderNo += 1;
    return `${tag}${orderNo}`;
  };

  function bookFor(mint: string): CoinBook {
    let b = books.get(mint);
    if (b === undefined) {
      b = {
        born: -1,
        creator: "",
        startPx: 0,
        topPx: 0,
        topRq: 0,
        makerSold: 0,
        trades: [],
        entries: 0,
        lastExitSlot: null,
        openSlot: null,
        entryPx: 0,
        tp1Done: false,
        addDone: false,
        best: 0n,
        isProbe: false,
      };
      books.set(mint, b);
    }
    return b;
  }

  function noteEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        lastBlockTime = e.block_time;
      }
      if (e.event === "CreateEvent") {
        const b = bookFor(e.mint);
        b.born = e.slot;
        b.creator = e.creator;
        b.startPx = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        b.topPx = b.startPx;
        b.topRq = 0;
      } else if (e.event === "TradeEvent") {
        const b = bookFor(e.mint);
        if (b.born < 0) b.born = e.slot;
        if (b.creator === "") b.creator = e.creator;
        if (b.startPx === 0) {
          b.startPx = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          b.topPx = b.startPx;
        }
        const px = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (px > b.topPx) b.topPx = px;
        const rq = solOf(BigInt(e.real_quote_reserves));
        if (rq > b.topRq) b.topRq = rq;
        const sol = solOf(BigInt(e.sol_amount));
        if (!e.is_buy && e.user === b.creator) b.makerSold += sol;
        b.trades.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const horizon = Math.max(p.flowWindow, p.fadeWindow) + 40;
        while (b.trades.length > 0 && b.trades[0]!.slot <= e.slot - horizon) b.trades.shift();
      }
    }
  }

  // Fold this batch's fills into the books. The fill counter counts every
  // filled order, buys and sells alike (probe pacing rule 2). A TP1 half
  // sell resets `best` to the value still held, and only when its fill
  // arrives -- never when the order is sent (rule 4).
  function noteFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      if (f.status === "filled") {
        fillCount += 1;
        everFilled.add(f.mint);
      }
      const b = bookFor(f.mint);
      const probeMint = probeBuys.get(f.client_id);
      if (f.status === "filled" && f.side === "buy" && probeMint !== undefined) {
        probeBuys.delete(f.client_id);
        b.isProbe = true;
        b.openSlot = batch.slot;
        const curve = state.curves.get(f.mint);
        if (curve !== undefined) b.entryPx = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        continue;
      }
      if (f.status === "filled" && f.side === "buy") {
        const heldBefore = state.positions.get(f.mint);
        const wasOpen = b.openSlot !== null && heldBefore !== undefined;
        if (!wasOpen) {
          // Opening buy of a main position: one lifetime entry (rule 1).
          b.entries += 1;
          b.openSlot = batch.slot;
          b.tp1Done = false;
          b.addDone = false;
          b.isProbe = false;
          const curve = state.curves.get(f.mint);
          if (curve !== undefined) {
            b.entryPx = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
            const pos = state.positions.get(f.mint);
            if (pos !== undefined) b.best = netValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
          }
        }
        continue;
      }
      if (f.status === "filled" && f.side === "sell") {
        const wasProbeSell = probeSells.has(f.client_id);
        if (wasProbeSell) probeSells.delete(f.client_id);
        const pos = state.positions.get(f.mint);
        const curve = state.curves.get(f.mint);
        if (pos !== undefined && curve !== undefined) {
          // Partial sell (TP1): reset the trailing peak to what is left.
          const left = netValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
          b.best = left;
          b.tp1Done = true;
        } else {
          // Position fully gone.
          if (wasProbeSell || b.isProbe) {
            b.isProbe = false;
            b.openSlot = null;
            b.best = 0n;
          } else {
            b.lastExitSlot = batch.slot;
            b.openSlot = null;
            b.tp1Done = false;
            b.addDone = false;
            b.best = 0n;
          }
        }
        continue;
      }
      // Rejected / failed probe buy: the probe is no longer in flight.
      if (probeMint !== undefined) probeBuys.delete(f.client_id);
      if (probeSells.has(f.client_id)) probeSells.delete(f.client_id);
    }
    // A position the harness flattened (complete / end) without a fill we
    // tracked still closes the book.
    for (const [mint, b] of books) {
      if (b.openSlot !== null && !state.positions.has(mint)) {
        let pending = false;
        for (const pend of state.pending.values()) {
          if (pend.order.mint === mint) {
            pending = true;
            break;
          }
        }
        if (!pending) {
          if (!b.isProbe) b.lastExitSlot = batch.slot;
          b.isProbe = false;
          b.openSlot = null;
          b.tp1Done = false;
          b.addDone = false;
          b.best = 0n;
        }
      }
    }
  }

  function pendingSell(state: BotState, mint: string): boolean {
    for (const pend of state.pending.values()) {
      if (pend.order.mint === mint && pend.order.side === "sell") return true;
    }
    return false;
  }

  function pendingAny(state: BotState, mint: string): boolean {
    for (const pend of state.pending.values()) {
      if (pend.order.mint === mint) return true;
    }
    return false;
  }

  function investedSol(state: BotState): number {
    let total = 0;
    for (const pos of state.positions.values()) total += solOf(pos.cost_lamports);
    return total;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    lastSeenSlot = batch.slot;
    noteEvents(batch);
    noteFills(state, batch);
    const orders: OrderInput[] = [];
    const soldThisBatch = new Set<string>();
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const push = (o: OrderInput): boolean => {
      if (orders.length >= maxOrders) return false;
      orders.push(o);
      return true;
    };

    // ---- Exits first, before any new entry in the same batch. ----
    for (const [mint, pos] of state.positions) {
      if (pos.token_amount <= 0n) continue;
      // Rule 5: one sell per mint per batch, and never while a sell is pending.
      if (soldThisBatch.has(mint) || pendingSell(state, mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const b = books.get(mint);
      if (b === undefined) continue;
      const value = netValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const cost = pos.cost_lamports;

      // A filled probe is sold in full as soon as its buy lands.
      if (b.isProbe) {
        const id = nextId("s");
        probeSells.add(id);
        if (push({ side: "sell", client_id: id, mint, token_amount: pos.token_amount, max_slippage_bps: 10000 })) soldThisBatch.add(mint);
        continue;
      }

      const fade = flowStats(b, batch.slot, p.fadeWindow);
      const age = b.openSlot !== null ? batch.slot - b.openSlot : 0;
      const holdLimit = value >= (cost * BigInt(Math.round((1 + p.holdIfUp) * 1000))) / 1000n ? p.maxHold * 2 : p.maxHold;
      const exitAll =
        b.makerSold >= p.creatorSellVetoSol ||
        value < (cost * BigInt(Math.round((1 - p.stopLoss) * 1000))) / 1000n ||
        (b.tp1Done && b.best > 0n && value < (b.best * BigInt(Math.round((1 - p.trail) * 1000))) / 1000n) ||
        (b.tp1Done && value >= (cost * BigInt(Math.round((1 + p.tp2) * 1000))) / 1000n) ||
        fade.net < -p.fadeNetSol ||
        age > holdLimit;
      if (exitAll) {
        const id = nextId("s");
        if (push({ side: "sell", client_id: id, mint, token_amount: pos.token_amount, max_slippage_bps: 10000 })) soldThisBatch.add(mint);
        continue;
      }
      if (!b.tp1Done && value >= (cost * BigInt(Math.round((1 + p.tp1) * 1000))) / 1000n) {
        const half = pos.token_amount / 2n;
        if (half > 0n) {
          const id = nextId("s");
          if (push({ side: "sell", client_id: id, mint, token_amount: half, max_slippage_bps: 10000 })) soldThisBatch.add(mint);
        }
        continue;
      }
      if (value > b.best) b.best = value;
    }

    // ---- Adds on open main positions (at most one add per position). ----
    for (const [mint, pos] of state.positions) {
      if (pos.token_amount <= 0n) continue;
      const b = books.get(mint);
      if (b === undefined || b.isProbe || b.addDone) continue;
      if (pendingAny(state, mint) || soldThisBatch.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const invested = solOf(pos.cost_lamports);
      if (invested >= p.maxPositionSol - p.minBuySol) continue;
      const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (b.entryPx <= 0 || px < b.entryPx * (1 + p.addStep)) continue;
      const flow = flowStats(b, batch.slot, p.flowWindow);
      if (flow.net < p.minFlowSol) continue;
      if (solOf(curve.real_quote_reserves) < p.minRealSol) continue;
      let sizeSol = Math.min(p.addSol, p.maxPositionSol - invested);
      const capLamports = state.maxBuyLamports(mint);
      const free = state.freeCashLamports();
      const room = Math.min(solOf(capLamports), solOf(free > 0n ? free : 0n), p.maxExposureSol - investedSol(state));
      sizeSol = Math.min(sizeSol, room);
      if (sizeSol < p.minBuySol) continue;
      const lamports = BigInt(Math.floor(sizeSol * 1e9));
      if (lamports <= 0n) continue;
      const id = nextId("b");
      if (push({ side: "buy", client_id: id, mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps })) b.addDone = true;
    }

    // ---- New main entries. ----
    for (const [mint, curve] of state.curves) {
      if (orders.length >= maxOrders) break;
      if (curve.complete) continue;
      if (state.positions.has(mint) || pendingAny(state, mint)) continue;
      if (state.committedPositionCount() + orders.filter((o) => o.side === "buy").length >= p.maxMain) break;
      const b = books.get(mint);
      if (b === undefined || b.born < 0 || b.startPx <= 0) continue;
      if (b.entries >= p.maxEntries) continue;
      if (b.lastExitSlot !== null && batch.slot - b.lastExitSlot < p.cooldown) continue;
      if (b.makerSold >= p.creatorSellVetoSol) continue;
      if (batch.slot - b.born < p.minAge) continue;
      if (b.topPx < p.minRunup * b.startPx) continue;
      if (b.topRq < p.minPeakRealSol) continue;
      const realSol = solOf(curve.real_quote_reserves);
      if (realSol < p.minRealSol) continue;
      const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (b.topPx <= 0) continue;
      const dip = px / b.topPx;
      if (dip < p.dipMin || dip > p.dipMax) continue;
      const flow = flowStats(b, batch.slot, p.flowWindow);
      if (flow.buys < p.minFlowBuyers) continue;
      if (flow.buyers.size < p.minFlowBuyers) continue;
      if (flow.net < p.minFlowSol) continue;
      if (p.lastMustBeBuy && !flow.lastIsBuy) continue;
      if (flow.maxShare > p.maxBuyerShare) continue;
      let sizeSol = p.firstSol;
      const capLamports = state.maxBuyLamports(mint);
      const free = state.freeCashLamports();
      let room = Math.min(solOf(capLamports), solOf(free > 0n ? free : 0n), p.maxExposureSol - investedSol(state));
      // Orders already queued this batch also spend cash.
      for (const o of orders) if (o.side === "buy") room -= solOf(BigInt(o.quote_lamports));
      sizeSol = Math.min(sizeSol, room);
      if (sizeSol < p.minBuySol) continue;
      const lamports = BigInt(Math.floor(sizeSol * 1e9));
      if (lamports <= 0n) continue;
      push({ side: "buy", client_id: nextId("b"), mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
    }

    // ---- Probe to keep pace with the guardrails. ----
    // Rule 3: a probe may revisit a coin it already probed; only a coin with
    // a probe still in flight is off limits, and only when coins are short
    // must the coin be one that never filled.
    if (probeBuys.size < p.maxProbes && firstBlockTime !== null && lastBlockTime !== null) {
      const elapsed = lastBlockTime - firstBlockTime;
      const progress = Math.min(1, elapsed / p.paceSecs);
      const needCoins = everFilled.size < Math.ceil(p.targetCoins * progress);
      const needFills = fillCount < Math.ceil(p.targetFills * progress);
      if ((needCoins || needFills) && state.committedPositionCount() < p.maxMain) {
        const threshold = (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
        let pick: string | null = null;
        // Most recently traded coin first.
        const recent: string[] = [];
        for (let i = batch.events.length - 1; i >= 0; i--) {
          const e = batch.events[i]!;
          if (e.event === "TradeEvent" && !recent.includes(e.mint)) recent.push(e.mint);
        }
        for (const mint of recent) {
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (state.positions.has(mint) || pendingAny(state, mint)) continue;
          if ([...probeBuys.values()].includes(mint)) continue;
          if (solOf(curve.real_quote_reserves) < 1.5 * threshold) continue;
          if (needCoins && everFilled.has(mint)) continue;
          pick = mint;
          break;
        }
        if (pick !== null) {
          const curve = state.curves.get(pick)!;
          const capLamports = state.maxBuyLamports(pick);
          const lamports = BigInt(Math.floor(p.probeSol * 1e9));
          if (lamports > 0n && lamports <= capLamports && lamports <= state.freeCashLamports()) {
            const id = nextId("q");
            probeBuys.set(id, pick);
            push({ side: "buy", client_id: id, mint: pick, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          } else {
            probeBuys.delete([...probeBuys.entries()].find(([, m]) => m === pick)?.[0] ?? "");
          }
        }
      }
    }

    void lastSeenSlot;
    return orders;
  }

  return {
    onBatch,
    onDone(_state: BotState) {
      console.error(`v8 done: fills=${fillCount} coins=${everFilled.size}`);
    },
  };
}

export type { Fill };
