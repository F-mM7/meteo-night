/**
 * (1+1)-Evolution Strategy で evaluator 重みを最適化する。
 *
 * 目的関数: `mcts(eval_w) vs smart x3` を gamesPerGen 局走らせ、
 *           mcts (seat=0) の平均得点を返す。
 *
 * 各世代:
 *   1. 親重みを Gaussian 摂動 (scale: |w| * sigma) で子重みに
 *   2. 子の fitness を計算
 *   3. child > parent なら採用 (parent ← child)、sigma を拡大
 *   4. それ以外は不採用、sigma を縮小（簡易 1/5 success rule）
 *   5. sigma が閾値以下になったら早期終了
 *
 * 注意: `setEvalWeights` でモジュール global state を変えるため、並列実行不可。
 *
 * Usage:
 *   npx tsx ai/scripts/tune-es.ts [options]
 *
 * Options:
 *   --gens <n>          世代数 (default: 20)
 *   --games <n>         1 fitness 評価あたりの対戦数 (default: 30)
 *   --seed <n>          評価セットの base seed (default: 1)
 *   --sigma <f>         初期 sigma（重みに対する相対摂動の標準偏差） (default: 0.2)
 *   --opponent <name>   対戦相手 (default: smart)
 *   --out <path>        最終重みの保存先 JSON (default: ai/data/tuned-weights.json)
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { GameState } from '../../src/game/types';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';
import { decideAction as decideSmart } from '../../src/ai/smartAI';
import { decideAction as decideRandom } from '../../src/ai/randomAI';
import {
  DEFAULT_WEIGHTS,
  setEvalWeights,
  resetEvalWeights,
  type EvalWeights,
} from '../../src/ai/evaluator';
import { mulberry32 } from '../../src/game/rng';

type OpponentName = 'smart' | 'random';

const OPPONENT_FN: Record<OpponentName, typeof decideSmart> = {
  smart: decideSmart,
  random: decideRandom,
};

function currentActorId(state: GameState): number {
  if (
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches.length > 0
  ) {
    return state.turn.pendingGiftBatches[0].recipientId;
  }
  return state.currentPlayerIndex;
}

function playOne(
  seed: number,
  opponentName: OpponentName,
  maxSteps: number
): { mctsScore: number; mctsRank: number; finished: boolean; steps: number } {
  const opponentFn = OPPONENT_FN[opponentName];
  let state: GameState = setupGame({
    seed,
    playerNames: ['mcts', `${opponentName}-1`, `${opponentName}-2`, `${opponentName}-3`],
    cpuFlags: [true, true, true, true],
  });
  let steps = 0;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = currentActorId(state);
    const action = actor === 0 ? decideMcts(state, actor) : opponentFn(state, actor);
    if (!action) break;
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    steps++;
  }
  const players = state.players;
  const ordered = [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const distA = (a.id - state.startPlayerIndex + players.length) % players.length;
    const distB = (b.id - state.startPlayerIndex + players.length) % players.length;
    return distA - distB;
  });
  const mctsRank = ordered.findIndex((p) => p.id === 0);
  return {
    mctsScore: state.players[0].score,
    mctsRank,
    finished: state.phase === 'gameOver',
    steps,
  };
}

function fitness(
  weights: EvalWeights,
  games: number,
  seedBase: number,
  opponent: OpponentName,
  maxSteps: number
): { avgScore: number; winRate: number; finishedRate: number; avgRank: number } {
  setEvalWeights(weights);
  let scoreSum = 0;
  let wins = 0;
  let finished = 0;
  let rankSum = 0;
  for (let g = 0; g < games; g++) {
    const r = playOne(seedBase + g, opponent, maxSteps);
    scoreSum += r.mctsScore;
    if (r.mctsRank === 0) wins++;
    if (r.finished) finished++;
    rankSum += r.mctsRank + 1;
  }
  return {
    avgScore: scoreSum / games,
    winRate: wins / games,
    finishedRate: finished / games,
    avgRank: rankSum / games,
  };
}

function makeGauss(rng: () => number): () => number {
  let cached: number | null = null;
  return () => {
    if (cached !== null) {
      const v = cached;
      cached = null;
      return v;
    }
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    const t = 2 * Math.PI * u2;
    cached = r * Math.sin(t);
    return r * Math.cos(t);
  };
}

function mutate(w: EvalWeights, sigma: number, gauss: () => number): EvalWeights {
  const out: EvalWeights = { ...w };
  for (const k of Object.keys(out) as (keyof EvalWeights)[]) {
    const base = Math.abs(w[k]);
    // 重みが 0 近傍だと摂動が消えるので最低スケールを付与
    const scale = Math.max(base, 1) * sigma;
    out[k] = w[k] + scale * gauss();
  }
  return out;
}

interface Args {
  gens: number;
  games: number;
  seed: number;
  sigma: number;
  opponent: OpponentName;
  out: string;
  maxSteps: number;
  initPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    gens: 20,
    games: 30,
    seed: 1,
    sigma: 0.2,
    opponent: 'smart',
    out: 'ai/data/tuned-weights.json',
    maxSteps: 20000,
    initPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--gens':
        args.gens = Number(argv[++i]);
        break;
      case '--games':
        args.games = Number(argv[++i]);
        break;
      case '--seed':
        args.seed = Number(argv[++i]);
        break;
      case '--sigma':
        args.sigma = Number(argv[++i]);
        break;
      case '--opponent': {
        const v = argv[++i];
        if (v !== 'smart' && v !== 'random') throw new Error(`bad --opponent: ${v}`);
        args.opponent = v;
        break;
      }
      case '--out':
        args.out = argv[++i];
        break;
      case '--max-steps':
        args.maxSteps = Number(argv[++i]);
        break;
      case '--init':
        args.initPath = argv[++i];
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`Usage: tsx ai/scripts/tune-es.ts [options]

Options:
  --gens <n>          generations (default: 20)
  --games <n>         games per fitness evaluation (default: 30)
  --seed <n>          base seed of evaluation set (default: 1)
  --sigma <f>         initial sigma (relative perturbation) (default: 0.2)
  --opponent <name>   smart | random (default: smart)
  --out <path>        output JSON path (default: ai/data/tuned-weights.json)
  --max-steps <n>     safety cap per game (default: 20000)
  --init <path>       initial weights JSON (default: DEFAULT_WEIGHTS / warm-start可)
`);
}

async function loadInitWeights(path: string | null): Promise<EvalWeights> {
  if (!path) return { ...DEFAULT_WEIGHTS };
  const raw = await fs.readFile(path, 'utf-8');
  const data = JSON.parse(raw);
  const w = data.weights ?? data;
  return { ...DEFAULT_WEIGHTS, ...w };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rng = mulberry32(args.seed);
  const gauss = makeGauss(rng);

  console.log(`tune-es: gens=${args.gens} games=${args.games} seed=${args.seed} sigma=${args.sigma} opponent=${args.opponent} init=${args.initPath ?? 'DEFAULT_WEIGHTS'}`);

  let parent: EvalWeights = await loadInitWeights(args.initPath);
  const tStart = Date.now();
  let parentFit = fitness(parent, args.games, args.seed, args.opponent, args.maxSteps);
  console.log(`gen  0: parent fitness avgScore=${parentFit.avgScore.toFixed(2)} winRate=${(parentFit.winRate * 100).toFixed(1)}% avgRank=${parentFit.avgRank.toFixed(2)} (default weights)`);

  let sigma = args.sigma;
  let bestEver = parent;
  let bestEverFit = parentFit;

  for (let gen = 1; gen <= args.gens; gen++) {
    const child = mutate(parent, sigma, gauss);
    const childFit = fitness(child, args.games, args.seed, args.opponent, args.maxSteps);

    const accepted = childFit.avgScore > parentFit.avgScore;
    let note = 'reject';
    if (accepted) {
      parent = child;
      parentFit = childFit;
      sigma *= 1.3;
      note = 'ACCEPT';
      if (childFit.avgScore > bestEverFit.avgScore) {
        bestEver = child;
        bestEverFit = childFit;
      }
    } else {
      sigma /= 1.2;
    }
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(
      `gen ${String(gen).padStart(2)}: child avgScore=${childFit.avgScore.toFixed(2)} ` +
        `winRate=${(childFit.winRate * 100).toFixed(1)}% rank=${childFit.avgRank.toFixed(2)} ` +
        `| parent avgScore=${parentFit.avgScore.toFixed(2)} sigma=${sigma.toFixed(4)} ` +
        `${note} [${elapsed}s]`
    );

    if (sigma < 0.01) {
      console.log('sigma converged below 0.01, stopping');
      break;
    }
  }

  console.log('\n--- final ---');
  console.log('best ever:', JSON.stringify(bestEverFit));
  console.log('weights:', JSON.stringify(bestEver, null, 2));

  resetEvalWeights();
  const defaultRecheck = fitness(DEFAULT_WEIGHTS, args.games, args.seed, args.opponent, args.maxSteps);
  console.log('default re-check:', JSON.stringify(defaultRecheck));

  await fs.mkdir(dirname(args.out), { recursive: true });
  await fs.writeFile(
    args.out,
    JSON.stringify(
      {
        opponent: args.opponent,
        seed: args.seed,
        gens: args.gens,
        gamesPerGen: args.games,
        bestEverFitness: bestEverFit,
        defaultFitness: defaultRecheck,
        weights: bestEver,
      },
      null,
      2
    )
  );
  console.log(`saved to ${args.out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
