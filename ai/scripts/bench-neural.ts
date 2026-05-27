/**
 * Gen-3-K3: 学習済み neural モデル vs 既存戦略のベンチ。
 *
 * Usage:
 *   npx tsx ai/scripts/bench-neural.ts <model-dir> [--games <n>] [--seed <n>] [--max-steps <n>] [--silent] [--json]
 *
 * 出力フォーマットは bench.ts と互換（勝率・CI・avg score・順位分布）。
 */
import { readFileSync } from 'node:fs';
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideSmart } from '../../src/ai/smartAI';
import { decideAction as decideRandom } from '../../src/ai/randomAI';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';
import { loadModel, type MeteoAzModel } from './nn/model';
import { decideActionNeural } from './nn/neuralMcts';

type OpponentName = 'smart' | 'random' | 'mcts';

const OPPONENT_FN: Record<OpponentName, (state: GameState, playerId: number) => Action | null> = {
  smart: decideSmart,
  random: decideRandom,
  mcts: decideMcts,
};

interface GameResult {
  winnerId: number | null;
  scores: number[];
  ranking: number[];
  turns: number;
  steps: number;
  durationMs: number;
  finished: boolean;
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

function playOne(
  seed: number,
  model: MeteoAzModel,
  neuralSeat: number,
  opponent: OpponentName,
  maxSteps: number
): GameResult {
  const t0 = Date.now();
  const names = ['p0', 'p1', 'p2', 'p3'].map((n, i) =>
    i === neuralSeat ? 'neural' : `${opponent}-${n}`
  );
  let state: GameState = setupGame({
    seed,
    playerNames: names,
    cpuFlags: [true, true, true, true],
  });
  const opponentFn = OPPONENT_FN[opponent];
  // awaitingGiftSelection はどの戦略でも smart 委譲が安定（過去の Gen-3-G/H/I で確認済み）
  let steps = 0;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = currentActorId(state);
    let action: Action | null;
    if (actor === neuralSeat && state.phase !== 'awaitingGiftSelection') {
      const r = decideActionNeural(state, actor, model);
      action = r.action;
    } else {
      action = opponentFn(state, actor);
    }
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
    turns: state.turnNumber,
    steps,
    durationMs: Date.now() - t0,
    finished: state.phase === 'gameOver',
  };
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

interface Args {
  modelDir: string;
  opponent: OpponentName;
  games: number;
  seed: number;
  maxSteps: number;
  rotate: boolean;
  silent: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  if (argv.length === 0 || argv[0].startsWith('--')) {
    throw new Error('first positional arg must be the model directory');
  }
  const args: Args = {
    modelDir: argv[0],
    opponent: 'smart',
    games: 50,
    seed: 1001,
    maxSteps: 20000,
    rotate: true,
    silent: false,
    json: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--opponent': {
        const v = argv[++i];
        if (v !== 'smart' && v !== 'random' && v !== 'mcts') {
          throw new Error(`bad --opponent: ${v} (smart | random | mcts)`);
        }
        args.opponent = v;
        break;
      }
      case '--games':
        args.games = Number(argv[++i]);
        break;
      case '--seed':
        args.seed = Number(argv[++i]);
        break;
      case '--max-steps':
        args.maxSteps = Number(argv[++i]);
        break;
      case '--no-rotate':
        args.rotate = false;
        break;
      case '--silent':
        args.silent = true;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.error(`[bench-neural] loading model from ${args.modelDir}`);
  const model = await loadModel(args.modelDir);

  let neuralWins = 0;
  let neuralScoreSum = 0;
  const neuralRankCount = [0, 0, 0, 0];
  let totalSteps = 0;
  let totalMs = 0;
  let unfinished = 0;

  for (let g = 0; g < args.games; g++) {
    const seed = args.seed + g;
    const neuralSeat = args.rotate ? g % 4 : 0;
    const r = playOne(seed, model, neuralSeat, args.opponent, args.maxSteps);
    if (r.ranking[neuralSeat] === 0) neuralWins++;
    neuralRankCount[r.ranking[neuralSeat]] += 1;
    neuralScoreSum += r.scores[neuralSeat];
    totalSteps += r.steps;
    totalMs += r.durationMs;
    if (!r.finished) unfinished++;
    if (!args.silent && !args.json) {
      console.log(
        `game ${g + 1}/${args.games} seed=${seed} seat=${neuralSeat} ` +
          `winner=P${r.winnerId} scores=[${r.scores.join(',')}] steps=${r.steps} ms=${r.durationMs}`
      );
    }
  }

  const winRate = neuralWins / args.games;
  const ci = wilsonInterval(neuralWins, args.games);
  const avgScore = neuralScoreSum / args.games;
  const expRank = neuralRankCount.reduce((acc, c, i) => acc + c * (i + 1), 0) / args.games;
  const summary = {
    modelDir: args.modelDir,
    opponent: args.opponent,
    games: args.games,
    rotate: args.rotate,
    neuralWins,
    neuralWinRate: winRate,
    winRateCI95: ci,
    neuralAvgScore: avgScore,
    neuralExpectedRank: expRank,
    rankDist: neuralRankCount,
    avgMsPerStep: totalSteps > 0 ? totalMs / totalSteps : 0,
    unfinishedGames: unfinished,
  };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('--- bench-neural summary ---');
    console.log(
      `neural: wins=${neuralWins}/${args.games} (${(winRate * 100).toFixed(1)}%) ` +
        `95%CI [${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%] ` +
        `avgScore=${avgScore.toFixed(2)} expRank=${expRank.toFixed(2)} ` +
        `ranks=[${neuralRankCount.join(',')}] ` +
        `avgMs/step=${(totalMs / Math.max(1, totalSteps)).toFixed(3)} ` +
        `unfinished=${unfinished}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void readFileSync; // 将来 --weights 等で使う可能性
