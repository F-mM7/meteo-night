/**
 * optimize-tempochain.ts ― tempoChainAI の genome grid を並列評価する。
 *
 * 戦略空間（fiveChain↔tempoFast↔ハイブリッド）を grid 化し、各 genome を
 * 「候補1席 vs tempoFast 3席（rotate）」で N 局回して勝率を測る。シャード分割して 24 コアで並列実行。
 *
 *   1シャード:  npx tsx ai/scripts/optimize-tempochain.ts --shard 0 --of 20 --games 64 --seed 80001 --out /tmp/opt
 *   全シャードは launch スクリプトで並列起動し、--out の {shard}.jsonl を集約する。
 *
 * 出力（{out}-{shard}.jsonl の各行）: {"idx":N,"wins":W,"games":G,"genome":{...}}
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideTempoChain, type TempoChainGenome } from '../../src/ai/tempoChainAI';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { currentActorId, parseIntArg } from './_runner';

type Decider = (s: GameState, p: number) => Action | null;
const NEVER = 999; // ∞ の代わり（JSON 安全・スコアは届かない）

function buildGrid(): TempoChainGenome[] {
  const out: TempoChainGenome[] = [];
  const fireTargets = [2, 3, 4, 5];
  const blends = [0, 0.25, 0.5, 0.75, 1.0];
  const distModes = ['expected', 'worstcase'] as const;
  const lateConfigs = [
    { lt: NEVER, drop: 0 },
    { lt: 12, drop: 2 },
    { lt: 15, drop: 2 },
    { lt: 12, drop: 1 },
    { lt: 15, drop: 3 },
  ];
  const fullThs = [NEVER, 13];
  for (const fireTarget of fireTargets)
    for (const buildTempoBlend of blends)
      for (const distanceMode of distModes)
        for (const lc of lateConfigs)
          for (const fullThreshold of fullThs)
            out.push({
              fireTarget,
              fireTargetLate: Math.max(1, fireTarget - lc.drop),
              lateThreshold: lc.lt,
              fullThreshold,
              buildTempoBlend,
              distanceMode,
              nodeLimit: 15000,
            });
  return out;
}

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
  let shard = 0;
  let of = 1;
  let games = 64;
  let seed = 80001;
  let budget = 300;
  let baseLA = 0;
  let out = '/tmp/opt';
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--shard') shard = parseIntArg('--shard', argv[++i]);
    else if (k === '--of') of = parseIntArg('--of', argv[++i]);
    else if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--base-la') baseLA = parseIntArg('--base-la', argv[++i]);
    else if (k === '--out') out = argv[++i];
    else throw new Error(`unknown arg: ${k}`);
  }
  const grid = buildGrid();
  const outFile = `${out}-${shard}.jsonl`;
  const maxSteps = 20000;
  const t0 = Date.now();
  let done = 0;
  const mine = grid.map((g, idx) => ({ g, idx })).filter((x) => x.idx % of === shard);
  const doneIdx = new Set<number>();
  if (existsSync(outFile)) {
    for (const line of readFileSync(outFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        doneIdx.add((JSON.parse(line) as { idx: number }).idx);
      } catch {
        /* 部分行は無視 */
      }
    }
  }
  console.error(`[shard ${shard}/${of}] grid=${grid.length} 担当=${mine.length} 既済=${doneIdx.size} games=${games} seed=${seed} base=tempoFast(LA=${baseLA})`);
  for (const { g, idx } of mine) {
    if (doneIdx.has(idx)) continue;
    let wins = 0;
    for (let i = 0; i < games; i++) {
      if (playGame(seed + i, g, i % 4, budget, baseLA, maxSteps)) wins++;
    }
    appendFileSync(outFile, JSON.stringify({ idx, wins, games, genome: g }) + '\n');
    done++;
    if (done % 2 === 0 || done === mine.length) {
      console.error(`[shard ${shard}] ${done}/${mine.length}  idx=${idx} wins=${wins}/${games}  経過${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
  console.error(`[shard ${shard}] 完了 ${done}件 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
