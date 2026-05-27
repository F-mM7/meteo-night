/**
 * 戦略単位の集計を行うベンチランナー。
 * 「同じ戦略を複数席に配置しても、戦略別に勝率を求める」のが selfplay との違い。
 *
 * Usage:
 *   npx tsx ai/scripts/bench.ts [options]
 *
 * Options (selfplay と共通):
 *   --games <n>            (default: 200)
 *   --strategies <list>    4 つカンマ区切り (default: smart,random,random,random)
 *   --seed <n>             base seed (default: 1)
 *   --rotate               各局で席を 1 つずらして席バイアスを除去
 *   --max-steps <n>        1 局あたり安全上限 (default: 5000)
 *   --silent               局ごとのログを抑制
 *   --json                 集計を JSON で出力
 *
 * 統計:
 *   各戦略について
 *     - 勝率（95% Wilson 信頼区間付き）
 *     - 平均得点
 *     - 期待順位（1位=1, 2位=2, ...）
 *     - 順位分布
 */
import { readFileSync } from 'node:fs';
import {
  CommonArgs,
  GameResult,
  parseCommonArgs,
  playOneGame,
  rotateSeats,
  StrategyName,
} from './_runner';
import { setEvalWeights } from '../../src/ai/evaluator';

interface StratStat {
  games: number;
  wins: number;
  scoreSum: number;
  rankCount: [number, number, number, number];
}

function newStratStat(): StratStat {
  return { games: 0, wins: 0, scoreSum: 0, rankCount: [0, 0, 0, 0] };
}

/** Wilson 95% 信頼区間 */
function wilsonInterval(wins: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function printUsage(): void {
  console.log(`Usage: tsx ai/scripts/bench.ts [options]

Options:
  --games <n>             games per run (default: 200)
  --strategies <list>     4 of: random | smart | mcts | mctsRollout | mctsPuct | mctsTuned (default: smart,random,random,random)
  --seed <n>              base seed (default: 1)
  --rotate                rotate seats each game (removes seat bias)
  --max-steps <n>         safety bound per game (default: 5000)
  --silent                suppress per-game logs
  --json                  emit JSON summary to stdout
  --weights <path>        load EvalWeights from JSON (e.g. tune-es output)`);
}

function loadWeightsArg(argv: string[]): string[] {
  const idx = argv.indexOf('--weights');
  if (idx < 0) return argv;
  const path = argv[idx + 1];
  if (!path) throw new Error('--weights requires a path argument');
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  const weights = parsed.weights ?? parsed;
  setEvalWeights(weights);
  console.error(`[bench] loaded weights from ${path}`);
  return [...argv.slice(0, idx), ...argv.slice(idx + 2)];
}

function main(): void {
  const argv = loadWeightsArg(process.argv.slice(2));
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }
  const defaults: Partial<CommonArgs> = {
    games: 200,
    seed: 1,
    strategies: ['smart', 'random', 'random', 'random'],
    rotate: false,
  };
  const args = parseCommonArgs(argv, defaults);

  const stats = new Map<StrategyName, StratStat>();
  for (const s of args.strategies) {
    if (!stats.has(s)) stats.set(s, newStratStat());
  }

  const results: GameResult[] = [];
  for (let g = 0; g < args.games; g++) {
    const seed = args.seed + g;
    const rotation = args.rotate ? g % 4 : 0;
    const seats = rotateSeats(args.strategies, rotation);
    const r = playOneGame({ seed, strategies: seats, maxSteps: args.maxSteps });
    results.push(r);
    for (let i = 0; i < 4; i++) {
      const s = seats[i];
      const st = stats.get(s)!;
      st.games += 1;
      st.scoreSum += r.scores[i];
      st.rankCount[r.ranking[i]] += 1;
      if (r.winnerId === i) st.wins += 1;
    }
    if (!args.silent && !args.json) {
      console.log(
        `game ${g + 1}/${args.games} seed=${seed} rotation=${rotation} ` +
          `seats=[${seats.join(',')}] ` +
          `winner=P${r.winnerId}(${r.winnerId !== null ? seats[r.winnerId] : 'none'}) ` +
          `scores=[${r.scores.join(',')}] steps=${r.steps}`
      );
    }
  }

  const totalSteps = results.reduce((acc, r) => acc + r.steps, 0);
  const totalMs = results.reduce((acc, r) => acc + r.durationMs, 0);
  const unfinished = results.filter((r) => !r.finished).length;

  const summary = Array.from(stats.entries()).map(([s, st]) => {
    const ci = wilsonInterval(st.wins, st.games);
    const expRank =
      st.games > 0
        ? st.rankCount.reduce((acc, c, idx) => acc + c * (idx + 1), 0) / st.games
        : 0;
    return {
      strategy: s,
      games: st.games,
      wins: st.wins,
      winRate: st.games > 0 ? st.wins / st.games : 0,
      winRateCI95: { low: ci.low, high: ci.high },
      averageScore: st.games > 0 ? st.scoreSum / st.games : 0,
      expectedRank: expRank,
      rankDist: st.rankCount,
    };
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          games: args.games,
          rotate: args.rotate,
          seedBase: args.seed,
          summary,
          totalSteps,
          averageMsPerStep: totalSteps > 0 ? totalMs / totalSteps : 0,
          unfinishedGames: unfinished,
        },
        null,
        2
      )
    );
    return;
  }

  console.log('--- bench summary ---');
  console.log(
    `games=${args.games} rotate=${args.rotate} seedBase=${args.seed} ` +
      `totalSteps=${totalSteps} avgMs/step=${(totalMs / Math.max(1, totalSteps)).toFixed(3)} ` +
      `unfinished=${unfinished}/${args.games}`
  );
  if (unfinished > 0) {
    console.warn(
      `WARN: ${unfinished} game(s) hit --max-steps (${args.maxSteps}) without finishing. ` +
        `Increase --max-steps if this rate is high.`
    );
  }
  for (const row of summary) {
    const ciStr = `${(row.winRateCI95.low * 100).toFixed(1)}-${(row.winRateCI95.high * 100).toFixed(1)}%`;
    console.log(
      `${row.strategy.padEnd(8)} ` +
        `games=${row.games.toString().padStart(4)} ` +
        `wins=${row.wins.toString().padStart(4)} ` +
        `winRate=${(row.winRate * 100).toFixed(1)}% (95%CI ${ciStr}) ` +
        `avgScore=${row.averageScore.toFixed(2)} ` +
        `expRank=${row.expectedRank.toFixed(2)} ` +
        `ranks=[${row.rankDist.join(',')}]`
    );
  }
}

main();
