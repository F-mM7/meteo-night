/**
 * 人間プレイ棋譜の再生・検証スクリプト。
 *
 * 用途は 2 つ:
 *  1. `--selftest`: AI 同士の対局を記録形式で生成し、初期状態＋手順から再生して
 *     終局結果が一致するかを検証する（直接再生＋JSON 往復再生）。記録基盤の正しさの裏取り。
 *  2. `<records.json>`: ブラウザでエクスポートした棋譜ファイルを読み、各対局を再生して
 *     結果一致を検証しつつ、人間勝率・平均ターン数などの統計を表示する。
 *
 * 例:
 *   npx tsx ai/scripts/replay.ts --selftest --games 30 --seed 1000
 *   npx tsx ai/scripts/replay.ts ~/Downloads/meteo-night-games-12.json
 */
import { readFileSync } from 'node:fs';
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import {
  CURRENT_RECORD_VERSION,
  extractResult,
  humanSeatsOf,
  isDecisionAction,
  replayRecord,
  stripStateForRecording,
  type GameRecord,
  type RecordedResult,
} from '../../src/game/recording';
import {
  STRATEGIES,
  currentActorId,
  isStrategyName,
  parseIntArg,
  DEFAULT_MAX_STEPS,
  type StrategyName,
} from './_runner';

function resultsMatch(a: RecordedResult, b: RecordedResult): boolean {
  return (
    a.winnerId === b.winnerId &&
    a.turns === b.turns &&
    a.finished === b.finished &&
    a.scores.length === b.scores.length &&
    a.scores.every((s, i) => s === b.scores[i])
  );
}

/**
 * AI 同士の対局を 1 局プレイし、ブラウザ記録と同じ形式の `GameRecord` を返す。
 * 記録するのは意思決定アクションのみ（`stepGame` が連鎖解決を内部で吸収するため
 * `RESOLVE_COMBOS` は現れない）。selftest 用に `recordedAt` は固定値にする。
 */
function recordOneGame(
  seed: number,
  strategies: StrategyName[],
  cpuFlags: boolean[]
): GameRecord {
  const deciders = strategies.map((s) => STRATEGIES[s]);
  let state: GameState = setupGame({ seed, cpuFlags });
  const initialState = stripStateForRecording(state);
  const actions: Action[] = [];

  let steps = 0;
  while (state.phase !== 'gameOver' && steps < DEFAULT_MAX_STEPS) {
    const actorId = currentActorId(state);
    const action = deciders[actorId](state, actorId);
    if (!action) break;
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    if (isDecisionAction(action)) actions.push(action);
    steps++;
  }

  return {
    version: CURRENT_RECORD_VERSION,
    initialState,
    actions,
    result: extractResult(state),
    humanSeats: humanSeatsOf(state),
    recordedAt: '1970-01-01T00:00:00.000Z',
  };
}

function selftest(numGames: number, seedBase: number, strategies: StrategyName[]): void {
  // 席 0 を人間に見立てて humanSeats 抽出も併せて検証する（着手自体は AI が代行）。
  const cpuFlags = [false, true, true, true];
  let pass = 0;
  let fail = 0;

  for (let i = 0; i < numGames; i++) {
    const seed = seedBase + i;
    const rec = recordOneGame(seed, strategies, cpuFlags);

    const direct = replayRecord(rec);
    // ブラウザの保存経路（JSON シリアライズ往復）を模擬する。
    const roundtrip: GameRecord = JSON.parse(JSON.stringify(rec));
    const viaJson = replayRecord(roundtrip);

    const okDirect = resultsMatch(rec.result, extractResult(direct.state));
    const okJson = resultsMatch(rec.result, extractResult(viaJson.state));
    const okHuman = rec.humanSeats.length === 1 && rec.humanSeats[0] === 0;
    const okNoop = direct.noopCount === 0 && viaJson.noopCount === 0;

    if (okDirect && okJson && okHuman && okNoop) {
      pass++;
    } else {
      fail++;
      console.log(
        `FAIL seed=${seed} direct=${okDirect} json=${okJson} human=${okHuman} ` +
          `noop(direct=${direct.noopCount},json=${viaJson.noopCount}) actions=${rec.actions.length} ` +
          `finished=${rec.result.finished}`
      );
    }
  }

  console.log(
    `\nselftest: ${pass}/${numGames} passed (${fail} failed) ` +
      `[strategies=${strategies.join(',')}, seed=${seedBase}..${seedBase + numGames - 1}]`
  );
  if (fail > 0) process.exit(1);
}

function verifyFile(path: string): void {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('記録ファイルは GameRecord の配列である必要があります');
  }
  const games = parsed as GameRecord[];
  const n = games.length;
  if (n === 0) {
    console.log('記録は 0 局です');
    return;
  }

  let matched = 0;
  let mismatched = 0;
  let noopTotal = 0;
  let humanWins = 0;
  let decidedGames = 0;
  let totalTurns = 0;
  let totalActions = 0;

  for (let i = 0; i < n; i++) {
    const g = games[i];
    if (g.version !== CURRENT_RECORD_VERSION) {
      console.log(`#${i}: 未知のバージョン ${g.version}（スキップ）`);
      continue;
    }
    const { state, noopCount } = replayRecord(g);
    noopTotal += noopCount;
    if (resultsMatch(g.result, extractResult(state))) {
      matched++;
    } else {
      mismatched++;
      console.log(
        `不一致 #${i}: recorded=${JSON.stringify(g.result)} ` +
          `replayed=${JSON.stringify(extractResult(state))}`
      );
    }
    if (g.result.winnerId !== null) {
      decidedGames++;
      if (g.humanSeats.includes(g.result.winnerId)) humanWins++;
    }
    totalTurns += g.result.turns;
    totalActions += g.actions.length;
  }

  console.log(`検証: ${matched}/${n} 一致 (${mismatched} 不一致), no-op 合計 ${noopTotal}`);
  if (decidedGames > 0) {
    console.log(
      `人間勝利: ${humanWins}/${decidedGames} ` +
        `(${((100 * humanWins) / decidedGames).toFixed(1)}%)`
    );
  }
  console.log(
    `平均ターン数: ${(totalTurns / n).toFixed(1)}, 平均手数: ${(totalActions / n).toFixed(1)}`
  );
  if (mismatched > 0) process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  let selftestMode = false;
  let games = 20;
  let seed = 1000;
  let file: string | undefined;
  let strategies: StrategyName[] = ['tempo', 'smart', 'smart', 'smart'];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--selftest':
        selftestMode = true;
        break;
      case '--games':
        games = parseIntArg('--games', argv[++i]);
        break;
      case '--seed':
        seed = parseIntArg('--seed', argv[++i]);
        break;
      case '--file':
        file = argv[++i];
        break;
      case '--strategies': {
        const raw = argv[++i];
        if (raw === undefined) throw new Error('--strategies requires a value');
        const list = raw.split(',');
        if (list.length !== 4 || !list.every(isStrategyName)) {
          throw new Error('--strategies must be 4 comma-separated valid strategies');
        }
        strategies = list as StrategyName[];
        break;
      }
      default:
        if (!a.startsWith('--')) {
          file = a;
        } else {
          throw new Error(`unknown arg: ${a}`);
        }
    }
  }

  if (selftestMode) {
    selftest(games, seed, strategies);
  } else if (file) {
    verifyFile(file);
  } else {
    console.log(
      'usage:\n' +
        '  tsx ai/scripts/replay.ts --selftest [--games N] [--seed S] [--strategies a,b,c,d]\n' +
        '  tsx ai/scripts/replay.ts <records.json>'
    );
    process.exit(1);
  }
}

main();
