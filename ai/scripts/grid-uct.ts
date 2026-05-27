/**
 * Gen-3-L 用 grid search: MCTS の uctC を網羅的に評価する。
 *
 * 既存の mctsAI が `sqrt(2) ~= 1.414` を使い続けているが、
 * これは Gen-1 で rollout を使っていた時の UCB1 標準値。
 * 現状の leaf evaluator (tanh で [-1, +1]) では別の値が最適である可能性が高い。
 *
 * Usage:
 *   npx tsx ai/scripts/grid-uct.ts \
 *     --games 100 --seed 1001 \
 *     --grid 0.3,0.5,0.7,1.0,1.4142,1.7,2.0,2.4 \
 *     --json
 *
 * Options:
 *   --games <n>   1 候補あたりの局数 (default: 100)
 *   --seed <n>    base seed (default: 1001)
 *   --grid <list> カンマ区切りの uctC 候補 (default: 0.3,0.5,0.7,1.0,1.4142,1.7,2.0,2.4)
 *   --strategies  mcts と対戦相手の組合せ (default: mcts,smart,smart,smart)
 *   --rotate      座席を回す (default: 有効)
 *   --json        集計を JSON で出力（最後にまとめて）
 *
 * 集計:
 *   各 uctC について
 *     - mcts 勝率 (Wilson 95%CI 付き)
 *     - 平均得点・期待順位
 *     - 1 手あたり時間
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideSmart } from '../../src/ai/smartAI';
import { decideAction as decideRandom } from '../../src/ai/randomAI';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';

interface CandidateStat {
  uctC: number;
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
    grid: [0.3, 0.5, 0.7, 1.0, 1.4142135, 1.7, 2.0, 2.4],
    strategies: ['mcts', 'smart', 'smart', 'smart'],
    rotate: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--games':
        out.games = Number(argv[++i]);
        break;
      case '--seed':
        out.seed = Number(argv[++i]);
        break;
      case '--grid': {
        const parts = argv[++i].split(',').map((s) => Number(s.trim()));
        if (parts.some((v) => !Number.isFinite(v))) {
          throw new Error('--grid contained a non-finite number');
        }
        out.grid = parts;
        break;
      }
      case '--strategies': {
        const list = argv[++i].split(',');
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

function wilsonInterval(wins: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
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

function makeDecider(strategy: string, uctC: number): (s: GameState, pid: number) => Action | null {
  switch (strategy) {
    case 'random':
      return (s, pid) => decideRandom(s, pid);
    case 'smart':
      return (s, pid) => decideSmart(s, pid);
    case 'mcts':
      return (s, pid) => decideMcts(s, pid, undefined, { uctC });
    default:
      throw new Error(`unknown strategy: ${strategy}`);
  }
}

function playGame(seed: number, strategies: string[], uctC: number): {
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
  const deciders = strategies.map((s) => makeDecider(s, uctC));
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

  // mcts が strategies に含まれるはずなので、その index を覚える（rotate 後の追跡用）
  const mctsBaseIdx = args.strategies.indexOf('mcts');
  if (mctsBaseIdx < 0) {
    throw new Error('--strategies must contain "mcts" exactly once for grid search');
  }

  const results: CandidateStat[] = [];

  for (const uctC of args.grid) {
    const stat: CandidateStat = {
      uctC,
      games: 0,
      wins: 0,
      scoreSum: 0,
      rankCount: [0, 0, 0, 0],
      totalSteps: 0,
      totalMs: 0,
    };
    process.stderr.write(`[grid] uctC=${uctC.toFixed(4)} running ${args.games} games... `);
    const tStart = Date.now();
    for (let g = 0; g < args.games; g++) {
      const seed = args.seed + g;
      const rotation = args.rotate ? g % 4 : 0;
      const seats = rotate(args.strategies, rotation);
      const mctsSeatIdx = seats.indexOf('mcts');
      const r = playGame(seed, seats, uctC);
      stat.games += 1;
      stat.scoreSum += r.scores[mctsSeatIdx];
      stat.rankCount[r.ranking[mctsSeatIdx]] += 1;
      if (r.winnerId === mctsSeatIdx) stat.wins += 1;
      stat.totalSteps += r.steps;
      stat.totalMs += r.durationMs;
    }
    const ci = wilsonInterval(stat.wins, stat.games);
    const expRank =
      stat.rankCount.reduce((acc, c, idx) => acc + c * (idx + 1), 0) / Math.max(1, stat.games);
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

  // best by wins, tie-break by avgScore
  const sorted = [...results].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.scoreSum - a.scoreSum;
  });

  if (args.json) {
    const out = {
      games: args.games,
      seed: args.seed,
      rotate: args.rotate,
      strategies: args.strategies,
      candidates: results.map((s) => {
        const ci = wilsonInterval(s.wins, s.games);
        const expRank =
          s.rankCount.reduce((acc, c, idx) => acc + c * (idx + 1), 0) / Math.max(1, s.games);
        return {
          uctC: s.uctC,
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
      best: { uctC: sorted[0].uctC, wins: sorted[0].wins },
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log('\n--- grid summary (sorted by wins desc, tie-break: avgScore) ---');
  for (const s of sorted) {
    const ci = wilsonInterval(s.wins, s.games);
    const expRank =
      s.rankCount.reduce((acc, c, idx) => acc + c * (idx + 1), 0) / Math.max(1, s.games);
    const msPerStep = s.totalSteps > 0 ? s.totalMs / s.totalSteps : 0;
    console.log(
      `uctC=${s.uctC.toFixed(4).padStart(7)} ` +
        `wins=${s.wins.toString().padStart(3)}/${s.games} ` +
        `wr=${(s.wins / s.games * 100).toFixed(1)}% ` +
        `(CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) ` +
        `avgScore=${(s.scoreSum / s.games).toFixed(2)} ` +
        `expRank=${expRank.toFixed(2)} ` +
        `msPerStep=${msPerStep.toFixed(2)}`
    );
  }
  console.log(`\nbest uctC: ${sorted[0].uctC.toFixed(4)} (wins=${sorted[0].wins}/${sorted[0].games})`);
}

main();
