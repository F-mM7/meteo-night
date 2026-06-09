/**
 * 人間プレイ棋譜の「大コンボ構築手順」分析。
 *
 * 棋譜を再生し、size4 以上のコンボ発火を全て検出して、各発火について
 *  (A) 発火色が「最上段リーチ2以上」に到達してから発火までに何ターン温めたか（incubation）
 *  (B) 発火ターンに同色を2枚以上 最上段へ足して一気に完成させたか（一気揃え / one-shot）
 *  (C) 発火が「連鎖の露出」由来か「当ターンの直接配置」由来か（cascade vs direct）
 *  (D) 発火色を場ドローで取得してから作ったか（場ドロー寄せの相関）
 * を、人間席（humanSeats）と AI 席（他席）で分けて集計する。
 *
 *   npx tsx ai/scripts/analyze-trajectory.ts <records.json> [<records2.json> ...]
 *
 * コンボ判定の定義（src/game/combo.ts の detectCombos に準拠）:
 *   各スロットの「最上段カード」の色を見て、同色が3スロット以上の最上段に並ぶと発火。
 *   発火サイズ = 並んだスロット数。発火後そのスロットの最上段が除去され、下の層が露出する。
 *   よって「色 C の最上段リーチ」= 現在 C を最上段に持つスロット数、と定義する。
 *
 * 検算メモ（_verify_traj_tmp 系で確認済み）:
 *   - 再生の終局スコアは record.result と一致（記録基盤が正しい）。
 *   - 発火を起こす stepGame と endTurn の stepGame は常に別ステップ（同ステップ発生 0 件）。
 *     よってターン境界検出とコンボ増分検出は衝突しない。
 *   - 発火を起こした active プレイヤー = state.currentPlayerIndex（combosThisTurn は
 *     その手番中にのみ増える）。
 */
import { readFileSync } from 'node:fs';
import { stepGame } from '../../src/game/reducer';
import type { GameRecord } from '../../src/game/recording';
import type { Color, GameState, PlayerBoard } from '../../src/game/types';

const COLORS: Color[] = ['red', 'green', 'purple', 'yellow', 'blue'];

/** 盤面の各色の「最上段リーチ」= その色を最上段に持つスロット数。 */
function topReachByColor(board: PlayerBoard): Map<Color, number> {
  const m = new Map<Color, number>();
  for (const slot of board.slots) {
    const top = slot.stack[slot.stack.length - 1];
    if (!top) continue;
    m.set(top.color, (m.get(top.color) ?? 0) + 1);
  }
  return m;
}

interface FireEvent {
  isHuman: boolean;
  size: number;
  color: Color;
  /** 発火が起きたターン番号（state.turnNumber）。 */
  fireTurn: number;
  /**
   * 「最上段リーチ2以上に到達してから発火まで」に、この発火プレイヤーの自分の手番が
   * 何回経過したか（＝何ターン温めたか）。発火ターン開始時リーチが2未満なら 0
   * （その手番でいきなり育てた / 連鎖露出で出現した）。
   */
  incubationTurns: number;
  /** 発火ターン開始時点での当該色の最上段リーチ。 */
  reachAtTurnStart: number;
  /** 発火色を「この発火ターン中に最上段へ配置した枚数」（PLACE_DRAWN/ADDITIONAL/GIFT）。 */
  placedThisTurn: number;
  /** 発火ターンに同色を2枚以上 最上段へ配置して完成させたか（一気揃え）。 */
  oneShotByPlacement: boolean;
  /**
   * 発火が連鎖露出由来か（cascade）。
   * cascade = 同ステップで2個目以降の発火 || 発火色をこのターンに1枚も配置していない。
   * （配置0なら、その色は下層から露出してリーチ到達した＝当ターンに横並べしたのではない）
   */
  cascade: boolean;
  /** このターンに場ドローした2枚に発火色が含まれていたか。 */
  fieldDrewFireColorThisTurn: boolean;
}

interface GameTrajectory {
  fires: FireEvent[];
  /** 1ターン内 size4+ 発火数の最大（人間/AI別）。連鎖の深さの指標。 */
  maxFire4InTurnHuman: number;
  maxFire4InTurnAI: number;
}

function analyzeGame(rec: GameRecord, humanSeatsSet: Set<number>): GameTrajectory {
  const fires: FireEvent[] = [];
  // 各プレイヤーの「色ごとの reach2 連続手番数」。手番終了時に更新。
  const reach2Streak: Map<Color, number>[] = rec.initialState.players.map(
    () => new Map<Color, number>()
  );

  let state = rec.initialState;
  let prevComboCount = state.turn.combosThisTurn.length;
  let prevTurnNumber = state.turnNumber;
  let prevActivePlayer = state.currentPlayerIndex;

  // 現ターンのローカル状態
  let turnStartReach = topReachByColor(state.players[state.currentPlayerIndex].board);
  let placedColorCount = new Map<Color, number>(); // このターンに最上段へ配置した色と枚数
  let fieldDrawColorsThisTurn: Color[] = [];
  let fire4InTurn = 0;

  let maxFire4InTurnHuman = 0;
  let maxFire4InTurnAI = 0;

  function beginTurn(s: GameState): void {
    turnStartReach = topReachByColor(s.players[s.currentPlayerIndex].board);
    placedColorCount = new Map();
    fieldDrawColorsThisTurn = [];
    fire4InTurn = 0;
  }

  function endTurnUpdate(activePlayer: number, boardAtEnd: PlayerBoard): void {
    const reach = topReachByColor(boardAtEnd);
    const streak = reach2Streak[activePlayer];
    for (const color of COLORS) {
      const r = reach.get(color) ?? 0;
      streak.set(color, r >= 2 ? (streak.get(color) ?? 0) + 1 : 0);
    }
  }

  for (const action of rec.actions) {
    // 場ドロー色を手番主体に記録。
    if (action.type === 'DRAW_FROM_FIELD') {
      const pair = state.field[action.pairIndex];
      if (pair) fieldDrawColorsThisTurn.push(pair[0].color, pair[1].color);
    }
    // 最上段への配置色を記録（適用前 state から対象カードの色を引く）。
    let placedColor: Color | null = null;
    if (action.type === 'PLACE_DRAWN') {
      placedColor = state.turn.pendingDraw.find((c) => c.id === action.cardId)?.color ?? null;
    } else if (action.type === 'PLACE_ADDITIONAL_DRAW') {
      placedColor = state.turn.pendingAdditionalDraw?.color ?? null;
    } else if (action.type === 'PLACE_GIFT') {
      const batch = state.turn.pendingGiftBatches[0];
      placedColor = batch?.cards.find((c) => c.id === action.cardId)?.color ?? null;
    }
    if (placedColor) placedColorCount.set(placedColor, (placedColorCount.get(placedColor) ?? 0) + 1);

    const before = state;
    state = stepGame(state, action);
    if (state === before) continue; // no-op

    // ターン境界
    if (state.turnNumber !== prevTurnNumber) {
      if (humanSeatsSet.has(prevActivePlayer)) {
        maxFire4InTurnHuman = Math.max(maxFire4InTurnHuman, fire4InTurn);
      } else {
        maxFire4InTurnAI = Math.max(maxFire4InTurnAI, fire4InTurn);
      }
      endTurnUpdate(prevActivePlayer, state.players[prevActivePlayer].board);
      prevTurnNumber = state.turnNumber;
      prevActivePlayer = state.currentPlayerIndex;
      beginTurn(state);
    }

    // コンボ発火（combosThisTurn の増分）
    const cur = state.turn.combosThisTurn;
    if (cur.length > prevComboCount) {
      for (let k = prevComboCount; k < cur.length; k++) {
        const combo = cur[k];
        const size = combo.cards.length;
        if (size < 4) continue;
        const color = combo.color;
        const firePlayer = state.currentPlayerIndex;
        const isHuman = humanSeatsSet.has(firePlayer);
        fire4InTurn++;

        const reachAtTurnStart = turnStartReach.get(color) ?? 0;
        const placedThisTurn = placedColorCount.get(color) ?? 0;
        const oneShotByPlacement = placedThisTurn >= 2;
        const isSecondPlusInStep = k > prevComboCount;
        const cascade = isSecondPlusInStep || placedThisTurn === 0;

        let incubationTurns = 0;
        if (reachAtTurnStart >= 2) {
          incubationTurns = reach2Streak[firePlayer].get(color) ?? 0;
        }

        fires.push({
          isHuman,
          size,
          color,
          fireTurn: state.turnNumber,
          incubationTurns,
          reachAtTurnStart,
          placedThisTurn,
          oneShotByPlacement,
          cascade,
          fieldDrewFireColorThisTurn: fieldDrawColorsThisTurn.includes(color),
        });
      }
    }
    prevComboCount = cur.length;
  }

  // 最終ターン分（gameOver で turnNumber が進まず終わる場合）
  if (humanSeatsSet.has(prevActivePlayer)) {
    maxFire4InTurnHuman = Math.max(maxFire4InTurnHuman, fire4InTurn);
  } else {
    maxFire4InTurnAI = Math.max(maxFire4InTurnAI, fire4InTurn);
  }

  return { fires, maxFire4InTurnHuman, maxFire4InTurnAI };
}

function pct(a: number, b: number): string {
  return b === 0 ? '  -  ' : `${((100 * a) / b).toFixed(1)}%`;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function histogram(xs: number[], maxBucket: number): string {
  const c = new Array<number>(maxBucket + 2).fill(0);
  for (const x of xs) c[x >= maxBucket + 1 ? maxBucket + 1 : x]++;
  const parts: string[] = [];
  for (let i = 0; i <= maxBucket; i++) parts.push(`${i}:${c[i]}`);
  parts.push(`${maxBucket + 1}+:${c[maxBucket + 1]}`);
  return parts.join('  ');
}

function reportSide(label: string, fires: FireEvent[]): void {
  const s4 = fires.filter((f) => f.size === 4);
  const s5 = fires.filter((f) => f.size >= 5);
  console.log(`\n--- ${label} ---`);
  console.log(`  size4+ 発火数: ${fires.length}  (size4=${s4.length}, size5+=${s5.length})`);
  if (fires.length === 0) return;

  for (const [tag, set] of [
    ['size4+', fires],
    ['size4 ', s4],
    ['size5+', s5],
  ] as const) {
    if (set.length === 0) {
      console.log(`  [${tag}] サンプル0`);
      continue;
    }
    const inc = set.map((f) => f.incubationTurns);
    const oneShot = set.filter((f) => f.oneShotByPlacement).length;
    const reach2 = set.filter((f) => f.reachAtTurnStart >= 2).length;
    const cascade = set.filter((f) => f.cascade).length;
    const field = set.filter((f) => f.fieldDrewFireColorThisTurn).length;
    console.log(`  [${tag}] n=${set.length}`);
    console.log(
      `    温めターン数(top-reach2継続)  平均 ${mean(inc).toFixed(2)}  中央 ${median(inc).toFixed(1)}  分布 ${histogram(inc, 4)}`
    );
    console.log(
      `    発火ターン開始時に既にリーチ2以上  ${pct(reach2, set.length)} (${reach2}/${set.length})`
    );
    console.log(
      `    一気揃え率(発火色を当ターンに2枚+配置)  ${pct(oneShot, set.length)} (${oneShot}/${set.length})`
    );
    console.log(
      `    連鎖露出由来(cascade)率  ${pct(cascade, set.length)} (${cascade}/${set.length})`
    );
    console.log(
      `    発火色を当ターンに場ドロー  ${pct(field, set.length)} (${field}/${set.length})`
    );
    console.log(
      `    発火色の当ターン最上段配置枚数  分布 ${histogram(set.map((f) => f.placedThisTurn), 4)}`
    );
    console.log(
      `    発火ターン開始時リーチ  分布 ${histogram(set.map((f) => f.reachAtTurnStart), 5)}`
    );
  }
}

function main(): void {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    console.log('usage: npx tsx ai/scripts/analyze-trajectory.ts <records.json> [<records2.json> ...]');
    process.exit(1);
  }
  const all: GameRecord[] = [];
  for (const p of paths) {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${p} は GameRecord 配列ではありません`);
    all.push(...(parsed as GameRecord[]));
  }

  const humanFires: FireEvent[] = [];
  const aiFires: FireEvent[] = [];
  let maxFireH = 0;
  let maxFireA = 0;
  for (const rec of all) {
    const traj = analyzeGame(rec, new Set(rec.humanSeats));
    for (const f of traj.fires) (f.isHuman ? humanFires : aiFires).push(f);
    maxFireH = Math.max(maxFireH, traj.maxFire4InTurnHuman);
    maxFireA = Math.max(maxFireA, traj.maxFire4InTurnAI);
  }

  console.log(`\n=== 大コンボ構築手順の分析  (${all.length}局) ===`);
  console.log(`size4 以上の発火を全検出し、人間席(席0) と AI席(席1-3) で比較。`);
  console.log(`  ※「最上段リーチ」= その色を最上段に持つスロット数（detectCombos の判定基準）`);
  console.log(`  ※「温めターン数」= 発火色が最上段リーチ2以上を維持した発火プレイヤーの連続手番数`);
  console.log(`  ※「一気揃え」= 発火色を発火ターンに2枚以上 最上段へ配置して完成`);
  console.log(`  ※「連鎖露出(cascade)」= 上層コンボの除去で下層が露出して発火（横並べでなく縦積み由来）`);

  reportSide('人間 (席0)', humanFires);
  reportSide('AI (席1-3 合算)', aiFires);

  console.log(`\n=== 連鎖の深さ ===`);
  console.log(`  1ターン内 size4+ 発火数の最大  人間=${maxFireH}  AI=${maxFireA}`);

  console.log(`\n=== 場ドロー寄せ（size4+ 発火のうち発火色を当ターンに場ドローした割合）===`);
  const hf = humanFires.filter((f) => f.fieldDrewFireColorThisTurn).length;
  const af = aiFires.filter((f) => f.fieldDrewFireColorThisTurn).length;
  console.log(`  人間 ${pct(hf, humanFires.length)} (${hf}/${humanFires.length})   AI ${pct(af, aiFires.length)} (${af}/${aiFires.length})`);
}

main();
