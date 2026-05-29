/**
 * Gen-3-U 用 grid search: 自己得点項の非線形（凸）係数 `selfScoreConvex` を評価する。
 *
 * Gen-3-T で「終局評価は到達頻度が低く実質無関係。 得点 vs 勝利のトレードオフは
 * 途中盤面の評価関数（得点項）に存在する」 と判明した。
 * 得点項を `score * selfScoreMult * (1 + convex * score / 20)` と凸化し、
 * 「終了閾値(20点)への近さ＝勝利への近さ」 を逓増評価する強さを探索する。
 *
 * convex=0 は従来の線形（Gen-3-O）と完全一致なので、 sanity baseline を兼ねる。
 * 他の重み・ハイパラ（uctC=1.7, iter=800, leafEvalScale=1500）は据置。
 *
 * Usage:
 *   npx tsx ai/scripts/grid-score-convex.ts \
 *     --games 100 --seed 1001 --grid 0,0.25,0.5,1,2,4 --json
 *
 * Options:
 *   --games <n>   1 候補あたりの局数 (default: 100)
 *   --seed <n>    base seed (default: 1001)
 *   --grid <list> selfScoreConvex 候補のカンマ区切り (default: 0,0.25,0.5,1,2,4)
 *   --strategies  (default: mcts,smart,smart,smart)
 *   --rotate      座席ローテーション (default: 有効)
 *   --json        JSON 出力
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideSmart } from '../../src/ai/smartAI';
import { decideAction as decideRandom } from '../../src/ai/randomAI';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';
import { DEFAULT_WEIGHTS, type EvalWeights } from '../../src/ai/evaluator';
import { parseIntArg } from './_runner';
import { expectedRankFromRankCount, wilsonInterval } from './stats';

interface CandidateStat {
  convex: number;
  games: number;
  wins: number;
  scoreSum: number;
  rankCount: [number, number, number, number];
  totalSteps: number;
  totalMs: number;
}

interface Args {
  games: number;
  seed: number;
  grid: number[];
  strategies: string[];
  rotate: boolean;
  json: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = {
    games: 100,
    seed: 1001,
    grid: [0, 0.25, 0.5, 1, 2, 4],
    strategies: ['mcts', 'smart', 'smart', 'smart'],
    rotate: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--games':
        out.games = parseIntArg('--games', argv[++i]);
        break;
      case '--seed':
        out.seed = parseIntArg('--seed', argv[++i]);
        break;
      case '--grid': {
        const raw = argv[++i];
        if (raw === undefined) throw new Error('--grid requires a value');
        const parts = raw.split(',').map((s) => Number(s.trim()));
        // convex は負値（凹＝高得点で逓減）も許容。ただし factor = 1 + convex*score/20 が
        // 正に保たれるよう -1 より大きいことを要求する（score は最大 ~23 程度まで増えうる）。
        if (parts.some((v) => !Number.isFinite(v) || v <= -1)) {
          throw new Error('--grid must contain finite numbers > -1 (factor must stay positive)');
        }
        out.grid = parts;
        break;
      }
      case '--strategies': {
        const raw = argv[++i];
        if (raw === undefined) throw new Error('--strategies requires a value');
        const list = raw.split(',');
        if (list.length !== 4) {
          throw new Error('--strategies must have 4 comma-separated entries');
        }
        out.strategies = list;
        break;
      }
      case '--no-rotate':
        out.rotate = false;
        break;
      case '--rotate':
        out.rotate = true;
        break;
      case '--json':
        out.json = true;
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

function rotate<T>(arr: T[], n: number): T[] {
  const len = arr.length;
  return arr.map((_, i) => arr[(i + n) % len]);
}

function computeRanking(state: GameState): number[] {
  const players = state.players;
  const ordered = [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const distA = (a.id - state.startPlayerIndex + players.length) % players.length;
    const distB = (b.id - state.startPlayerIndex + players.length) % players.length;
    return distA - distB;
  });
  const rank = new Array<number>(players.length).fill(0);
  ordered.forEach((p, i) => {
    rank[p.id] = i;
  });
  return rank;
}

function currentActorId(state: GameState): number {
  if (
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches.length > 0
  ) {
    return state.turn.pendingGiftBatches[0].recipientId;
  }
  return state.currentPlayerIndex;
}

function makeDecider(
  strategy: string,
  mctsWeights: EvalWeights
): (s: GameState, pid: number) => Action | null {
  switch (strategy) {
    case 'random':
      return (s, pid) => decideRandom(s, pid);
    case 'smart':
      // smart はモジュール global（DEFAULT, convex=0）を使う＝凸化の影響を受けない
      return (s, pid) => decideSmart(s, pid);
    case 'mcts':
      return (s, pid) => decideMcts(s, pid, undefined, { weights: mctsWeights });
    default:
      throw new Error(`unknown strategy: ${strategy}`);
  }
}

function playGame(seed: number, strategies: string[], mctsWeights: EvalWeights): {
  winnerId: number | null;
  scores: number[];
  ranking: number[];
  steps: number;
  durationMs: number;
  finished: boolean;
} {
  const t0 = Date.now();
  let state: GameState = setupGame({
    seed,
    playerNames: strategies.map((s, i) => `P${i}-${s}`),
    cpuFlags: strategies.map(() => true),
  });
  const deciders = strategies.map((s) => makeDecider(s, mctsWeights));
  let steps = 0;
  const maxSteps = 20000;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actorId = currentActorId(state);
    const action = deciders[actorId](state, actorId);
    if (!action) break;
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    steps++;
  }
  return {
    winnerId: state.winnerId,
    scores: state.players.map((p) => p.score),
    ranking: computeRanking(state),
    steps,
    durationMs: Date.now() - t0,
    finished: state.phase === 'gameOver',
  };
}

function main(): void {
  const args = parseArgs();
  if (args.strategies.indexOf('mcts') < 0) {
    throw new Error('--strategies must contain "mcts" exactly once for grid search');
  }

  const results: CandidateStat[] = [];

  for (const convex of args.grid) {
    const mctsWeights: EvalWeights = { ...DEFAULT_WEIGHTS, selfScoreConvex: convex };
    const stat: CandidateStat = {
      convex,
      games: 0,
      wins: 0,
      scoreSum: 0,
      rankCount: [0, 0, 0, 0],
      totalSteps: 0,
      totalMs: 0,
    };
    process.stderr.write(`[grid] selfScoreConvex=${convex.toFixed(2).padStart(5)} running ${args.games} games... `);
    const tStart = Date.now();
    for (let g = 0; g < args.games; g++) {
      const seed = args.seed + g;
      const rotation = args.rotate ? g % 4 : 0;
      const seats = rotate(args.strategies, rotation);
      const mctsSeatIdx = seats.indexOf('mcts');
      const r = playGame(seed, seats, mctsWeights);
      stat.games += 1;
      stat.scoreSum += r.scores[mctsSeatIdx];
      stat.rankCount[r.ranking[mctsSeatIdx]] += 1;
      if (r.winnerId === mctsSeatIdx) stat.wins += 1;
      stat.totalSteps += r.steps;
      stat.totalMs += r.durationMs;
    }
    const ci = wilsonInterval(stat.wins, stat.games);
    const expRank = expectedRankFromRankCount(stat.rankCount, Math.max(1, stat.games));
    const msPerStep = stat.totalSteps > 0 ? stat.totalMs / stat.totalSteps : 0;
    process.stderr.write(
      `wr=${(stat.wins / stat.games * 100).toFixed(1)}% ` +
        `(CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) ` +
        `avgScore=${(stat.scoreSum / stat.games).toFixed(2)} ` +
        `expRank=${expRank.toFixed(2)} ` +
        `ranks=[${stat.rankCount.join(',')}] ` +
        `msPerStep=${msPerStep.toFixed(2)} ` +
        `wallSec=${((Date.now() - tStart) / 1000).toFixed(1)}s\n`
    );
    results.push(stat);
  }

  const sorted = [...results].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.scoreSum - a.scoreSum;
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          games: args.games,
          seed: args.seed,
          rotate: args.rotate,
          strategies: args.strategies,
          candidates: results.map((s) => {
            const ci = wilsonInterval(s.wins, s.games);
            const expRank = expectedRankFromRankCount(s.rankCount, Math.max(1, s.games));
            return {
              selfScoreConvex: s.convex,
              games: s.games,
              wins: s.wins,
              winRate: s.wins / s.games,
              winRateCI95: { low: ci.low, high: ci.high },
              averageScore: s.scoreSum / s.games,
              expectedRank: expRank,
              rankDist: s.rankCount,
              msPerStep: s.totalSteps > 0 ? s.totalMs / s.totalSteps : 0,
            };
          }),
          best: { selfScoreConvex: sorted[0].convex, wins: sorted[0].wins },
        },
        null,
        2
      )
    );
    return;
  }

  console.log('\n--- grid summary (sorted by wins desc, tie-break: avgScore) ---');
  for (const s of sorted) {
    const ci = wilsonInterval(s.wins, s.games);
    const expRank = expectedRankFromRankCount(s.rankCount, Math.max(1, s.games));
    const msPerStep = s.totalSteps > 0 ? s.totalMs / s.totalSteps : 0;
    console.log(
      `selfScoreConvex=${s.convex.toFixed(2).padStart(5)} ` +
        `wins=${s.wins.toString().padStart(3)}/${s.games} ` +
        `wr=${(s.wins / s.games * 100).toFixed(1)}% ` +
        `(CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) ` +
        `avgScore=${(s.scoreSum / s.games).toFixed(2)} ` +
        `expRank=${expRank.toFixed(2)} ` +
        `msPerStep=${msPerStep.toFixed(2)}`
    );
  }
  console.log(`\nbest selfScoreConvex: ${sorted[0].convex} (wins=${sorted[0].wins}/${sorted[0].games})`);
}

main();
