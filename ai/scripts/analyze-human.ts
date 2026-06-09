/**
 * 人間プレイ棋譜の俯瞰分析。
 *
 * 棋譜を再生し、手番主体（人間=humanSeats / AI=他席）別に着手傾向・コンボ・ギフトを集計して
 * 「人間（上位教師）の打ち方が最強AIと何が違うか」を炙り出す。弱点診断の入口。
 *
 *   npx tsx ai/scripts/analyze-human.ts <records.json> [<records2.json> ...]
 */
import { readFileSync } from 'node:fs';
import { stepGame } from '../../src/game/reducer';
import { basePointsForSize } from '../../src/game/scoring';
import { currentActorId } from './_runner';
import type { GameRecord } from '../../src/game/recording';
import type { GameState } from '../../src/game/types';

interface Agg {
  turns: number; // 手番数（ドロー回数で近似）
  drawField: number;
  drawDeck: number;
  addDraw: number; // コンボ後に追加ドローを選んだ回数
  addDiscard: number; // コンボ後に取り除きを選んだ回数
  comboBySize: Map<number, number>;
  giftAssigned: number; // ギフトで相手に配った枚数
  giftDiscarded: number; // ギフトで捨てた枚数
  giftTargetRankSum: number; // 配布先のスコア順位合計（1=首位）
  giftTargetN: number;
}

function newAgg(): Agg {
  return {
    turns: 0,
    drawField: 0,
    drawDeck: 0,
    addDraw: 0,
    addDiscard: 0,
    comboBySize: new Map(),
    giftAssigned: 0,
    giftDiscarded: 0,
    giftTargetRankSum: 0,
    giftTargetN: 0,
  };
}

/** プレイヤーのスコア順位（1=首位、同点は同順位の最小値扱い）。 */
function scoreRank(state: GameState, playerId: number): number {
  const target = state.players[playerId].score;
  let higher = 0;
  for (const p of state.players) if (p.score > target) higher++;
  return higher + 1;
}

function comboPoints(comboBySize: Map<number, number>): number {
  let pts = 0;
  for (const [size, n] of comboBySize) pts += basePointsForSize(size) * n;
  return pts;
}

function sizeRow(label: string, m: Map<number, number>, turns: number): string {
  const per100 = (size: number) => (((m.get(size) ?? 0) / turns) * 100).toFixed(1);
  // size 6+ はまとめる
  let sixPlus = 0;
  for (const [s, n] of m) if (s >= 6) sixPlus += n;
  const six100 = ((sixPlus / turns) * 100).toFixed(1);
  return `  ${label.padEnd(10)} 3:${per100(3).padStart(5)}  4:${per100(4).padStart(5)}  5:${per100(5).padStart(5)}  6+:${six100.padStart(5)}`;
}

function analyze(records: GameRecord[]): void {
  const human = newAgg();
  const ai = newAgg();

  let humanWins = 0;
  let winGames = 0;
  let lossGames = 0;
  const comboSizeWin = new Map<number, number>(); // 人間勝局での人間コンボ（1局あたり後で割る）
  const comboSizeLoss = new Map<number, number>();
  let humanScoreSum = 0;

  for (const rec of records) {
    const humanSeats = new Set(rec.humanSeats);
    let state = rec.initialState;
    let prevComboCount = 0;
    const perGameHumanCombo = new Map<number, number>();

    for (const action of rec.actions) {
      const turnPlayer = currentActorId(state); // 操作主体（ギフト配置時は受領者）
      const isHuman = humanSeats.has(turnPlayer);
      const agg = isHuman ? human : ai;

      switch (action.type) {
        case 'DRAW_FROM_FIELD':
          agg.drawField++;
          agg.turns++;
          break;
        case 'DRAW_FROM_DECK':
          agg.drawDeck++;
          agg.turns++;
          break;
        case 'CHOOSE_ADDITIONAL_DRAW':
          agg.addDraw++;
          break;
        case 'DISCARD_TOP':
          // 取り除きは AI が CHOOSE_ADDITIONAL_DISCARD 経由、人間は直接 DISCARD_TOP と
          // 経路が違う。実行アクション DISCARD_TOP で揃えて数える（追加アクション文脈のみ）。
          if (
            state.phase === 'awaitingAdditionalActionChoice' ||
            state.phase === 'awaitingAdditionalDiscard'
          ) {
            agg.addDiscard++;
          }
          break;
        case 'CONFIRM_GIFTS': {
          const queue = state.turn.giftQueue;
          const allCards = queue.reduce((n, c) => n + c.cards.length, 0);
          agg.giftAssigned += action.assignments.length;
          agg.giftDiscarded += allCards - action.assignments.length;
          for (const a of action.assignments) {
            agg.giftTargetRankSum += scoreRank(state, a.targetPlayerId);
            agg.giftTargetN++;
          }
          break;
        }
      }

      state = stepGame(state, action);

      // コンボ増分を手番主体に帰属（combosThisTurn は endTurn で [] にリセットされる）。
      const cur = state.turn.combosThisTurn;
      if (cur.length > prevComboCount) {
        for (let k = prevComboCount; k < cur.length; k++) {
          const size = cur[k].cards.length;
          agg.comboBySize.set(size, (agg.comboBySize.get(size) ?? 0) + 1);
          if (isHuman) perGameHumanCombo.set(size, (perGameHumanCombo.get(size) ?? 0) + 1);
        }
      }
      prevComboCount = cur.length;
    }

    const winnerId = rec.result.winnerId;
    const humanWon = winnerId !== null && humanSeats.has(winnerId);
    // 人間席のスコア（複数人間席は想定しないが一応合計）
    for (const seat of rec.humanSeats) humanScoreSum += rec.result.scores[seat] ?? 0;
    if (humanWon) {
      humanWins++;
      winGames++;
      for (const [s, n] of perGameHumanCombo) comboSizeWin.set(s, (comboSizeWin.get(s) ?? 0) + n);
    } else {
      lossGames++;
      for (const [s, n] of perGameHumanCombo) comboSizeLoss.set(s, (comboSizeLoss.get(s) ?? 0) + n);
    }
  }

  const pct = (a: number, b: number) => (b === 0 ? '  -  ' : `${((100 * a) / b).toFixed(1)}%`);
  const f2 = (x: number) => x.toFixed(2);

  console.log(`\n=== データ: ${records.length}局  手番数 人間=${human.turns} / AI=${ai.turns} ===`);
  console.log(`\n指標                       人間        AI(3席計)`);
  console.log(
    `場ドロー率                 ${pct(human.drawField, human.drawField + human.drawDeck).padStart(6)}      ${pct(ai.drawField, ai.drawField + ai.drawDeck).padStart(6)}`
  );
  console.log(
    `コンボ後ドロー選択率       ${pct(human.addDraw, human.addDraw + human.addDiscard).padStart(6)}      ${pct(ai.addDraw, ai.addDraw + ai.addDiscard).padStart(6)}`
  );
  const hComboN = [...human.comboBySize.values()].reduce((a, b) => a + b, 0);
  const aComboN = [...ai.comboBySize.values()].reduce((a, b) => a + b, 0);
  console.log(
    `1手番あたりコンボ発火      ${f2(hComboN / human.turns).padStart(6)}      ${f2(aComboN / ai.turns).padStart(6)}`
  );
  console.log(
    `推定base得点/手番          ${f2(comboPoints(human.comboBySize) / human.turns).padStart(6)}      ${f2(comboPoints(ai.comboBySize) / ai.turns).padStart(6)}`
  );
  console.log(`\nコンボサイズ別（手番100あたりの発火数）:`);
  console.log(sizeRow('人間', human.comboBySize, human.turns));
  console.log(sizeRow('AI', ai.comboBySize, ai.turns));

  console.log(`\nギフト:`);
  console.log(
    `  配布率（配った/総コンボ札）  人間 ${pct(human.giftAssigned, human.giftAssigned + human.giftDiscarded)}   AI ${pct(ai.giftAssigned, ai.giftAssigned + ai.giftDiscarded)}`
  );
  console.log(
    `  配布先の平均スコア順位(1=首位) 人間 ${(human.giftTargetRankSum / Math.max(1, human.giftTargetN)).toFixed(2)}   AI ${(ai.giftTargetRankSum / Math.max(1, ai.giftTargetN)).toFixed(2)}`
  );

  console.log(`\n=== 局結果（人間視点）===`);
  console.log(`人間勝率: ${humanWins}/${records.length} (${((100 * humanWins) / records.length).toFixed(1)}%)`);
  console.log(`人間平均スコア: ${(humanScoreSum / records.length).toFixed(1)}`);
  console.log(`\n人間のコンボ（1局あたりの発火数）  勝局(${winGames}) vs 敗局(${lossGames}):`);
  for (const size of [3, 4, 5]) {
    const w = winGames === 0 ? 0 : (comboSizeWin.get(size) ?? 0) / winGames;
    const l = lossGames === 0 ? 0 : (comboSizeLoss.get(size) ?? 0) / lossGames;
    console.log(`  size${size}: 勝 ${w.toFixed(2)}  /  敗 ${l.toFixed(2)}`);
  }
  let w6 = 0;
  let l6 = 0;
  for (const [s, n] of comboSizeWin) if (s >= 6) w6 += n;
  for (const [s, n] of comboSizeLoss) if (s >= 6) l6 += n;
  console.log(
    `  size6+: 勝 ${(winGames === 0 ? 0 : w6 / winGames).toFixed(2)}  /  敗 ${(lossGames === 0 ? 0 : l6 / lossGames).toFixed(2)}`
  );
}

function main(): void {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    console.log('usage: tsx ai/scripts/analyze-human.ts <records.json> [<records2.json> ...]');
    process.exit(1);
  }
  const all: GameRecord[] = [];
  for (const p of paths) {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${p} は GameRecord 配列ではありません`);
    all.push(...(parsed as GameRecord[]));
  }
  analyze(all);
}

main();
