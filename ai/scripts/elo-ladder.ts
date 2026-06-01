/**
 * elo-ladder.ts ― 既存 CPU AI 群の round-robin Elo ラダー（物差し強化）。
 *
 * ## なぜこれが要るか（ai/CHANGELOG.md 「根本診断」 / Gen-3-X 「intransitive リスク」）
 * bench-self.ts は「候補 1 種 vs ある 1 つの baseline」 の 2 者比較しかできない。 これだと
 * 「baseline X に勝つ」 = 「絶対的に強い」 ではない（特定 baseline へのカウンター＝非推移の罠）。
 * このスクリプトは AI 群を総当たり（round-robin）させ、 (1) 全フィールドで Elo を稼ぐか、
 * (2) A>B>C>A のような非推移サイクルが無いか、 を検出できる「面の物差し」 にする。
 *
 * ## 4 人ゲームでの公平スキーム（2 方式を併用、どちらも seat を rotate して席順バイアスを除去）
 *
 *   方式 A 「homogeneous / directional」（既定の主 Elo 入力）:
 *     順序対 (focus, opp) ごとに、focus を 1 席・opp のコピーを 3 席に置き、focus の席を
 *     0→1→2→3 と回して対戦する（bench-self.ts と同じ実証済みパターン）。
 *     各局から「focus が opp の各席に着順で勝ったか」 を 3 件の pairwise outcome として記録する。
 *     → focus 視点の方向別の強さ（A は B にどれだけ着順で勝つか）が直接出る。
 *     focus が無関係な席要因で有利/不利にならないよう、(A,B) と (B,A) の両方を回す。
 *
 *   方式 B 「mixed table」（任意・--mixed で有効、多人数同卓の実戦性を見る補助）:
 *     4 種の異なる AI を 1 卓に座らせ、席の巡回置換（4 通り）で対戦する。N>4 のときは
 *     乱数で重複なし 4-subset を選ぶ。各局の ranking から C(4,2)=6 件の pairwise outcome
 *     （X が Y より上位に着順で入ったか）を記録する。→ 同卓多人数での相対着順を測れる。
 *
 * ## レーティング
 *   集約した pairwise 「finish-ahead」 勝敗カウントから反復 Elo（オフライン fit, BT 同等）を解く。
 *   勝率 1 件 = 1 ゲーム扱いで全 pairwise を何 pass も回し、K を徐々に下げて収束させる。
 *   ranking は常に全順序（同点はタイブレークで解決済み）なので引き分けは出ない。
 *
 * ## 出力
 *   - 反復 Elo のレーティング表（降順）
 *   - pairwise 「finish-ahead 率」 行列（行 = 勝つ側、列 = 負ける側）→ サイクルが目視できる
 *   - 非推移トリプル（A>B>C>A: いずれの方向勝率も >50% で巡回するもの）の検出
 *   - methodology / 総ゲーム数 / カバレッジ上限のログ / 短い解釈
 *   - JSON（--json で生データも）+ 人間可読の表
 *
 * ## 使い方
 *   # 既定セット（random, smart, mctsGen3X, tempo50）, 方式 A のみ
 *   npx tsx ai/scripts/elo-ladder.ts --games 12 --seed 7001
 *
 *   # tempo の「探索のみ寄与」 を見るため tempo0（tempoChainW=0）も入れ、mixed も回す
 *   npx tsx ai/scripts/elo-ladder.ts --ais random,smart,mctsGen3X,tempo50,tempo0 --games 12 --mixed
 *
 * 引数:
 *   --games N      方式 A の「順序対あたり」 ゲーム数（4 の倍数を推奨＝全席を均等に回す）。既定 12。
 *                  0 を渡すと方式 A をスキップし、方式 B（mixed, 要 --mixed）のみで Elo を出す。
 *                  ※ tempo を含む大きいフィールドで方式 A は 3 体同種 tempo 卓が極端に重いため、
 *                    その場合は `--games 0 --mixed`（1 卓に tempo 1 席で軽い）を推奨。
 *   --mixed-games N  方式 B の「席置換あたり」 ゲーム数。既定は --games と同じ（--games 0 のとき 8）。
 *   --ais a,b,...  対戦させる AI ラベル（下記 AI_FACTORIES のキー）。既定 4 種。
 *   --seed N       乱数シード基点。既定 7001。
 *   --mixed        方式 B（mixed table）も実行する。
 *   --max-steps N  1 局の最大ステップ（既定 20000）。
 *   --json         結果 JSON を stdout に出す（生 pairwise カウント込み）。
 *
 * 注意: tempo は連鎖局面で 1 手が重い（p99 数秒）。total runtime を ~20 分以内に保つため
 *       既定 games は控えめ。カバレッジを削った場合は stderr に明示ログを出す（無言の切り詰めはしない）。
 *       共有マシン（24 core, 兄弟プロセスも稼働）前提でデフォルトを保守的にしている。
 */
import {
  makeMctsWithWeights,
  makeTempoWithOpts,
  playOneGameWithDeciders,
  parseIntArg,
  type Decider,
} from './_runner';
import { DEFAULT_WEIGHTS } from '../../src/ai/evaluator';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';
import { decideAction as decideSmart } from '../../src/ai/smartAI';
import { decideAction as decideRandom } from '../../src/ai/randomAI';

// ─────────────────────────────────────────────────────────────────────────
// AI ファクトリ。すべて global state 非依存（重み等を明示渡し）で、bench-self と同じ作り方。
// tempo の Gen-4-A 既定は tempoChainW=50。mctsGen3X は現 baseline = DEFAULT_WEIGHTS の mcts。
// ─────────────────────────────────────────────────────────────────────────
const AI_FACTORIES: Record<string, () => Decider> = {
  random: () => (s, p) => decideRandom(s, p),
  smart: () => (s, p) => decideSmart(s, p),
  // 現状最強 baseline（Gen-3-X = DEFAULT_WEIGHTS の mcts）。明示渡しで global 非依存。
  mctsGen3X: () => (s, p) => decideMcts(s, p, undefined, { weights: DEFAULT_WEIGHTS }),
  // 採用版 tempo（Gen-4-A, tempoChainW=50）。
  tempo50: () => makeTempoWithOpts({ tempoChainW: 50 }),
  // tempo の「探索構造だけ」 の寄与を見る（チェイン加点 0）。
  tempo0: () => makeTempoWithOpts({ tempoChainW: 0 }),
  // 任意重みファクトリの素の mcts（Gen-3-X と同義だが別ラベルで欲しい場合用）。
  mcts: () => makeMctsWithWeights(DEFAULT_WEIGHTS),
};

const DEFAULT_AIS = ['random', 'smart', 'mctsGen3X', 'tempo50'];

interface Args {
  ais: string[];
  games: number; // 方式 A: 順序対あたり
  mixedGames: number; // 方式 B: 席置換あたり
  seed: number;
  mixed: boolean;
  maxSteps: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    ais: DEFAULT_AIS,
    games: 12,
    mixedGames: -1,
    seed: 7001,
    mixed: false,
    maxSteps: 20000,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--ais': {
        const raw = argv[++i];
        if (raw === undefined) throw new Error('--ais requires a value');
        const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        if (list.length < 2) throw new Error('--ais needs at least 2 AIs');
        for (const name of list) {
          if (!(name in AI_FACTORIES)) {
            throw new Error(
              `unknown AI: ${name}. available: ${Object.keys(AI_FACTORIES).join(', ')}`
            );
          }
        }
        args.ais = list;
        break;
      }
      case '--games':
        args.games = parseIntArg('--games', argv[++i]);
        break;
      case '--mixed-games':
        args.mixedGames = parseIntArg('--mixed-games', argv[++i]);
        break;
      case '--seed':
        args.seed = parseIntArg('--seed', argv[++i]);
        break;
      case '--mixed':
        args.mixed = true;
        break;
      case '--max-steps':
        args.maxSteps = parseIntArg('--max-steps', argv[++i]);
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  if (args.mixedGames < 0) args.mixedGames = args.games > 0 ? args.games : 8;
  if (args.games < 0) throw new Error('--games must be >= 0 (0 = skip 方式A, mixed-only)');
  if (args.games === 0 && !args.mixed) {
    throw new Error('--games 0 (方式A スキップ) のときは --mixed が必須（さもないと無対戦）');
  }
  return args;
}

function printHelp(): void {
  console.error(
    'usage: npx tsx ai/scripts/elo-ladder.ts [--ais a,b,c,...] [--games N] [--mixed-games N] [--seed N] [--mixed] [--max-steps N] [--json]'
  );
  console.error(`available AIs: ${Object.keys(AI_FACTORIES).join(', ')}`);
}

// ─────────────────────────────────────────────────────────────────────────
// pairwise 集計: wins[i][j] = 「i が j より上位（finish-ahead）に入った」 件数。
// games[i][j] = i と j を比較した総件数。対称: games[i][j] == games[j][i],
//   wins[i][j] + wins[j][i] == games[i][j]（ranking は全順序なので tie 無し）。
// ─────────────────────────────────────────────────────────────────────────
interface Pairwise {
  n: number;
  wins: number[][];
  games: number[][];
}

function newPairwise(n: number): Pairwise {
  return {
    n,
    wins: Array.from({ length: n }, () => new Array<number>(n).fill(0)),
    games: Array.from({ length: n }, () => new Array<number>(n).fill(0)),
  };
}

/** ranking[seat]（0=1位）と seat→AIindex の対応から、全ペアの finish-ahead を加算。 */
function recordFromRanking(pw: Pairwise, seatToAi: number[], ranking: number[]): void {
  const seats = seatToAi.length;
  for (let s1 = 0; s1 < seats; s1++) {
    for (let s2 = s1 + 1; s2 < seats; s2++) {
      const a = seatToAi[s1];
      const b = seatToAi[s2];
      if (a === b) continue; // 同一 AI 同士の比較は Elo に入れない（自己対戦は情報ゼロ）
      pw.games[a][b]++;
      pw.games[b][a]++;
      // ranking が小さい = 上位。
      if (ranking[s1] < ranking[s2]) pw.wins[a][b]++;
      else pw.wins[b][a]++; // 全順序なので等しいことはない
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 反復 Elo（オフライン fit）。集約 pairwise を「ゲーム列」 として何 pass も回し、
// K を徐々に下げて収束させる。Bradley–Terry MLE と概ね同じ ranking/スケールに収束する。
// ─────────────────────────────────────────────────────────────────────────
function expectedScore(rA: number, rB: number): number {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function computeElo(pw: Pairwise, passes = 4000): number[] {
  const n = pw.n;
  const r = new Array<number>(n).fill(1500);
  // 各 (i<j) ペアの集約勝敗を 1 単位として扱い、K を線形に減衰させて収束させる。
  for (let pass = 0; pass < passes; pass++) {
    const k = 8 * (1 - pass / passes) + 0.5; // 8 → 0.5 へ漸減
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const g = pw.games[i][j];
        if (g === 0) continue;
        const sI = pw.wins[i][j] / g; // i の実勝率
        const eI = expectedScore(r[i], r[j]);
        const delta = k * (sI - eI);
        r[i] += delta;
        r[j] -= delta;
      }
    }
  }
  // 平均 1500 に正規化（相対値なのでオフセットは任意）。
  const mean = r.reduce((a, b) => a + b, 0) / n;
  return r.map((x) => x - mean + 1500);
}

// ─────────────────────────────────────────────────────────────────────────
// 対戦実行
// ─────────────────────────────────────────────────────────────────────────
interface SeatStats {
  totalGames: number;
  unfinished: number;
  totalSteps: number;
  totalMs: number;
}

/** 方式 A: 各順序対 (focus, opp) で focus 1 席 vs opp 3 席、focus 席を rotate。 */
function runDirectional(
  ais: string[],
  deciders: Decider[],
  games: number,
  seedBase: number,
  maxSteps: number,
  pw: Pairwise,
  stats: SeatStats
): { capped: boolean; perPairGames: number } {
  const n = ais.length;
  // 全席を均等に回すため 4 の倍数に丸める（最低 4）。丸めた場合はログを出す。
  const perPair = Math.max(4, Math.floor(games / 4) * 4);
  let capped = false;
  if (perPair !== games) capped = true;

  let seedCursor = seedBase;
  for (let focus = 0; focus < n; focus++) {
    for (let opp = 0; opp < n; opp++) {
      if (focus === opp) continue; // 同一 AI 同士は情報ゼロ
      for (let g = 0; g < perPair; g++) {
        const focusSeat = g % 4;
        const seatToAi = [opp, opp, opp, opp];
        seatToAi[focusSeat] = focus;
        const seatDeciders: Decider[] = seatToAi.map((aiIdx) => deciders[aiIdx]);
        const r = playOneGameWithDeciders({
          seed: seedCursor++,
          deciders: seatDeciders,
          names: seatToAi.map((aiIdx, s) => `${s}-${ais[aiIdx]}`),
          maxSteps,
        });
        recordFromRanking(pw, seatToAi, r.ranking);
        stats.totalGames++;
        if (!r.finished) stats.unfinished++;
        stats.totalSteps += r.steps;
        stats.totalMs += r.durationMs;
      }
    }
  }
  return { capped, perPairGames: perPair };
}

/** 配列の全巡回シフトを返す（席ローテーション用）。 */
function rotations<T>(arr: T[]): T[][] {
  const n = arr.length;
  const out: T[][] = [];
  for (let k = 0; k < n; k++) {
    out.push(arr.map((_, i) => arr[(i + k) % n]));
  }
  return out;
}

/** 単純な決定的 RNG（mixed の subset 選択用、再現性のため）。 */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chooseDistinct4(n: number, rand: () => number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  // Fisher–Yates の先頭 4 個。
  for (let i = 0; i < 4; i++) {
    const j = i + Math.floor(rand() * (n - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, 4);
}

/**
 * 方式 B: 4 種の異なる AI を 1 卓に。N==4 なら全 AI を 1 卓、N>4 なら乱数で重複なし 4-subset を
 * (テーブル数) 回サンプル。各テーブルを 4 通りの巡回席置換 × mixedGames 回プレイ。
 */
function runMixed(
  ais: string[],
  deciders: Decider[],
  mixedGames: number,
  seedBase: number,
  maxSteps: number,
  pw: Pairwise,
  stats: SeatStats
): { tables: number[][]; gamesPerTablePerm: number } {
  const n = ais.length;
  const rand = mulberry(seedBase ^ 0x5bd1e995);
  const tables: number[][] = [];
  if (n === 4) {
    tables.push([0, 1, 2, 3]);
  } else {
    // 各 AI が十分サンプルされるよう n テーブルを引く。
    const seen = new Set<string>();
    let guard = 0;
    while (tables.length < n && guard < n * 20) {
      const sub = chooseDistinct4(n, rand).sort((a, b) => a - b);
      const key = sub.join(',');
      if (!seen.has(key)) {
        seen.add(key);
        tables.push(sub);
      }
      guard++;
    }
  }
  let seedCursor = seedBase;
  for (const table of tables) {
    for (const perm of rotations(table)) {
      for (let g = 0; g < mixedGames; g++) {
        const seatToAi = perm;
        const seatDeciders: Decider[] = seatToAi.map((aiIdx) => deciders[aiIdx]);
        const r = playOneGameWithDeciders({
          seed: seedCursor++,
          deciders: seatDeciders,
          names: seatToAi.map((aiIdx, s) => `${s}-${ais[aiIdx]}`),
          maxSteps,
        });
        recordFromRanking(pw, seatToAi, r.ranking);
        stats.totalGames++;
        if (!r.finished) stats.unfinished++;
        stats.totalSteps += r.steps;
        stats.totalMs += r.durationMs;
      }
    }
  }
  return { tables, gamesPerTablePerm: mixedGames };
}

// ─────────────────────────────────────────────────────────────────────────
// 出力ヘルパ
// ─────────────────────────────────────────────────────────────────────────
function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}
function padL(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function printMatrix(ais: string[], pw: Pairwise): void {
  const n = ais.length;
  const labelW = Math.max(10, ...ais.map((a) => a.length)) + 1;
  const cellW = 8;
  console.error('\n=== pairwise finish-ahead 率 行列（行が列より上位に入った率） ===');
  let header = pad('row\\col', labelW);
  for (let j = 0; j < n; j++) header += padL(ais[j].slice(0, cellW - 1), cellW);
  header += padL('GP', 7);
  console.error(header);
  for (let i = 0; i < n; i++) {
    let line = pad(ais[i], labelW);
    let gpRow = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) {
        line += padL('—', cellW);
        continue;
      }
      const g = pw.games[i][j];
      gpRow += g;
      const rate = g > 0 ? (pw.wins[i][j] / g) * 100 : NaN;
      line += padL(Number.isNaN(rate) ? '·' : rate.toFixed(1), cellW);
    }
    line += padL(String(gpRow), 7);
    console.error(line);
  }
  console.error('(GP = その行 AI が関わった pairwise 比較の総件数)');
}

function printRatings(ais: string[], ratings: number[], pw: Pairwise): number[] {
  const order = ais.map((_, i) => i).sort((a, b) => ratings[b] - ratings[a]);
  const labelW = Math.max(10, ...ais.map((a) => a.length)) + 1;
  console.error('\n=== Elo レーティング（降順, 平均 1500 正規化） ===');
  console.error(pad('rank', 6) + pad('AI', labelW) + padL('Elo', 9) + padL('Δ次位', 9) + padL('総対戦', 9));
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    let totalG = 0;
    for (let j = 0; j < ais.length; j++) totalG += pw.games[i][j];
    const diff = k + 1 < order.length ? ratings[i] - ratings[order[k + 1]] : 0;
    console.error(
      pad(String(k + 1), 6) +
        pad(ais[i], labelW) +
        padL(ratings[i].toFixed(1), 9) +
        padL(k + 1 < order.length ? '+' + diff.toFixed(0) : '—', 9) +
        padL(String(totalG), 9)
    );
  }
  return order;
}

interface Cycle {
  triple: [string, string, string];
  rates: [number, number, number]; // a>b, b>c, c>a の率
}

/** 非推移トリプル（a>b>c>a が全て >50%）を検出。 */
function findIntransitiveCycles(ais: string[], pw: Pairwise): Cycle[] {
  const n = ais.length;
  const beats = (i: number, j: number): number | null => {
    const g = pw.games[i][j];
    if (g === 0) return null;
    return pw.wins[i][j] / g;
  };
  const cycles: Cycle[] = [];
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      for (let c = 0; c < n; c++) {
        if (a === b || b === c || a === c) continue;
        if (a < b || a < c) continue; // a を最小 index に固定して順序重複を抑制
        const ab = beats(a, b);
        const bc = beats(b, c);
        const ca = beats(c, a);
        if (ab === null || bc === null || ca === null) continue;
        if (ab > 0.5 && bc > 0.5 && ca > 0.5) {
          cycles.push({ triple: [ais[a], ais[b], ais[c]], rates: [ab, bc, ca] });
        }
      }
    }
  }
  return cycles;
}

// ─────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────
function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const ais = args.ais;
  const n = ais.length;
  const deciders = ais.map((name) => AI_FACTORIES[name]());

  const t0 = Date.now();
  const pw = newPairwise(n);
  const stats: SeatStats = { totalGames: 0, unfinished: 0, totalSteps: 0, totalMs: 0 };

  console.error('====================================================================');
  console.error(' MeteoNight CPU AI ― round-robin Elo ladder');
  console.error('====================================================================');
  console.error(`AIs (${n}): ${ais.join(', ')}`);
  console.error(`seed=${args.seed}  maxSteps=${args.maxSteps}`);
  console.error(`方式 A (directional, homogeneous opp, seat-rotate): ${args.games > 0 ? 'ON' : 'OFF (--games 0)'}`);
  console.error(`方式 B (mixed table, ranking-derived): ${args.mixed ? 'ON' : 'OFF'}`);

  // ── 方式 A ──
  const orderedPairs = n * (n - 1);
  let perPairGames = 0;
  if (args.games > 0) {
    const res = runDirectional(ais, deciders, args.games, args.seed, args.maxSteps, pw, stats);
    perPairGames = res.perPairGames;
    if (res.capped) {
      console.error(
        `[capped] 方式 A: --games=${args.games} を全席均等化のため ${perPairGames}/順序対 に丸めた（4 の倍数）。`
      );
    }
    const dirGames = orderedPairs * perPairGames;
    console.error(
      `[方式A] 順序対 ${orderedPairs} × ${perPairGames} 局 = ${dirGames} 局 完了（経過 ${((Date.now() - t0) / 1000).toFixed(1)}s）`
    );
  } else {
    console.error('[方式A] スキップ（--games 0）。Elo は方式 B のみから算出。');
  }

  // ── 方式 B（任意）──
  let mixedInfo: { tables: number[][]; gamesPerTablePerm: number } | null = null;
  if (args.mixed) {
    const before = stats.totalGames;
    mixedInfo = runMixed(ais, deciders, args.mixedGames, args.seed + 500000, args.maxSteps, pw, stats);
    const mixedGames = stats.totalGames - before;
    console.error(
      `[方式B] テーブル ${mixedInfo.tables.length} × 席置換 4 × ${mixedInfo.gamesPerTablePerm} 局 = ${mixedGames} 局 完了（経過 ${((Date.now() - t0) / 1000).toFixed(1)}s）`
    );
    if (n > 4) {
      console.error(
        `[capped] 方式 B: N=${n}>4 のため全 C(${n},4) 卓ではなく ${mixedInfo.tables.length} 卓を乱数抽出（無言切り詰めではない）。卓: ` +
          mixedInfo.tables.map((t) => '[' + t.map((x) => ais[x]).join('+') + ']').join(' ')
      );
    }
  }

  // ── レーティング ──
  const ratings = computeElo(pw);
  const order = printRatings(ais, ratings, pw);
  printMatrix(ais, pw);

  // ── 非推移サイクル ──
  const cycles = findIntransitiveCycles(ais, pw);
  console.error('\n=== 非推移サイクル検出（A>B>C>A が全方向 >50%） ===');
  if (cycles.length === 0) {
    console.error('検出なし（全 triple が推移的 = ラダーは整合的）。');
  } else {
    for (const c of cycles) {
      console.error(
        `⚠️ ${c.triple[0]} > ${c.triple[1]} (${(c.rates[0] * 100).toFixed(1)}%) > ${c.triple[2]} (${(c.rates[1] * 100).toFixed(1)}%) > ${c.triple[0]} (${(c.rates[2] * 100).toFixed(1)}%)`
      );
    }
  }

  // ── 解釈 ──
  const topIdx = order[0];
  const tempoIdx = ais.indexOf('tempo50');
  const mctsIdx = ais.indexOf('mctsGen3X');
  console.error('\n=== 解釈 ===');
  console.error(`総ゲーム数: ${stats.totalGames}  未完了: ${stats.unfinished}  平均 ms/step: ${stats.totalSteps > 0 ? (stats.totalMs / stats.totalSteps).toFixed(3) : 'NA'}`);
  console.error(`首位: ${ais[topIdx]} (Elo ${ratings[topIdx].toFixed(1)})`);
  if (tempoIdx >= 0) {
    const tempoRank = order.indexOf(tempoIdx) + 1;
    console.error(`tempo50 の順位: ${tempoRank}/${n} (Elo ${ratings[tempoIdx].toFixed(1)})`);
    if (mctsIdx >= 0) {
      const gap = ratings[tempoIdx] - ratings[mctsIdx];
      const g = pw.games[tempoIdx][mctsIdx];
      const h2h = g > 0 ? (pw.wins[tempoIdx][mctsIdx] / g) * 100 : NaN;
      console.error(
        `tempo50 − mctsGen3X の Elo 差: ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}  (直接 finish-ahead ${Number.isNaN(h2h) ? 'NA' : h2h.toFixed(1) + '%'}, ${g} 件)`
      );
    }
    console.error(
      tempoRank === 1
        ? '→ tempo50 はフィールド全体で明確に首位。'
        : '→ tempo50 は首位ではない（下記 Elo 差・行列を参照）。'
    );
  }

  // ── JSON ──
  if (args.json) {
    const out = {
      methodology: {
        schemeA: 'directional homogeneous: focus 1 seat vs 3 identical opp, seat rotated; pairwise finish-ahead per game',
        schemeB: args.mixed ? 'mixed 4-distinct table, seat rotations, pairwise finish-ahead from ranking' : 'disabled',
        eloFit: 'iterative offline Elo over aggregated pairwise finish-ahead (BT-equivalent), mean-normalized to 1500',
      },
      ais,
      seed: args.seed,
      perPairGames,
      mixed: args.mixed,
      mixedTables: mixedInfo ? mixedInfo.tables.map((t) => t.map((x) => ais[x])) : null,
      totalGames: stats.totalGames,
      unfinished: stats.unfinished,
      ratings: ais.map((name, i) => ({ ai: name, elo: ratings[i] })).sort((a, b) => b.elo - a.elo),
      finishAheadMatrix: ais.map((rowName, i) => ({
        ai: rowName,
        vs: ais.map((colName, j) => ({
          ai: colName,
          games: pw.games[i][j],
          finishAheadRate: pw.games[i][j] > 0 ? pw.wins[i][j] / pw.games[i][j] : null,
        })),
      })),
      intransitiveCycles: cycles,
    };
    console.log(JSON.stringify(out, null, 2));
  }

  console.error(`\n総経過 ${((Date.now() - t0) / 1000).toFixed(1)}s, 総ゲーム ${stats.totalGames}`);
}

main();
