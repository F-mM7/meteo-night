/**
 * confirm-tempochain.ts ― grid 上位 genome を高局数で確証する。
 *
 * optimize-tempochain.ts の grid 評価（候補1席 vs tempoFast 3席 rotate, 共通乱数）を
 * そのまま流用し、指定 idx の genome だけを多局回す。genome は grid の jsonl から idx で引く
 * （jsonl の genome が idx→genome の唯一の真実。999=∞ センチネルもそのまま通す）。
 * games をシャード分割して並列実行できる（i % of === shard を担当）。
 *
 *   1シャード:  npx tsx ai/scripts/confirm-tempochain.ts --idx 12,5,3 --games 1000 --seed 90001 \
 *                 --shard 0 --of 20 --base-la 0 --budget 300 --out /tmp/confirm-s90001
 *
 * 出力（{out}-{shard}.jsonl 各行）: {"idx","seed","baseLA","budget","shard","of","wins","games","genome"}
 * 集約は confirm-aggregate.ts（idx×seed でシャードを合算し Wilson CI）。
 */
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideTempoChain, type TempoChainGenome } from '../../src/ai/tempoChainAI';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { currentActorId, parseIntArg } from './_runner';

type Decider = (s: GameState, p: number) => Action | null;

/** grid jsonl 全シャードから idx→genome を読む（重複は最後勝ち）。 */
function loadGenomes(gridPrefix: string): Map<number, TempoChainGenome> {
  const dir = dirname(gridPrefix);
  const base = basename(gridPrefix);
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.jsonl$`);
  const files = readdirSync(dir).filter((f) => re.test(f));
  const map = new Map<number, TempoChainGenome>();
  for (const f of files) {
    for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { idx: number; genome: TempoChainGenome };
        map.set(r.idx, r.genome);
      } catch {
        /* 部分行は無視 */
      }
    }
  }
  return map;
}

// --- 以下 isWin / playGame は optimize-tempochain.ts と同一（同じ物差しで測るため verbatim）---

function isWin(state: GameState, candSeat: number): boolean {
  const players = state.players;
  let best = 0;
  for (let i = 1; i < players.length; i++) {
    if (players[i].score > players[best].score) best = i;
    else if (players[i].score === players[best].score) {
      const di = (players[i].id - state.startPlayerIndex + players.length) % players.length;
      const db = (players[best].id - state.startPlayerIndex + players.length) % players.length;
      if (di < db) best = i;
    }
  }
  return best === candSeat;
}

function playGame(
  seed: number,
  genome: TempoChainGenome,
  candSeat: number,
  baseBudget: number,
  baseLA: number,
  maxSteps: number
): boolean {
  let state = setupGame({ seed, cpuFlags: [true, true, true, true] });
  const cand: Decider = (s, p) => decideTempoChain(s, p, undefined, genome);
  const base: Decider = (s, p) =>
    decideTempoFast(s, p, undefined, { timeBudgetMs: baseBudget, lookaheadTurns: baseLA });
  const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === candSeat ? cand : base));
  let steps = 0;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = currentActorId(state);
    const a = deciders[actor](state, actor);
    if (!a) break;
    const before = state;
    state = stepGame(state, a);
    if (state === before) break;
    steps++;
  }
  return isWin(state, candSeat);
}

function main(): void {
  const argv = process.argv.slice(2);
  let idxArg = '';
  let games = 1000;
  let seed = 90001;
  let shard = 0;
  let of = 1;
  let budget = 300;
  let baseLA = 0;
  let out = '/tmp/confirm';
  let gridPrefix = '/tmp/opt-grid';
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--idx') idxArg = argv[++i];
    else if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--shard') shard = parseIntArg('--shard', argv[++i]);
    else if (k === '--of') of = parseIntArg('--of', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--base-la') baseLA = parseIntArg('--base-la', argv[++i]);
    else if (k === '--out') out = argv[++i];
    else if (k === '--grid-prefix') gridPrefix = argv[++i];
    else throw new Error(`unknown arg: ${k}`);
  }
  const idxList = idxArg
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseInt(s, 10));
  if (idxList.length === 0) throw new Error('--idx <comma list> が必要');

  const genomes = loadGenomes(gridPrefix);
  for (const idx of idxList) if (!genomes.has(idx)) throw new Error(`idx=${idx} の genome が grid jsonl に無い`);

  const outFile = `${out}-${shard}.jsonl`;
  const maxSteps = 20000;
  const t0 = Date.now();
  // このシャードが担当する game インデックス（i % of === shard）。
  const myGames: number[] = [];
  for (let i = 0; i < games; i++) if (i % of === shard) myGames.push(i);
  console.error(
    `[confirm shard ${shard}/${of}] idx=[${idxList.join(',')}] games=${games}(担当${myGames.length}) seed=${seed} base=tempoFast(LA=${baseLA},budget=${budget})`
  );
  for (const idx of idxList) {
    const genome = genomes.get(idx)!;
    let wins = 0;
    for (const i of myGames) {
      if (playGame(seed + i, genome, i % 4, budget, baseLA, maxSteps)) wins++;
    }
    appendFileSync(
      outFile,
      JSON.stringify({ idx, seed, baseLA, budget, shard, of, wins, games: myGames.length, genome }) + '\n'
    );
    console.error(
      `[confirm shard ${shard}] idx=${idx} wins=${wins}/${myGames.length}  経過${((Date.now() - t0) / 1000).toFixed(0)}s`
    );
  }
  console.error(`[confirm shard ${shard}] 完了 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
