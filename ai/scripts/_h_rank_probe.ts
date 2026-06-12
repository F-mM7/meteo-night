/**
 * _h_rank_probe ― 劣化先 h 候補の「順位保存率」を実対局の決定点で測る（h 品質のスクリーニング基盤）。
 *
 * 背景: 劣化先 h0（盤面のみの楽観下界）は fresh テストで実害が確定（ai/CHANGELOG.md 2026-06-11）。
 * 以後の h 候補（tstar C2 成果物等）は、seed 帯を消費する fresh テストの前に、本プローブの
 * 順位保存率（argmax 一致率・後悔）で篩う（tstar/REQUESTS.md R2 の品質軸の meteo 側実装）。
 *
 * 測るもの: GRM 席の awaitingPlaceDrawn 決定点ごとに、配置候補盤面（bestDrawnPlacement と同じ列挙）
 * の**非発火候補**を取り、基準値（無予算の T̂＝劣化時に h が代替する値）の argmin と h 候補の
 * argmin の一致率・後悔（基準スケールのターン差）を集計する。発火候補は実装が常に厳密 G ゲートで
 * 評価する（h の守備範囲外）ため順位付けから除外する。
 *
 * 副産物（tstar への供給物）:
 *  --export-decisions <path>: 決定点 JSONL（盤面・山札/捨札カウント・pending・候補盤面）
 *      ＝ R6 の「実サイズ代表盤面セット」（T̂/q の wall-clock 計測・h 候補の順位保存率測定の共通入力）
 *  --export-fire <path>: 発火形候補パターンの頻度統計（色置換 120 × スロット整列の正準形で簡約）
 *      ＝ q 値前計算テーブル（TSTAR-DEPS §2）の被覆設計の材料
 *
 * 例: npx tsx ai/scripts/_h_rank_probe.ts --games 8 --seed 4242 \
 *       --export-decisions /home/futa/tstar/artifacts/meteo-real-decisions.jsonl \
 *       --export-fire /home/futa/tstar/artifacts/meteo-fire-patterns.json
 */
import { writeFileSync } from 'node:fs';
import { playOneGameWithDeciders, parseIntArg, parseFloatArg, type Decider } from './_runner';
import { decideAction as decideGrm, estimateTHat, h0Turns, h0TurnsReal, type GrmOptions } from '../../src/ai/grmAI';
import { decideAction as decideTempoChain } from '../../src/ai/tempoChainAI';
import { fireSlots, placeColorOnSlots, colorCounts, type ColorCounts } from '../../src/ai/grmReachQ';
import type { Color, GameState } from '../../src/game/types';
import { COLORS } from '../../src/game/types';

interface DecisionPoint {
  slots: Color[][];
  deck: ColorCounts;
  discard: ColorCounts;
  pending: Color[];
}

interface Candidate {
  board: Color[][];
  fired: boolean;
}

function serializeBoard(slots: Color[][]): string {
  return slots.map((s) => s.map((c) => c[0]).join('')).join('|');
}

/** bestDrawnPlacement と同じ候補列挙（同色 1 回・両積み順・同型盤面は初出のみ）。 */
function enumerateCandidates(slots: Color[][], colors: Color[], K: number): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (board: Color[][]) => {
    const sig = serializeBoard(board);
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ board, fired: fireSlots(board) });
  };
  const tried = new Set<Color>();
  for (let ci = 0; ci < colors.length; ci++) {
    const color = colors[ci];
    if (tried.has(color)) continue;
    tried.add(color);
    const rest = colors.filter((_, k) => k !== ci);
    for (let j = 0; j < slots.length; j++) {
      const b1 = placeColorOnSlots(slots, j, color, K);
      if (rest.length === 0) {
        push(b1);
      } else {
        for (let j2 = 0; j2 < slots.length; j2++) {
          push(placeColorOnSlots(b1, j2, rest[0], K));
        }
      }
    }
  }
  return out;
}

// --- 発火形パターンの正準化（被覆設計用の対称性簡約） ---
// q は一様山札の世界では色置換・スロット置換に不変なので、正準形＝「色置換 120 通り × スロット辞書順
// 整列」の辞書順最小で数える。実山札では色置換不変性は破れるが、被覆規模の見積りには十分。
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}
const COLOR_PERMS: Record<Color, string>[] = permutations([...COLORS]).map((perm) => {
  const m = {} as Record<Color, string>;
  perm.forEach((c, i) => {
    m[c] = 'abcde'[i];
  });
  return m;
});

function canonicalPattern(board: Color[][]): string {
  let best: string | null = null;
  for (const perm of COLOR_PERMS) {
    const mapped = board.map((st) => st.map((c) => perm[c]).join(''));
    mapped.sort();
    const sig = mapped.join('|');
    if (best === null || sig < best) best = sig;
  }
  return best!;
}

// --- h 候補のレジストリ（拡張点: C2 成果物は --c2 <artifact.json> で動的登録） ---
type HFn = (slots: Color[][], deck: ColorCounts, discard: ColorCounts) => number;
const ESTIMATORS: Record<string, HFn> = {
  h0: (slots) => h0Turns(slots),
};

/**
 * tstar の C2 系成果物（プローブゼロ h 候補）をレジストリへ登録する。
 * 推論は tstar/src/c2.ts の `createFitted`（純 TS。盤面は色インデックスの number[][]、
 * 特徴量は色置換不変なので色→番号の対応は一貫していれば任意）。tstar が無い環境では
 * --c2 を渡さなければ依存しない（動的 import）。
 */
async function registerC2(c2Path: string, tstarSrc: string, V: number, P: number, K: number): Promise<void> {
  const { readFileSync } = await import('node:fs');
  const c2 = await import(`${tstarSrc}/c2.ts`);
  const artifact = JSON.parse(readFileSync(c2Path, 'utf8'));
  const inst = { m: COLORS.length, L: 5, K, V, P };
  const fitted = c2.createFitted({ ...artifact, inst });
  const toBoard = (slots: Color[][]): number[][] => slots.map((st) => st.map((c) => COLORS.indexOf(c)));
  const name = c2Path.split('/').pop();
  ESTIMATORS[`c2(${name})@P${P}`] = (slots) => fitted(toBoard(slots));
  // 実分布ハイブリッド: 一様学習の C2 に「実レート h0 − 一様 h0」の閉形式差分で山札の偏りを注入。
  ESTIMATORS[`c2hyb(${name})@P${P}`] = (slots, deck, discard) =>
    Math.max(0, fitted(toBoard(slots)) + h0TurnsReal(slots, deck, discard) - h0Turns(slots));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

async function main(): Promise<void> {
  let games = 8;
  let seed = 4242;
  let V = 20;
  let P = 0.5;
  let K = 6;
  let budget = 3000; // GRM 席のプレイは配信構成（決定点の分布を配信実態に合わせる）
  let exportDecisions = '';
  let exportFire = '';
  const c2Paths: string[] = [];
  let tstarSrc = '/home/futa/tstar/src';
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--V') V = parseIntArg('--V', argv[++i]);
    else if (k === '--P') P = parseFloatArg('--P', argv[++i]);
    else if (k === '--K') K = parseIntArg('--K', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--export-decisions') exportDecisions = argv[++i] ?? '';
    else if (k === '--export-fire') exportFire = argv[++i] ?? '';
    else if (k === '--c2') c2Paths.push(argv[++i] ?? '');
    else if (k === '--tstar-src') tstarSrc = argv[++i] ?? tstarSrc;
    else throw new Error(`unknown arg: ${k}`);
  }
  for (const p of c2Paths) await registerC2(p, tstarSrc, V, P, K);
  const grmOptions: GrmOptions = { V, P, H: 1, K, timeBudgetMs: budget };

  // --- 1) 実対局から決定点を収集（評価は対局後にまとめて行い、対局へ干渉しない） ---
  const decisions: DecisionPoint[] = [];
  const collect: Decider = (state: GameState, pid: number) => {
    if (state.phase === 'awaitingPlaceDrawn' && state.currentPlayerIndex === pid) {
      const pending = state.turn.pendingDraw.map((c) => c.color);
      if (pending.length > 0) {
        decisions.push({
          slots: state.players[pid].board.slots.map((s) => s.stack.map((c) => c.color)),
          deck: colorCounts(state.deck),
          discard: colorCounts(state.discardPile),
          pending,
        });
      }
    }
    return decideGrm(state, pid, undefined, grmOptions);
  };
  const base: Decider = (s, p) => decideTempoChain(s, p);

  console.error(`[h-rank] GRM(V=${V},P=${P},K=${K},budget=${budget}) 1席 vs tempoChain 3席 | games=${games} seed=${seed}`);
  for (let g = 0; g < games; g++) {
    const grmSeat = g % 4;
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === grmSeat ? collect : base));
    const r = playOneGameWithDeciders({ seed: seed + g, deciders, maxSteps: 20000 });
    console.error(`  game ${g + 1}/${games}: decisions=${decisions.length} finished=${r.finished}`);
  }

  // --- 2) 候補列挙と基準値（無予算 T̂）・h 候補値の評価 ---
  const refOptions: GrmOptions = { V, P, K }; // timeBudget なし＝劣化しない基準値
  const stats = Object.fromEntries(
    Object.keys(ESTIMATORS).map((name) => [name, { ranked: 0, agree: 0, regrets: [] as number[] }])
  );
  const firePatterns = new Map<string, number>();
  const jsonl: string[] = [];
  let rankedDecisions = 0;
  let candTotal = 0;
  for (const d of decisions) {
    const cands = enumerateCandidates(d.slots, d.pending, K);
    candTotal += cands.length;
    for (const c of cands) {
      if (c.fired) {
        const key = canonicalPattern(c.board);
        firePatterns.set(key, (firePatterns.get(key) ?? 0) + 1);
      }
    }
    if (exportDecisions) {
      jsonl.push(
        JSON.stringify({
          V,
          P,
          K,
          slots: d.slots.map((s) => s.join(',')),
          deck: d.deck,
          discard: d.discard,
          pending: d.pending,
          candidates: cands.map((c) => ({ slots: c.board.map((s) => s.join(',')), fired: c.fired })),
        })
      );
    }
    const nonFired = cands.filter((c) => !c.fired);
    if (nonFired.length < 2) continue; // 順位付けの問いが成立しない
    rankedDecisions++;
    const ref = nonFired.map((c) => estimateTHat(c.board, d.deck, d.discard, refOptions));
    const refMin = Math.min(...ref);
    for (const [name, fn] of Object.entries(ESTIMATORS)) {
      const hv = nonFired.map((c) => fn(c.board, d.deck, d.discard));
      const hMin = Math.min(...hv);
      const pick = hv.findIndex((v) => v <= hMin + 1e-9); // 先勝ち（実装のタイブレーク規約と同じ）
      const st = stats[name];
      st.ranked++;
      const regret = ref[pick] - refMin;
      if (regret <= 1e-9) st.agree++;
      st.regrets.push(Math.max(0, regret));
    }
  }

  // --- 3) 出力 ---
  if (exportDecisions) {
    writeFileSync(exportDecisions, jsonl.join('\n') + '\n');
    console.error(`[h-rank] decisions exported: ${exportDecisions} (${jsonl.length} lines)`);
  }
  if (exportFire) {
    const sorted = [...firePatterns.entries()].sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, n]) => s + n, 0);
    let acc = 0;
    let top50 = 0;
    let top90 = 0;
    for (let i = 0; i < sorted.length; i++) {
      acc += sorted[i][1];
      if (top50 === 0 && acc >= total * 0.5) top50 = i + 1;
      if (top90 === 0 && acc >= total * 0.9) top90 = i + 1;
    }
    writeFileSync(
      exportFire,
      JSON.stringify(
        {
          note: '発火形候補パターンの頻度（色置換120×スロット整列の正準形）。q テーブル被覆設計の材料',
          source: { games, seed, V, P, K, budget },
          totalOccurrences: total,
          distinctPatterns: sorted.length,
          patternsCovering50pct: top50,
          patternsCovering90pct: top90,
          patterns: sorted.map(([pattern, count]) => ({ pattern, count })),
        },
        null,
        2
      )
    );
    console.error(`[h-rank] fire patterns exported: ${exportFire} (${sorted.length} distinct)`);
  }
  const summary = {
    config: { games, seed, V, P, K, budget },
    decisions: decisions.length,
    rankedDecisions,
    avgCandidates: +(candTotal / Math.max(1, decisions.length)).toFixed(1),
    estimators: Object.fromEntries(
      Object.entries(stats).map(([name, st]) => {
        const sorted = [...st.regrets].sort((a, b) => a - b);
        return [
          name,
          {
            ranked: st.ranked,
            argmaxAgreeRate: +(st.agree / Math.max(1, st.ranked)).toFixed(4),
            meanRegretTurns: +(sorted.reduce((s, x) => s + x, 0) / Math.max(1, sorted.length)).toFixed(4),
            p90RegretTurns: +percentile(sorted, 0.9).toFixed(4),
            maxRegretTurns: +(sorted[sorted.length - 1] ?? 0).toFixed(4),
          },
        ];
      })
    ),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
