/**
 * 「固定 tempoFast 撃破」適応度の (μ,λ)-ES。遺伝子セットを --ai で切替:
 *   --ai weights : 評価の静的特徴（攻撃/構造系の EvalWeights）を進化（Stage 1, Gen-13）。
 *   --ai build   : tempoBuildAI の build policy パラメータを進化（Stage 2: 多ターン構築の自動調律）。
 *
 * 適応度は自己参照でない目標＝「tempoFast(DEFAULT) 3 席に 1 席で挑んだ勝率」（人間が同構造で 55% ＝
 * 到達可能と実証済み。`ai/scripts/eval-fitness.ts`）。世代内 CRN（同一シードで paired 比較）＋世代間
 * シード回転（過適合防止）、子プロセス並列、σ 焼きなまし、最良個体を毎世代 JSON 保存。
 * 最良個体は**新規シード + 適正 budget**で要検証（学習適応度の上振れ＝winner's curse を弾く）。
 *
 *   npx tsx ai/scripts/evolve-weights.ts --ai build --gens 18 --lambda 12 --mu 4 --games 40 --budget 200 --seed 620000 --out /tmp/evolve-build.json
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { DEFAULT_WEIGHTS, type EvalWeights } from '../../src/ai/evaluator';
import { parseIntArg, parseFloatArg } from './_runner';

const execFileP = promisify(execFile);

interface Gene {
  name: string;
  init: number;
}

/** --ai weights: 評価の攻撃/構造系特徴（基盤スケール selfScoreMult/winnerBonus 等は固定）。 */
const WEIGHTS_GENES: Gene[] = (
  [
    'reach5plus',
    'reach4',
    'reach3',
    'reach2',
    'reach1',
    'chainSeed',
    'chainReadyMult',
    'cascade2',
    'cascade3plus',
    'pendingMult',
    'overflowPenalty',
  ] as (keyof EvalWeights)[]
).map((k) => ({ name: k, init: DEFAULT_WEIGHTS[k] }));

/** --ai build: tempoBuildAI のパラメータ（src/ai/tempoBuildAI.ts の DEFAULT_BUILD_* に対応）。 */
const BUILD_GENES: Gene[] = [
  { name: 'buildLoadW', init: 600 },
  { name: 'buildNearW', init: 120 },
  { name: 'buildFirePenalty', init: 400 },
  { name: 'buildStaticW', init: 0.2 },
  { name: 'dischargeScore', init: 14 },
  { name: 'dischargeLayers', init: 3 },
];

/** main() で --ai に応じて設定（geneToOverride / evalFitness が参照）。 */
let GENE_NAMES: string[] = [];
let AI_MODE = 'weights';

interface Config {
  gens: number;
  lambda: number;
  mu: number;
  games: number;
  budget: number;
  lookahead: number;
  rootSamples: number;
  sigmaFrac: number;
  sigmaFloor: number;
  sigmaDecay: number;
  baseSeed: number;
  out: string;
}

let spare: number | null = null;
function gauss(rng: () => number): number {
  if (spare !== null) {
    const v = spare;
    spare = null;
    return v;
  }
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const mag = Math.sqrt(-2 * Math.log(u));
  spare = mag * Math.sin(2 * Math.PI * v);
  return mag * Math.cos(2 * Math.PI * v);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function geneToOverride(gene: number[]): Record<string, number> {
  const o: Record<string, number> = {};
  GENE_NAMES.forEach((k, i) => {
    o[k] = gene[i];
  });
  return o;
}

/** eval-fitness.ts を子プロセスで実行し勝ち数を返す（並列実行される）。 */
async function evalFitness(
  override: Record<string, number>,
  cfg: Config,
  seed: number
): Promise<number> {
  const { stdout } = await execFileP(
    process.execPath,
    [
      '--import',
      'tsx',
      'ai/scripts/eval-fitness.ts',
      '--ai',
      AI_MODE,
      '--weights',
      JSON.stringify(override),
      '--games',
      String(cfg.games),
      '--seed',
      String(seed),
      '--budget',
      String(cfg.budget),
      '--lookahead',
      String(cfg.lookahead),
      '--root-samples',
      String(cfg.rootSamples),
    ],
    { cwd: process.cwd(), maxBuffer: 1 << 20 }
  );
  const m = stdout.match(/WINS (\d+) (\d+)/);
  if (!m) throw new Error(`eval-fitness の出力が不正: ${stdout}`);
  return parseInt(m[1], 10);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cfg: Config = {
    gens: 20,
    lambda: 12,
    mu: 4,
    games: 40,
    budget: 30,
    lookahead: 0,
    rootSamples: 3,
    sigmaFrac: 0.25,
    sigmaFloor: 20,
    sigmaDecay: 0.93,
    baseSeed: 600000,
    out: '/tmp/evolve-best.json',
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--ai') AI_MODE = argv[++i];
    else if (k === '--gens') cfg.gens = parseIntArg('--gens', argv[++i]);
    else if (k === '--lambda') cfg.lambda = parseIntArg('--lambda', argv[++i]);
    else if (k === '--mu') cfg.mu = parseIntArg('--mu', argv[++i]);
    else if (k === '--games') cfg.games = parseIntArg('--games', argv[++i]);
    else if (k === '--budget') cfg.budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--lookahead') cfg.lookahead = parseIntArg('--lookahead', argv[++i]);
    else if (k === '--root-samples') cfg.rootSamples = parseIntArg('--root-samples', argv[++i]);
    else if (k === '--sigma-frac') cfg.sigmaFrac = parseFloatArg('--sigma-frac', argv[++i]);
    else if (k === '--sigma-floor') cfg.sigmaFloor = parseFloatArg('--sigma-floor', argv[++i]);
    else if (k === '--sigma-decay') cfg.sigmaDecay = parseFloatArg('--sigma-decay', argv[++i]);
    else if (k === '--seed') cfg.baseSeed = parseIntArg('--seed', argv[++i]);
    else if (k === '--out') cfg.out = argv[++i];
    else throw new Error(`unknown arg: ${k}`);
  }
  const geneSet = AI_MODE === 'build' ? BUILD_GENES : WEIGHTS_GENES;
  GENE_NAMES = geneSet.map((g) => g.name);

  const rng = mulberry32(cfg.baseSeed ^ 0x1234);
  let mean = geneSet.map((g) => g.init);
  const t0 = Date.now();

  console.error(
    `[evolve] ai=${AI_MODE} genes=${GENE_NAMES.length} λ=${cfg.lambda} μ=${cfg.mu} games=${cfg.games} budget=${cfg.budget} LA=${cfg.lookahead} gens=${cfg.gens}`
  );
  console.error(`[evolve] 適応度 = 候補(${AI_MODE}) 1席 vs tempoFast(DEFAULT) 3席 の候補勝率（公平25%）`);

  let globalBest = { wins: -1, defWins: -1, gene: mean.slice(), gen: -1 };

  for (let gen = 0; gen < cfg.gens; gen++) {
    const sigmaScale = Math.pow(cfg.sigmaDecay, gen);
    const sigma = mean.map((m) => Math.max(cfg.sigmaFrac * Math.abs(m), cfg.sigmaFloor) * sigmaScale);
    const genSeed = (cfg.baseSeed + gen * cfg.games * 4 + 101) | 0;

    const offspring: number[][] = [];
    offspring.push(mean.slice());
    for (let i = 1; i < cfg.lambda; i++) {
      offspring.push(mean.map((m, d) => Math.max(0, m + gauss(rng) * sigma[d])));
    }

    const tasks = [
      evalFitness({}, cfg, genSeed), // index 0 = DEFAULT/現状 参照（build なら build既定パラメータ）
      ...offspring.map((g) => evalFitness(geneToOverride(g), cfg, genSeed)),
    ];
    const results = await Promise.all(tasks);
    const defWins = results[0];
    const offWins = results.slice(1);

    const order = offWins.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w);
    const topIdx = order.slice(0, cfg.mu).map((x) => x.i);
    const newMean = mean.map((_, d) => topIdx.reduce((s, i) => s + offspring[i][d], 0) / topIdx.length);

    const bestI = order[0].i;
    const bestW = order[0].w;
    if (bestW > globalBest.wins) {
      globalBest = { wins: bestW, defWins, gene: offspring[bestI].slice(), gen };
    }

    const pct = (w: number) => ((100 * w) / cfg.games).toFixed(1);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const changed = GENE_NAMES.map((k, d) => `${k}:${offspring[bestI][d].toFixed(1)}`).join(' ');
    console.error(
      `[gen ${String(gen).padStart(2)}] best候補 ${bestW}/${cfg.games}(${pct(bestW)}%) vs 参照 ${defWins}/${cfg.games}(${pct(defWins)}%) σ×${sigmaScale.toFixed(2)} ${elapsed}s`
    );
    console.error(`           best遺伝子: ${changed}`);

    writeFileSync(
      cfg.out,
      JSON.stringify(
        {
          ai: AI_MODE,
          genes: GENE_NAMES,
          best: geneToOverride(globalBest.gene),
          bestWins: globalBest.wins,
          bestGames: cfg.games,
          bestGen: globalBest.gen,
          currentMean: geneToOverride(newMean),
          config: cfg,
        },
        null,
        2
      )
    );

    mean = newMean;
  }

  console.error(
    `\n[evolve] 完了。globalBest = gen${globalBest.gen} ${globalBest.wins}/${cfg.games}(${((100 * globalBest.wins) / cfg.games).toFixed(1)}%) （同世代 参照 ${globalBest.defWins}/${cfg.games}）`
  );
  console.error(`[evolve] 最良パラメータは ${cfg.out} に保存。新規シード + 適正 budget での検証が必須。`);
  console.log(JSON.stringify(geneToOverride(globalBest.gene)));
}

main();
