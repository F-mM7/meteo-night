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
 *   --max-steps <n>        1 局あたり安全上限 (default: 20000)
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
  makeMctsWithOpts,
  parseCommonArgs,
  parseIntArg,
  playOneGame,
  rotateSeats,
  STRATEGIES,
  StrategyName,
} from './_runner';
import { expectedRankFromRankCount, wilsonInterval } from './stats';
import { setEvalWeights, type EvalWeights } from '../../src/ai/evaluator';
import type { MctsOptions } from '../../src/ai/mctsAI';

interface StratStat {
  games: number;
  wins: number;
  scoreSum: number;
  rankCount: [number, number, number, number];
}

function newStratStat(): StratStat {
  return { games: 0, wins: 0, scoreSum: 0, rankCount: [0, 0, 0, 0] };
}

function printUsage(): void {
  console.log(`Usage: tsx ai/scripts/bench.ts [options]

Options:
  --games <n>             games per run (default: 200)
  --strategies <list>     4 of: random | smart | mcts | mctsRollout | mctsPuct | mctsTuned (default: smart,random,random,random)
  --seed <n>              base seed (default: 1)
  --rotate                rotate seats each game (removes seat bias)
  --max-steps <n>         safety bound per game (default: 20000)
  --silent                suppress per-game logs
  --json                  emit JSON summary to stdout
  --weights <path>        load EvalWeights from JSON for ALL AIs (global state)
  --mcts-weights <path>   load EvalWeights from JSON for mcts ONLY (per-AI, Gen-3-J)
  --mcts-uct <n>          override mcts uctC (default: 1.7, Gen-3-O)
  --mcts-iter <n>         override mcts iterations (default: 800, Gen-3-O)
  --mcts-eval-scale <n>   override mcts leafEvalScale (default: 1500, Gen-3-L)
  --mcts-terminal <mode>  override mcts terminal value mode: rank | winLoss (default: rank, Gen-3-T)`);
}

function loadWeightsFromFile(path: string): EvalWeights {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  return parsed.weights ?? parsed;
}

/**
 * `--weights <path>`: ベンチ全体（全 AI）の評価関数重みを差し替える。
 *                     evaluator のモジュール global state を変える。
 * `--mcts-weights <path>`: mcts 戦略のみ独立した重みで動かす。smart など他の AI は default のまま。
 *                          Gen-3-J 以降の per-AI weights 検証用。
 * `--mcts-uct <n>`: mcts のみ uctC を上書き。Gen-3-L 探索ハイパラ調整用。
 * `--mcts-iter <n>`: mcts のみ iterations を上書き。Gen-3-O joint grid 検証用。
 * `--mcts-eval-scale <n>`: mcts のみ leafEvalScale を上書き。Gen-3-L 用。
 *
 * --mcts-weights と --mcts-uct / --mcts-iter / --mcts-eval-scale は同時指定可。
 */
function loadWeightsArg(argv: string[]): string[] {
  let next = argv;

  const widx = next.indexOf('--weights');
  if (widx >= 0) {
    const path = next[widx + 1];
    if (!path) throw new Error('--weights requires a path argument');
    setEvalWeights(loadWeightsFromFile(path));
    console.error(`[bench] loaded weights (global) from ${path}`);
    next = [...next.slice(0, widx), ...next.slice(widx + 2)];
  }

  const mctsOpts: MctsOptions = {};
  let mctsOptsChanged = false;

  const mwidx = next.indexOf('--mcts-weights');
  if (mwidx >= 0) {
    const path = next[mwidx + 1];
    if (!path) throw new Error('--mcts-weights requires a path argument');
    mctsOpts.weights = loadWeightsFromFile(path);
    mctsOptsChanged = true;
    console.error(`[bench] mcts weights loaded from ${path}`);
    next = [...next.slice(0, mwidx), ...next.slice(mwidx + 2)];
  }

  const muctIdx = next.indexOf('--mcts-uct');
  if (muctIdx >= 0) {
    const v = Number(next[muctIdx + 1]);
    if (!Number.isFinite(v)) throw new Error('--mcts-uct requires a finite number');
    mctsOpts.uctC = v;
    mctsOptsChanged = true;
    console.error(`[bench] mcts uctC overridden to ${v}`);
    next = [...next.slice(0, muctIdx), ...next.slice(muctIdx + 2)];
  }

  const miterIdx = next.indexOf('--mcts-iter');
  if (miterIdx >= 0) {
    const v = parseIntArg('--mcts-iter', next[miterIdx + 1]);
    if (v <= 0) throw new Error('--mcts-iter requires a positive integer');
    mctsOpts.iterations = v;
    mctsOptsChanged = true;
    console.error(`[bench] mcts iterations overridden to ${v}`);
    next = [...next.slice(0, miterIdx), ...next.slice(miterIdx + 2)];
  }

  const mscaleIdx = next.indexOf('--mcts-eval-scale');
  if (mscaleIdx >= 0) {
    const v = Number(next[mscaleIdx + 1]);
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error('--mcts-eval-scale requires a positive number');
    }
    mctsOpts.leafEvalScale = v;
    mctsOptsChanged = true;
    console.error(`[bench] mcts leafEvalScale overridden to ${v}`);
    next = [...next.slice(0, mscaleIdx), ...next.slice(mscaleIdx + 2)];
  }

  const mtermIdx = next.indexOf('--mcts-terminal');
  if (mtermIdx >= 0) {
    const v = next[mtermIdx + 1];
    if (v !== 'rank' && v !== 'winLoss') {
      throw new Error('--mcts-terminal requires: rank | winLoss');
    }
    mctsOpts.terminalValueMode = v;
    mctsOptsChanged = true;
    console.error(`[bench] mcts terminalValueMode overridden to ${v}`);
    next = [...next.slice(0, mtermIdx), ...next.slice(mtermIdx + 2)];
  }

  if (mctsOptsChanged) {
    STRATEGIES.mcts = makeMctsWithOpts(mctsOpts);
  }

  return next;
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
    // 既存挙動: games=0 のときは 0 を返す（ゼロ除算を避けるための if ガードを保つ）。
    const expRank = st.games > 0 ? expectedRankFromRankCount(st.rankCount, st.games) : 0;
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
