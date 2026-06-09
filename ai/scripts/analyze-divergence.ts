/**
 * 同一局面での「人間の配置選択」と「最強AI(tempoFastAI)の配置選択」の突き合わせ分析。
 *
 * 人間棋譜を人間の実手で進めつつ、人間の各配置手番で AI に同じ局面を解かせ、
 * 「人間は伸ばす／AIは即発火」の乖離を定量化する。弱点の核（即発火偏重）を実証する。
 *
 *   npx tsx ai/scripts/analyze-divergence.ts <records.json> [...] [--budget 400]
 */
import { readFileSync } from 'node:fs';
import { stepGame } from '../../src/game/reducer';
import { decideAction } from '../../src/ai/tempoFastAI';
import { currentActorId, parseIntArg } from './_runner';
import { DEFAULT_WEIGHTS, type EvalWeights } from '../../src/ai/evaluator';
import type { GameRecord } from '../../src/game/recording';
import type { Action, GameState } from '../../src/game/types';

const AI_SEED = 987654321;

function sameAction(a: Action, b: Action | null): boolean {
  if (!b || a.type !== b.type) return false;
  switch (a.type) {
    case 'PLACE_DRAWN':
      return b.type === 'PLACE_DRAWN' && a.slotIndex === b.slotIndex && a.cardId === b.cardId;
    case 'PLACE_ADDITIONAL_DRAW':
      return b.type === 'PLACE_ADDITIONAL_DRAW' && a.slotIndex === b.slotIndex;
    default:
      return true;
  }
}

/** 手 a を局面 s に適用したときに起きた即時コンボ（連鎖込み、ギフト前で停止）。 */
function fireOf(s: GameState, a: Action): { fired: boolean; base: number; maxSize: number } {
  const before = s.turn.combosThisTurn.length;
  const after = stepGame(s, a);
  const combos = after.turn.combosThisTurn;
  if (combos.length <= before) return { fired: false, base: 0, maxSize: 0 };
  let base = 0;
  let maxSize = 0;
  for (let k = before; k < combos.length; k++) {
    base += combos[k].basePoints;
    maxSize = Math.max(maxSize, combos[k].cards.length);
  }
  return { fired: true, base, maxSize };
}

/** 手 a 適用後の actor 盤面で、最上段が同色のスロット数の最大（大コンボへの近さ）。 */
function maxReachAfter(s: GameState, a: Action, actor: number): number {
  const after = stepGame(s, a);
  const cnt = new Map<string, number>();
  for (const slot of after.players[actor].board.slots) {
    const top = slot.stack[slot.stack.length - 1];
    if (top) cnt.set(top.color, (cnt.get(top.color) ?? 0) + 1);
  }
  let mx = 0;
  for (const v of cnt.values()) mx = Math.max(mx, v);
  return mx;
}

function main(): void {
  const argv = process.argv.slice(2);
  const paths: string[] = [];
  let budget = 400;
  let weights: EvalWeights | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (argv[i] === '--weights') weights = { ...DEFAULT_WEIGHTS, ...JSON.parse(argv[++i]) };
    else if (!argv[i].startsWith('--')) paths.push(argv[i]);
    else throw new Error(`unknown arg: ${argv[i]}`);
  }
  if (paths.length === 0) {
    console.log('usage: tsx ai/scripts/analyze-divergence.ts <records.json> [...] [--budget 400]');
    process.exit(1);
  }

  const records: GameRecord[] = [];
  for (const p of paths) {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${p} は GameRecord 配列ではありません`);
    records.push(...(parsed as GameRecord[]));
  }

  let placements = 0;
  let agree = 0;
  let humanFire = 0;
  let aiFire = 0;
  let humanBaseSum = 0;
  let aiBaseSum = 0;
  let humanSizeSum = 0;
  let aiSizeSum = 0;
  let humanNoFireAiFire = 0; // 人間は伸ばす / AI は即発火
  let aiNoFireHumanFire = 0; // 人間は即発火 / AI は伸ばす
  let bothFireAiSmaller = 0;
  let bothFireHumanSmaller = 0;
  let bothNoFireN = 0;
  let humanReachSum = 0;
  let aiReachSum = 0;

  const t0 = Date.now();
  for (const rec of records) {
    const humanSeats = new Set(rec.humanSeats);
    let s = rec.initialState;
    for (const aHuman of rec.actions) {
      const actor = currentActorId(s);
      const isHuman = humanSeats.has(actor);
      const relevant = aHuman.type === 'PLACE_DRAWN' || aHuman.type === 'PLACE_ADDITIONAL_DRAW';
      if (isHuman && relevant) {
        const aiMove = decideAction(s, actor, AI_SEED, { timeBudgetMs: budget, weights });
        placements++;
        if (sameAction(aHuman, aiMove)) agree++;
        const fh = fireOf(s, aHuman);
        const fa = aiMove ? fireOf(s, aiMove) : { fired: false, base: 0, maxSize: 0 };
        if (fh.fired) {
          humanFire++;
          humanBaseSum += fh.base;
          humanSizeSum += fh.maxSize;
        }
        if (fa.fired) {
          aiFire++;
          aiBaseSum += fa.base;
          aiSizeSum += fa.maxSize;
        }
        if (!fh.fired && fa.fired) humanNoFireAiFire++;
        if (fh.fired && !fa.fired) aiNoFireHumanFire++;
        if (fh.fired && fa.fired) {
          if (fa.maxSize < fh.maxSize) bothFireAiSmaller++;
          else if (fh.maxSize < fa.maxSize) bothFireHumanSmaller++;
        }
        if (!fh.fired && !fa.fired && aiMove) {
          bothNoFireN++;
          humanReachSum += maxReachAfter(s, aHuman, actor);
          aiReachSum += maxReachAfter(s, aiMove, actor);
        }
      }
      s = stepGame(s, aHuman);
    }
  }

  const pct = (a: number, b: number) => (b === 0 ? '  -  ' : `${((100 * a) / b).toFixed(1)}%`);
  const avg = (sum: number, n: number) => (n === 0 ? '0.00' : (sum / n).toFixed(2));

  console.log(
    `\n=== 同一局面での配置選択: 人間 vs AI(tempoFast budget=${budget}ms${weights ? '・候補重み' : ''}) ===`
  );
  console.log(`対象配置手番: ${placements}  (所要 ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  console.log(`手の一致率: ${agree}/${placements} (${pct(agree, placements)})`);
  console.log(`\n即発火率:       人間 ${pct(humanFire, placements)}    AI ${pct(aiFire, placements)}`);
  console.log(`発火時 平均base点:  人間 ${avg(humanBaseSum, humanFire)}    AI ${avg(aiBaseSum, aiFire)}`);
  console.log(`発火時 平均最大size: 人間 ${avg(humanSizeSum, humanFire)}    AI ${avg(aiSizeSum, aiFire)}`);
  console.log(`\n乖離（同一局面）:`);
  console.log(`  人間は非発火 / AIは即発火: ${humanNoFireAiFire} 件 (${pct(humanNoFireAiFire, placements)})  ← AIが即発火に飛びつく`);
  console.log(`  人間は即発火 / AIは非発火: ${aiNoFireHumanFire} 件 (${pct(aiNoFireHumanFire, placements)})`);
  console.log(`  両者発火 / AIのほうが小size: ${bothFireAiSmaller} 件`);
  console.log(`  両者発火 / 人間のほうが小size: ${bothFireHumanSmaller} 件`);
  console.log(`\n両者とも非発火の局面(${bothNoFireN}件)での配置後・最大同色リーチ:`);
  console.log(
    `  人間 ${avg(humanReachSum, bothNoFireN)}    AI ${avg(aiReachSum, bothNoFireN)}  （高いほど大コンボに近い盤面を作る）`
  );
}

main();
