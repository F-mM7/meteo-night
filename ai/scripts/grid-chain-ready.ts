/**
 * Gen-3-W 用 grid: mcts の評価関数に「連鎖準備度」 加点 `chainReadyMult` を入れた版が、
 * default mcts（Gen-3-O）3 体相手の自己対戦で勝ち越せるかを測る。
 *
 * 学習側 seat = mcts(weights={...DEFAULT, chainReadyMult: c})、 対戦相手 3 体 = default mcts。
 * 座席ローテーション付き。 学習側勝率 > 25% なら「連鎖準備度を入れた方が強い」。
 *
 * Usage:
 *   npx tsx ai/scripts/grid-chain-ready.ts --games 80 --seed 1001 --grid 0,50,100,200,400 --json
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { GameState } from '../../src/game/types';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';
import { DEFAULT_WEIGHTS, type EvalWeights } from '../../src/ai/evaluator';
import { parseIntArg } from './_runner';
import { expectedRankFromRankCount, wilsonInterval } from './stats';

interface CandidateStat {
  c: number;
  games: number;
  wins: number;
  scoreSum: number;
  rankCount: [number, number, number, number];
  totalSteps: number;
  totalMs: number;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {
    games: 80,
    seed: 1001,
    grid: [0, 50, 100, 200, 400] as number[],
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--games') out.games = parseIntArg('--games', argv[++i]);
    else if (a === '--seed') out.seed = parseIntArg('--seed', argv[++i]);
    else if (a === '--grid') {
      const raw = argv[++i];
      if (raw === undefined) throw new Error('--grid requires a value');
      out.grid = raw.split(',').map((s) => Number(s.trim()));
      if (out.grid.some((v) => !Number.isFinite(v) || v < 0)) throw new Error('--grid must be non-negative');
    } else if (a === '--json') out.json = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

function currentActorId(state: GameState): number {
  if (state.phase === 'awaitingGiftPlacement' && state.turn.pendingGiftBatches.length > 0) {
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
  ordered.forEach((p, i) => { rank[p.id] = i; });
  return rank;
}

function playGame(seed: number, learnerSeat: number, learnerWeights: EvalWeights): {
  winnerId: number | null; scores: number[]; ranking: number[]; steps: number; durationMs: number; finished: boolean;
} {
  const t0 = Date.now();
  let state: GameState = setupGame({
    seed,
    playerNames: [0, 1, 2, 3].map((i) => (i === learnerSeat ? 'learner' : `def${i}`)),
    cpuFlags: [true, true, true, true],
  });
  let steps = 0;
  while (state.phase !== 'gameOver' && steps < 20000) {
    const actor = currentActorId(state);
    const action = actor === learnerSeat
      ? decideMcts(state, actor, undefined, { weights: learnerWeights })
      : decideMcts(state, actor, undefined, {}); // default 重み
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

function main() {
  const args = parseArgs();
  const results: CandidateStat[] = [];
  for (const c of args.grid) {
    const weights: EvalWeights = { ...DEFAULT_WEIGHTS, chainReadyMult: c };
    const stat: CandidateStat = { c, games: 0, wins: 0, scoreSum: 0, rankCount: [0, 0, 0, 0], totalSteps: 0, totalMs: 0 };
    process.stderr.write(`[grid] chainReadyMult=${c.toString().padStart(4)} running ${args.games} games... `);
    const tStart = Date.now();
    for (let g = 0; g < args.games; g++) {
      const seed = args.seed + g;
      const learnerSeat = g % 4; // ローテーションで全席を均等に
      const r = playGame(seed, learnerSeat, weights);
      stat.games += 1;
      stat.scoreSum += r.scores[learnerSeat];
      stat.rankCount[r.ranking[learnerSeat]] += 1;
      if (r.winnerId === learnerSeat) stat.wins += 1;
      stat.totalSteps += r.steps;
      stat.totalMs += r.durationMs;
    }
    const ci = wilsonInterval(stat.wins, stat.games);
    const expRank = expectedRankFromRankCount(stat.rankCount, Math.max(1, stat.games));
    process.stderr.write(
      `wr=${(stat.wins / stat.games * 100).toFixed(1)}% (CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) ` +
      `avgScore=${(stat.scoreSum / stat.games).toFixed(2)} expRank=${expRank.toFixed(2)} ranks=[${stat.rankCount.join(',')}] ` +
      `wallSec=${((Date.now() - tStart) / 1000).toFixed(1)}s\n`
    );
    results.push(stat);
  }
  const sorted = [...results].sort((a, b) => (b.wins !== a.wins ? b.wins - a.wins : b.scoreSum - a.scoreSum));
  if (args.json) {
    console.log(JSON.stringify({
      games: args.games, seed: args.seed,
      candidates: results.map((s) => ({
        chainReadyMult: s.c, games: s.games, wins: s.wins, winRate: s.wins / s.games,
        winRateCI95: wilsonInterval(s.wins, s.games),
        averageScore: s.scoreSum / s.games,
        expectedRank: expectedRankFromRankCount(s.rankCount, Math.max(1, s.games)),
        rankDist: s.rankCount,
      })),
      best: { chainReadyMult: sorted[0].c, wins: sorted[0].wins },
      baseline: '25% = 互角（learner 1 vs default mcts 3）',
    }, null, 2));
    return;
  }
  console.log(`\nbest chainReadyMult: ${sorted[0].c} (wins=${sorted[0].wins}/${sorted[0].games}) [25%=互角]`);
}

main();
