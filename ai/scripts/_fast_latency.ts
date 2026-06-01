/**
 * tempoFastAI / tempoAI のレイテンシ計測ハーネス。
 *
 * 候補 AI を 1 席、 baseline mcts(Gen-3-X) を 3 席に置いて N 局プレイし、
 * 候補 AI の decideAction の所要時間だけを毎手記録する。
 * p50/p90/p95/p99/max と「≥500ms の手の割合」 を出力する。
 *
 * 使い方:
 *   npx tsx ai/scripts/_fast_latency.ts --ai fast --budget 150 --games 12 --seed 31001
 *   npx tsx ai/scripts/_fast_latency.ts --ai tempo --games 12 --seed 31001   # 旧 tempoAI（無予算）
 *   npx tsx ai/scripts/_fast_latency.ts --ai fast --budget 250 --lookahead 1 --opp mcts --games 12
 */
import { performance } from 'node:perf_hooks';
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { DEFAULT_WEIGHTS } from '../../src/ai/evaluator';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';
import { decideAction as decideTempo } from '../../src/ai/tempoAI';
import {
  decideAction as decideTempoFast,
  type OpponentModel,
} from '../../src/ai/tempoFastAI';

function currentActorId(s: GameState): number {
  if (s.phase === 'awaitingGiftPlacement' && s.turn.pendingGiftBatches.length > 0) {
    return s.turn.pendingGiftBatches[0].recipientId;
  }
  return s.currentPlayerIndex;
}

interface Args {
  ai: 'fast' | 'tempo';
  budget: number;
  games: number;
  seed: number;
  lookahead: number;
  opp: OpponentModel;
  maxSteps: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    ai: 'fast',
    budget: 150,
    games: 12,
    seed: 31001,
    lookahead: 0,
    opp: 'smart',
    maxSteps: 20000,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--ai': {
        const v = argv[++i];
        if (v !== 'fast' && v !== 'tempo') throw new Error('--ai: fast | tempo');
        a.ai = v;
        break;
      }
      case '--budget':
        a.budget = Number(argv[++i]);
        break;
      case '--games':
        a.games = Number(argv[++i]);
        break;
      case '--seed':
        a.seed = Number(argv[++i]);
        break;
      case '--lookahead':
        a.lookahead = Number(argv[++i]);
        break;
      case '--opp': {
        const v = argv[++i];
        if (v !== 'smart' && v !== 'mcts' && v !== 'tempo') throw new Error('--opp: smart|mcts|tempo');
        a.opp = v;
        break;
      }
      case '--max-steps':
        a.maxSteps = Number(argv[++i]);
        break;
      default:
        throw new Error(`unknown arg: ${k}`);
    }
  }
  return a;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const baseline = (s: GameState, pid: number): Action | null =>
    decideMcts(s, pid, undefined, { weights: DEFAULT_WEIGHTS });

  const candidate = (s: GameState, pid: number): Action | null => {
    if (args.ai === 'fast') {
      return decideTempoFast(s, pid, undefined, {
        tempoChainW: 50,
        timeBudgetMs: args.budget,
        lookaheadTurns: args.lookahead,
        opponentModel: args.opp,
      });
    }
    return decideTempo(s, pid, undefined, { tempoChainW: 50, lookaheadTurns: args.lookahead });
  };

  const timings: number[] = [];
  let candWins = 0;
  let finished = 0;

  for (let g = 0; g < args.games; g++) {
    const candSeat = g % 4;
    let state: GameState = setupGame({
      seed: args.seed + g,
      playerNames: [0, 1, 2, 3].map((s) => (s === candSeat ? 'cand' : 'base')),
      cpuFlags: [true, true, true, true],
    });
    let steps = 0;
    while (state.phase !== 'gameOver' && steps < args.maxSteps) {
      const actor = currentActorId(state);
      let action: Action | null;
      if (actor === candSeat) {
        const t0 = performance.now();
        action = candidate(state, actor);
        const dt = performance.now() - t0;
        // 候補が「探索した手番」 のみ計測（null=委譲/手番外は除外、 ただし actor===candSeat なので手番内）。
        if (action) timings.push(dt);
      } else {
        action = baseline(state, actor);
      }
      if (!action) break;
      const before = state;
      state = stepGame(state, action);
      if (state === before) break;
      steps++;
    }
    if (state.phase === 'gameOver') {
      finished++;
      // ranking: 候補が最高得点か（同点は startPlayer 距離でタイブレーク。 ここでは勝率の概算で十分）。
      const scores = state.players.map((p) => p.score);
      const maxScore = Math.max(...scores);
      if (scores[candSeat] === maxScore) candWins++;
    }
  }

  timings.sort((x, y) => x - y);
  const ge500 = timings.filter((t) => t >= 500).length;
  const out = {
    ai: args.ai,
    budgetMs: args.ai === 'fast' ? args.budget : 'n/a (unbounded)',
    lookahead: args.lookahead,
    opponentModel: args.lookahead > 0 ? args.opp : 'n/a',
    games: args.games,
    seed: args.seed,
    finishedGames: finished,
    moves: timings.length,
    latencyMs: {
      p50: +pct(timings, 50).toFixed(2),
      p90: +pct(timings, 90).toFixed(2),
      p95: +pct(timings, 95).toFixed(2),
      p99: +pct(timings, 99).toFixed(2),
      max: +(timings[timings.length - 1] ?? 0).toFixed(2),
      mean: +(timings.reduce((s, t) => s + t, 0) / Math.max(1, timings.length)).toFixed(2),
    },
    movesGE500ms: ge500,
    pctGE500ms: +((ge500 / Math.max(1, timings.length)) * 100).toFixed(3),
    candWinsApprox: candWins,
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
