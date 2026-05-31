/**
 * Gen-3-X: smart 非依存ベンチ。 「候補 mcts」 vs 「baseline mcts（現最強 Gen-3-O = DEFAULT_WEIGHTS）」 を直接対戦させる。
 *
 * 背景:
 *   vs smart ベンチは mcts と smart が同じ評価関数を共有するため、 評価関数の盲点
 *   （連鎖の超線形価値など）を検出できない。 候補 vs baseline の直接対戦なら、
 *   「現最強より強くなったか」 を smart 非依存で判定できる。
 *
 * 使い方:
 *   # chainReadyMult=0.5 を候補にして baseline と対戦
 *   npx tsx ai/scripts/bench-self.ts --cand '{"chainReadyMult":0.5}' --games 48 --seed 1001
 *
 *   # 候補重みを JSON ファイルから
 *   npx tsx ai/scripts/bench-self.ts --cand-file ai/data/cand.json --games 48
 *
 * 出力: 候補の勝率（公平基準 25%）、 Wilson CI、 平均スコア、 候補 vs baseline の
 *       「同席で勝った率」 (head-to-head)。
 */
import { promises as fs } from 'node:fs';
import {
  makeMctsWithWeights,
  makeTempoWithOpts,
  playOneGameWithDeciders,
  parseIntArg,
  type Decider,
} from './_runner';
import { DEFAULT_WEIGHTS, type EvalWeights } from '../../src/ai/evaluator';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';
import { wilsonInterval } from './stats';

interface Args {
  candOverride: Partial<EvalWeights>;
  candAi: 'mcts' | 'tempo';
  tempoChainW: number;
  lookaheadTurns: number;
  games: number;
  seed: number;
  maxSteps: number;
}

async function parseArgs(argv: string[]): Promise<Args> {
  const args: Args = { candOverride: {}, candAi: 'mcts', tempoChainW: 0, lookaheadTurns: 0, games: 48, seed: 1001, maxSteps: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--cand':
        args.candOverride = JSON.parse(argv[++i]);
        break;
      case '--cand-ai': {
        const v = argv[++i];
        if (v !== 'mcts' && v !== 'tempo') throw new Error('--cand-ai requires: mcts | tempo');
        args.candAi = v;
        break;
      }
      case '--tempo-chain-w': {
        const v = Number(argv[++i]);
        if (!Number.isFinite(v)) throw new Error('--tempo-chain-w requires a finite number');
        args.tempoChainW = v;
        break;
      }
      case '--lookahead': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 0) throw new Error('--lookahead requires a non-negative integer');
        args.lookaheadTurns = v;
        break;
      }
      case '--cand-file': {
        const raw = await fs.readFile(argv[++i], 'utf-8');
        const data = JSON.parse(raw);
        args.candOverride = data.weights ?? data;
        break;
      }
      case '--games':
        args.games = parseIntArg('--games', argv[++i]);
        break;
      case '--seed':
        args.seed = parseIntArg('--seed', argv[++i]);
        break;
      case '--max-steps':
        args.maxSteps = parseIntArg('--max-steps', argv[++i]);
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = await parseArgs(process.argv.slice(2));
  const candWeights: EvalWeights = { ...DEFAULT_WEIGHTS, ...args.candOverride };
  const candidate: Decider =
    args.candAi === 'tempo'
      ? makeTempoWithOpts({ weights: candWeights, tempoChainW: args.tempoChainW, lookaheadTurns: args.lookaheadTurns })
      : makeMctsWithWeights(candWeights);
  // baseline は DEFAULT_WEIGHTS の mcts（明示渡しで global 非依存）。
  const baseline: Decider = (state, pid) => decideMcts(state, pid, undefined, { weights: DEFAULT_WEIGHTS });

  console.error(`[bench-self] candidate AI: ${args.candAi}, override: ${JSON.stringify(args.candOverride)}`);
  console.error(`[bench-self] games=${args.games} seed=${args.seed} (候補 1 席 vs baseline 3 席, rotate)`);

  let candWins = 0;
  let candScoreSum = 0;
  let baseScoreSum = 0;
  const candRankCount = [0, 0, 0, 0];
  let unfinished = 0;
  let totalSteps = 0;
  let totalMs = 0;

  for (let g = 0; g < args.games; g++) {
    const candSeat = g % 4;
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === candSeat ? candidate : baseline));
    const names = [0, 1, 2, 3].map((s) => (s === candSeat ? 'cand' : 'base'));
    const r = playOneGameWithDeciders({ seed: args.seed + g, deciders, names, maxSteps: args.maxSteps });
    if (r.ranking[candSeat] === 0) candWins++;
    candRankCount[r.ranking[candSeat]]++;
    candScoreSum += r.scores[candSeat];
    for (let s = 0; s < 4; s++) if (s !== candSeat) baseScoreSum += r.scores[s];
    if (!r.finished) unfinished++;
    totalSteps += r.steps;
    totalMs += r.durationMs;
  }

  const winRate = candWins / args.games;
  const ci = wilsonInterval(candWins, args.games);
  const out = {
    candOverride: args.candOverride,
    games: args.games,
    candWins,
    candWinRate: winRate,
    fairBaseline: 0.25,
    winRateCI95: { low: ci.low, high: ci.high },
    candAvgScore: candScoreSum / args.games,
    baseAvgScore: baseScoreSum / (args.games * 3),
    candRankDist: candRankCount,
    unfinishedGames: unfinished,
    averageMsPerStep: totalSteps > 0 ? totalMs / totalSteps : 0,
  };
  console.log(JSON.stringify(out, null, 2));
  const verdict =
    ci.low > 0.25 ? '✅ 候補が有意に強い' : ci.high < 0.25 ? '❌ 候補が有意に弱い' : '― 有意差なし';
  console.error(
    `\n候補 勝率 ${(winRate * 100).toFixed(1)}% (CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) vs 公平基準 25%  → ${verdict}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
