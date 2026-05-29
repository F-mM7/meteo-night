/**
 * Gen-3-T 用 head-to-head: 終局価値モード `winLoss` と `rank` を直接対決させる。
 *
 * vs smart では mcts が圧勝するため終局配点の違いが洗い流される（Gen-3-T 検証で確認）。
 * 「1 位のみを目的にする」 winLoss が効くのは強い相手との接戦のはずなので、
 * winLoss-mcts 1 体 vs rank-mcts 3 体（座席ローテーション付き）で勝率を測る。
 *
 * winLoss 側の勝率が 25% を有意に上回れば「同等の強さの相手に対して winLoss が強い」。
 *
 * Usage:
 *   npx tsx ai/scripts/hh-terminal.ts --games 200 --seed 7001 --json
 *
 * Options:
 *   --games <n>   総局数 (default: 200)
 *   --seed <n>    base seed (default: 7001)
 *   --no-rotate   座席ローテーションを止める（default: 有効）
 *   --json        JSON 出力
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import {
  decideAction as decideMcts,
  type TerminalValueMode,
} from '../../src/ai/mctsAI';
import { parseIntArg } from './_runner';
import { expectedRankFromRankCount, wilsonInterval } from './stats';

interface Args {
  games: number;
  seed: number;
  rotate: boolean;
  json: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { games: 200, seed: 7001, rotate: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--games':
        out.games = parseIntArg('--games', argv[++i]);
        break;
      case '--seed':
        out.seed = parseIntArg('--seed', argv[++i]);
        break;
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

function decideByMode(state: GameState, pid: number, mode: TerminalValueMode): Action | null {
  return decideMcts(state, pid, undefined, { terminalValueMode: mode });
}

function playGame(
  seed: number,
  seatModes: TerminalValueMode[]
): { winnerId: number | null; ranking: number[]; scores: number[]; finished: boolean } {
  let state: GameState = setupGame({
    seed,
    playerNames: seatModes.map((m, i) => `P${i}-${m}`),
    cpuFlags: seatModes.map(() => true),
  });
  let steps = 0;
  const maxSteps = 20000;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = currentActorId(state);
    const action = decideByMode(state, actor, seatModes[actor]);
    if (!action) break;
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    steps++;
  }
  return {
    winnerId: state.winnerId,
    ranking: computeRanking(state),
    scores: state.players.map((p) => p.score),
    finished: state.phase === 'gameOver',
  };
}

function main(): void {
  const args = parseArgs();
  // 基本配置: seat 0 = winLoss、 seats 1-3 = rank。 rotate で winLoss が各座席を均等に回る。
  const base: TerminalValueMode[] = ['winLoss', 'rank', 'rank', 'rank'];

  let winLossWins = 0;
  let winLossScoreSum = 0;
  const winLossRankCount = [0, 0, 0, 0];
  let unfinished = 0;

  for (let g = 0; g < args.games; g++) {
    const seed = args.seed + g;
    const rot = args.rotate ? g % 4 : 0;
    const seatModes = base.map((_, i) => base[(i - rot + 4) % 4]);
    const winLossSeat = seatModes.indexOf('winLoss');
    const r = playGame(seed, seatModes);
    if (!r.finished) unfinished++;
    winLossScoreSum += r.scores[winLossSeat];
    winLossRankCount[r.ranking[winLossSeat]]++;
    if (r.winnerId === winLossSeat) winLossWins++;
  }

  const ci = wilsonInterval(winLossWins, args.games);
  const expRank = expectedRankFromRankCount(winLossRankCount, args.games);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          games: args.games,
          seed: args.seed,
          rotate: args.rotate,
          winLoss: {
            wins: winLossWins,
            winRate: winLossWins / args.games,
            winRateCI95: ci,
            averageScore: winLossScoreSum / args.games,
            expectedRank: expRank,
            rankDist: winLossRankCount,
          },
          baseline: 'winLoss x1 vs rank x3 (rotated). 25% = 互角',
          unfinishedGames: unfinished,
        },
        null,
        2
      )
    );
    return;
  }

  console.log('--- head-to-head: winLoss x1 vs rank x3 (rotated) ---');
  console.log(
    `games=${args.games} winLoss winRate=${((winLossWins / args.games) * 100).toFixed(1)}% ` +
      `(CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) ` +
      `avgScore=${(winLossScoreSum / args.games).toFixed(2)} expRank=${expRank.toFixed(2)} ` +
      `ranks=[${winLossRankCount.join(',')}] unfinished=${unfinished}`
  );
  console.log('25% = 互角。 これを有意に上回れば winLoss が rank より強い。');
}

main();
