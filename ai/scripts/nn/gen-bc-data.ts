/**
 * behavioral cloning 用データ生成: 人間棋譜から (局面エンコード, 人間が選んだ行動ID) を抽出する。
 *
 * Stage 2 確定方針「人間 policy の大規模学習」の (2) の前段。各人間（humanSeats）の決定局面で、
 *   x = encodeState(state, 人間席)（185 次元）, y = actionToActionId(人間の実手, state)（0..29）
 * を集める。選択肢が 2 つ以上ある決定のみ（強制手は学習信号でないので除外）。CONFIRM_GIFTS は
 * 行動 ID 空間外（actionToActionId が null）なので自然に除外される。各サンプルに合法手マスク
 * （30 次元 0/1, 評価時の legal-masked argmax 用）と「配置決定か」（E2 線形との比較用）とゲーム
 * index（ゲーム単位の train/test 分割用）を付す。
 *
 *   npx tsx ai/scripts/nn/gen-bc-data.ts <records.json> [...] --out /tmp/bc-data.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { stepGame } from '../../../src/game/reducer';
import { encodeState, ENCODING_SIZE } from '../../../src/ai/encoding';
import { actionToActionId, legalActionIds, ACTION_SPACE_SIZE } from '../../../src/ai/actionSpace';
import { currentActorId } from '../_runner';
import type { GameRecord } from '../../../src/game/recording';

interface Sample {
  x: number[];
  y: number;
  mask: number[]; // 30 次元 0/1（合法手）
  isPlace: boolean; // PLACE_DRAWN(5..14) / PLACE_ADDITIONAL_DRAW(15..19) か（E2 比較用）
  game: number;
}

function main(): void {
  const argv = process.argv.slice(2);
  const paths: string[] = [];
  let out = '/tmp/bc-data.json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (!argv[i].startsWith('--')) paths.push(argv[i]);
    else throw new Error(`unknown arg: ${argv[i]}`);
  }
  if (paths.length === 0) {
    console.log('usage: npx tsx ai/scripts/nn/gen-bc-data.ts <records.json> [...] --out /tmp/bc-data.json');
    process.exit(1);
  }
  const records: GameRecord[] = [];
  for (const p of paths) {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${p} は GameRecord 配列ではありません`);
    records.push(...(parsed as GameRecord[]));
  }

  const samples: Sample[] = [];
  let skippedForced = 0;
  let skippedNoId = 0;
  records.forEach((rec, gameIdx) => {
    const humanSeats = new Set(rec.humanSeats);
    let state = rec.initialState;
    for (const action of rec.actions) {
      const actor = currentActorId(state);
      if (humanSeats.has(actor)) {
        const legal = legalActionIds(state, actor);
        if (legal.length >= 2) {
          const y = actionToActionId(action, state);
          if (y === null) {
            skippedNoId++;
          } else {
            const mask = new Array<number>(ACTION_SPACE_SIZE).fill(0);
            for (const id of legal) mask[id] = 1;
            samples.push({
              x: encodeState(state, actor),
              y,
              mask,
              isPlace: y >= 5 && y <= 19,
              game: gameIdx,
            });
          }
        } else {
          skippedForced++;
        }
      }
      state = stepGame(state, action);
    }
  });

  const placeN = samples.filter((s) => s.isPlace).length;
  console.error(
    `[gen-bc-data] ${records.length}局 → サンプル ${samples.length}件（うち配置 ${placeN}件）。` +
      `強制手スキップ ${skippedForced}、ID外(ギフト確定等)スキップ ${skippedNoId}。dim=${ENCODING_SIZE}`
  );
  writeFileSync(
    out,
    JSON.stringify({
      dim: ENCODING_SIZE,
      actionSpace: ACTION_SPACE_SIZE,
      nGames: records.length,
      samples,
    })
  );
  console.error(`[gen-bc-data] 書き出し: ${out}`);
}

main();
