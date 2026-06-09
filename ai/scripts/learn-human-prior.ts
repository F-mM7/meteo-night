/**
 * E2: 人間棋譜から「配置選択の効用」を条件付きロジットで学習する。
 *
 * 人間（席0）の配置決定（PLACE_DRAWN / PLACE_ADDITIONAL_DRAW）ごとに、合法な全配置先の
 * 「配置後の局面」を候補とし、人間が実際に選んだ候補の効用 w·φ が最大になるよう w を学習する
 * （multinomial logit / McFadden 条件付きロジット, L2 正則化, full-batch 勾配降下）。
 *
 * φ は `src/ai/humanFeatures.ts` の humanFeatures（学習と推論で共有）。学習結果（標準化 + 重み）を
 * `src/ai/humanPriorWeights.ts` に書き出し、`src/ai/tempoHumanAI.ts` が葉評価の人間プライア加点に使う。
 *
 * 比較のため、同じホールドアウトで「evaluateState の argmax が人間手を当てる率」も出す
 * （＝tempoFast の既存評価が既に人間の配置を捉えているか。学習プライアがそれを上回れば新情報）。
 *
 *   npx tsx ai/scripts/learn-human-prior.ts <records.json> [<records2.json> ...] [--l2 0.5] [--epochs 4000] [--lr 0.3] [--test-games 7]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { stepGame } from '../../src/game/reducer';
import { evaluateState } from '../../src/ai/evaluator';
import { humanFeatures, HUMAN_FEATURE_NAMES } from '../../src/ai/humanFeatures';
import { currentActorId, parseIntArg, parseFloatArg } from './_runner';
import type { GameRecord } from '../../src/game/recording';
import type { Action, GameState } from '../../src/game/types';

interface Choice {
  /** 候補ごとの生特徴（option × feature）。 */
  feats: number[][];
  /** 人間が選んだ候補の index。 */
  target: number;
  /** この choice が属するゲーム index（train/test 分割用）。 */
  game: number;
  /** evaluateState の argmax が当たるか（baseline 用に事前計算）。 */
  evalCorrect: boolean;
}

const F = HUMAN_FEATURE_NAMES.length;

/** 配置決定局面の合法な全配置先を (action, 後続局面) で列挙する。 */
function enumeratePlacements(state: GameState): { action: Action; next: GameState }[] {
  const out: { action: Action; next: GameState }[] = [];
  const slots = state.players[state.currentPlayerIndex].board.slots.length;
  if (state.phase === 'awaitingPlaceDrawn') {
    for (const card of state.turn.pendingDraw) {
      for (let s = 0; s < slots; s++) {
        const action: Action = { type: 'PLACE_DRAWN', cardId: card.id, slotIndex: s };
        const next = stepGame(state, action);
        if (next !== state) out.push({ action, next });
      }
    }
  } else if (state.phase === 'awaitingPlaceAdditionalDraw') {
    for (let s = 0; s < slots; s++) {
      const action: Action = { type: 'PLACE_ADDITIONAL_DRAW', slotIndex: s };
      const next = stepGame(state, action);
      if (next !== state) out.push({ action, next });
    }
  }
  return out;
}

function matchesHuman(opt: Action, human: Action): boolean {
  if (opt.type !== human.type) return false;
  if (opt.type === 'PLACE_DRAWN' && human.type === 'PLACE_DRAWN') {
    return opt.cardId === human.cardId && opt.slotIndex === human.slotIndex;
  }
  if (opt.type === 'PLACE_ADDITIONAL_DRAW' && human.type === 'PLACE_ADDITIONAL_DRAW') {
    return opt.slotIndex === human.slotIndex;
  }
  return false;
}

function collectChoices(records: GameRecord[]): Choice[] {
  const choices: Choice[] = [];
  records.forEach((rec, gameIdx) => {
    const humanSeats = new Set(rec.humanSeats);
    let state = rec.initialState;
    for (const action of rec.actions) {
      const actor = currentActorId(state);
      const isHumanPlacement =
        humanSeats.has(actor) &&
        (state.phase === 'awaitingPlaceDrawn' || state.phase === 'awaitingPlaceAdditionalDraw');
      if (isHumanPlacement) {
        const opts = enumeratePlacements(state);
        if (opts.length >= 2) {
          const target = opts.findIndex((o) => matchesHuman(o.action, action));
          if (target >= 0) {
            const feats = opts.map((o) => humanFeatures(o.next, actor));
            // baseline: evaluateState の argmax が人間手と一致するか
            let bestEval = -Infinity;
            let bestIdx = 0;
            opts.forEach((o, i) => {
              const v = evaluateState(o.next, actor);
              if (v > bestEval) {
                bestEval = v;
                bestIdx = i;
              }
            });
            choices.push({ feats, target, game: gameIdx, evalCorrect: bestIdx === target });
          }
        }
      }
      state = stepGame(state, action);
    }
  });
  return choices;
}

function standardize(choices: Choice[]): { mean: number[]; std: number[] } {
  const mean = new Array<number>(F).fill(0);
  let n = 0;
  for (const c of choices)
    for (const phi of c.feats) {
      for (let j = 0; j < F; j++) mean[j] += phi[j];
      n++;
    }
  for (let j = 0; j < F; j++) mean[j] /= Math.max(1, n);
  const variance = new Array<number>(F).fill(0);
  for (const c of choices)
    for (const phi of c.feats) for (let j = 0; j < F; j++) variance[j] += (phi[j] - mean[j]) ** 2;
  const std = variance.map((v) => {
    const s = Math.sqrt(v / Math.max(1, n));
    return s < 1e-6 ? 1 : s;
  });
  return { mean, std };
}

function softmax(scores: number[]): number[] {
  const m = Math.max(...scores);
  const ex = scores.map((s) => Math.exp(s - m));
  const sum = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / sum);
}

/** 標準化済み特徴で条件付きロジットを学習（full-batch GD + L2）。 */
function train(
  choices: Choice[],
  mean: number[],
  std: number[],
  l2: number,
  epochs: number,
  lr: number
): number[] {
  const w = new Array<number>(F).fill(0);
  const z = (phi: number[]) => phi.map((v, j) => (v - mean[j]) / std[j]);
  const N = Math.max(1, choices.length);
  for (let ep = 0; ep < epochs; ep++) {
    const grad = new Array<number>(F).fill(0);
    for (const c of choices) {
      const zs = c.feats.map(z);
      const scores = zs.map((zi) => zi.reduce((a, v, j) => a + v * w[j], 0));
      const p = softmax(scores);
      // -log p[target] の勾配 = Σ_o (p_o - 1[o=t]) z_o
      for (let o = 0; o < zs.length; o++) {
        const coef = p[o] - (o === c.target ? 1 : 0);
        for (let j = 0; j < F; j++) grad[j] += coef * zs[o][j];
      }
    }
    for (let j = 0; j < F; j++) {
      grad[j] = grad[j] / N + l2 * w[j];
      w[j] -= lr * grad[j];
    }
  }
  return w;
}

function top1Accuracy(choices: Choice[], mean: number[], std: number[], w: number[]): number {
  if (choices.length === 0) return 0;
  let correct = 0;
  for (const c of choices) {
    let best = -Infinity;
    let bi = 0;
    c.feats.forEach((phi, i) => {
      const s = phi.reduce((a, v, j) => a + ((v - mean[j]) / std[j]) * w[j], 0);
      if (s > best) {
        best = s;
        bi = i;
      }
    });
    if (bi === c.target) correct++;
  }
  return correct / choices.length;
}

function main(): void {
  const argv = process.argv.slice(2);
  const paths: string[] = [];
  let l2 = 0.5;
  let epochs = 4000;
  let lr = 0.3;
  let testGames = 7;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--l2') l2 = parseFloatArg('--l2', argv[++i]);
    else if (k === '--epochs') epochs = parseIntArg('--epochs', argv[++i]);
    else if (k === '--lr') lr = parseFloatArg('--lr', argv[++i]);
    else if (k === '--test-games') testGames = parseIntArg('--test-games', argv[++i]);
    else if (!k.startsWith('--')) paths.push(k);
    else throw new Error(`unknown arg: ${k}`);
  }
  if (paths.length === 0) {
    console.log('usage: npx tsx ai/scripts/learn-human-prior.ts <records.json> [...] [--l2 0.5] [--epochs 4000] [--lr 0.3] [--test-games 7]');
    process.exit(1);
  }
  const records: GameRecord[] = [];
  for (const p of paths) {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${p} は GameRecord 配列ではありません`);
    records.push(...(parsed as GameRecord[]));
  }

  const choices = collectChoices(records);
  const nGames = records.length;
  const avgOpts = choices.reduce((a, c) => a + c.feats.length, 0) / Math.max(1, choices.length);
  const evalAcc = choices.filter((c) => c.evalCorrect).length / Math.max(1, choices.length);
  console.log(`\n=== 人間配置プライアの学習 (${nGames}局) ===`);
  console.log(`配置決定数: ${choices.length}  平均候補数: ${avgOpts.toFixed(1)}  ランダム基準: ${(100 / avgOpts).toFixed(1)}%`);
  console.log(`evaluateState argmax の人間手一致率（全データ）: ${(100 * evalAcc).toFixed(1)}%  ← tempoFast 既存評価の人間予測力`);

  // ホールドアウト評価: 末尾 testGames 局を test に。
  const testSet = new Set<number>();
  for (let g = Math.max(0, nGames - testGames); g < nGames; g++) testSet.add(g);
  const trainC = choices.filter((c) => !testSet.has(c.game));
  const testC = choices.filter((c) => testSet.has(c.game));
  if (testC.length > 0 && trainC.length > 0) {
    const { mean, std } = standardize(trainC);
    const w = train(trainC, mean, std, l2, epochs, lr);
    const trAcc = top1Accuracy(trainC, mean, std, w);
    const teAcc = top1Accuracy(testC, mean, std, w);
    const teEval = testC.filter((c) => c.evalCorrect).length / testC.length;
    console.log(`\nホールドアウト（train ${trainC.length} / test ${testC.length}件, test=末尾${testGames}局）:`);
    console.log(`  人間プライア top-1: train ${(100 * trAcc).toFixed(1)}%  /  test ${(100 * teAcc).toFixed(1)}%`);
    console.log(`  evaluateState top-1（同 test）: ${(100 * teEval).toFixed(1)}%`);
    console.log(`  → プライアが evaluateState を test で上回れば、人間配置の新情報を学習できている`);
  }

  // 本番モデル: 全データで再学習して書き出す。
  const { mean, std } = standardize(choices);
  const w = train(choices, mean, std, l2, epochs, lr);
  const allAcc = top1Accuracy(choices, mean, std, w);
  console.log(`\n全データ再学習 top-1: ${(100 * allAcc).toFixed(1)}%  （書き出し用モデル）`);
  console.log(`重み（標準化空間, 絶対値降順）:`);
  HUMAN_FEATURE_NAMES.map((name, j) => ({ name, w: w[j] }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
    .forEach(({ name, w: wj }) => console.log(`  ${name.padEnd(16)} ${wj >= 0 ? ' ' : ''}${wj.toFixed(3)}`));

  const outPath = 'src/ai/humanPriorWeights.ts';
  const body =
    `/**\n` +
    ` * 自動生成（ai/scripts/learn-human-prior.ts）。手で編集しないこと。\n` +
    ` * 人間棋譜 ${nGames} 局の配置選択を条件付きロジットで学習した「人間らしさ効用」モデル。\n` +
    ` * tempoHumanAI が葉評価の人間プライア加点に使う。l2=${l2}, epochs=${epochs}, lr=${lr}。\n` +
    ` */\n` +
    `import type { HumanPriorModel } from './humanFeatures';\n\n` +
    `export const HUMAN_PRIOR_MODEL: HumanPriorModel = {\n` +
    `  featureNames: ${JSON.stringify(HUMAN_FEATURE_NAMES)},\n` +
    `  mean: ${JSON.stringify(mean)},\n` +
    `  std: ${JSON.stringify(std)},\n` +
    `  weights: ${JSON.stringify(w)},\n` +
    `};\n`;
  writeFileSync(outPath, body);
  console.log(`\n書き出し: ${outPath}`);
}

main();
