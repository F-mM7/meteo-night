/**
 * 自己対戦ランナー
 *
 * Usage:
 *   npx tsx ai/scripts/selfplay.ts [options]
 *
 * Options:
 *   --games <n>            対戦回数 (default: 10)
 *   --strategies <list>    カンマ区切りで 4 つ (default: smart,smart,smart,smart)
 *   --seed <n>             base seed (default: 42)
 *   --max-steps <n>        1 局あたり安全上限 (default: 5000)
 *   --silent               局ごとのログを抑制
 *   --json                 集計を JSON で出力（パイプ用途）
 *
 * Note: 各局の seed は base + gameIndex を使うため、再現性あり。
 */
import {
  GameResult,
  parseCommonArgs,
  playOneGame,
} from './_runner';

function printUsage(): void {
  console.log(`Usage: tsx ai/scripts/selfplay.ts [options]

Options:
  --games <n>             games per run (default: 10)
  --strategies <list>     comma-separated 4 of: random | smart | mcts | mctsRollout | mctsPuct | mctsTuned (default: smart x4)
  --seed <n>              base seed (default: 42)
  --max-steps <n>         safety bound per game (default: 5000)
  --silent                suppress per-game logs
  --json                  emit JSON summary to stdout`);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }
  const args = parseCommonArgs(argv);

  const results: GameResult[] = [];
  for (let g = 0; g < args.games; g++) {
    const seed = args.seed + g;
    const r = playOneGame({
      seed,
      strategies: args.strategies,
      maxSteps: args.maxSteps,
    });
    results.push(r);
    if (!args.silent && !args.json) {
      const winnerName =
        r.winnerId !== null ? args.strategies[r.winnerId] : 'none';
      console.log(
        `game ${g + 1}/${args.games} seed=${seed} ` +
          `winner=P${r.winnerId}(${winnerName}) ` +
          `scores=[${r.scores.join(',')}] turns=${r.turns} steps=${r.steps} ms=${r.durationMs}`
      );
    }
  }

  const wins = new Array<number>(4).fill(0);
  const rankCount = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const scoreSum = [0, 0, 0, 0];
  let totalSteps = 0;
  let totalMs = 0;
  let unfinished = 0;
  for (const r of results) {
    if (r.winnerId !== null) wins[r.winnerId]++;
    if (!r.finished) unfinished++;
    for (let i = 0; i < 4; i++) {
      rankCount[i][r.ranking[i]]++;
      scoreSum[i] += r.scores[i];
    }
    totalSteps += r.steps;
    totalMs += r.durationMs;
  }

  const summary = {
    games: args.games,
    strategies: args.strategies,
    seedBase: args.seed,
    perPlayer: args.strategies.map((s, i) => ({
      seat: i,
      strategy: s,
      wins: wins[i],
      winRate: args.games > 0 ? wins[i] / args.games : 0,
      averageScore: args.games > 0 ? scoreSum[i] / args.games : 0,
      rankDist: rankCount[i],
    })),
    totalSteps,
    averageStepsPerGame: args.games > 0 ? totalSteps / args.games : 0,
    averageMsPerStep: totalSteps > 0 ? totalMs / totalSteps : 0,
    unfinishedGames: unfinished,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('--- summary ---');
  for (const row of summary.perPlayer) {
    console.log(
      `P${row.seat} ${row.strategy}: ` +
        `wins=${row.wins} (${(row.winRate * 100).toFixed(1)}%) ` +
        `avgScore=${row.averageScore.toFixed(2)} ` +
        `ranks=[1st:${row.rankDist[0]}, 2nd:${row.rankDist[1]}, 3rd:${row.rankDist[2]}, 4th:${row.rankDist[3]}]`
    );
  }
  console.log(
    `total steps=${totalSteps} avgSteps/game=${summary.averageStepsPerGame.toFixed(1)} ` +
      `avgMs/step=${summary.averageMsPerStep.toFixed(3)} ` +
      `unfinished=${unfinished}/${args.games}`
  );
  if (unfinished > 0) {
    console.warn(
      `WARN: ${unfinished} game(s) hit --max-steps (${args.maxSteps}) without finishing.`
    );
  }
}

main();
