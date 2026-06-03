import { useMemo } from 'react';
import type { CSSProperties } from 'react';

interface Star {
  xPct: number;
  yPct: number;
  size: number; // 芯の直径 px（実体の大きさではなく描画上の芯）
  opacity: number;
  color: string; // 彩度を明るさに連動させて適用済みの最終色
  glow: number; // グロー半径 px（0 = グロー無し＝微光星）
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * B−V（スペクトル型）由来の星色。黒体色の知覚近似で、いずれも淡い（実際の星の色は薄い）。
 * weight は「肉眼で見える星」の色の偏り（青白・白が大半／赤はごく少数）に寄せた出現比。
 * 宇宙の真の比率（M型76%）ではなく、観測選択効果で偏った“見えている空”の比率を使う。
 */
const STAR_TINTS: { rgb: [number, number, number]; weight: number }[] = [
  { rgb: [160, 188, 255], weight: 30 }, // O/B 青白
  { rgb: [245, 247, 255], weight: 30 }, // A   白
  { rgb: [255, 246, 230], weight: 15 }, // F   黄みの白
  { rgb: [255, 241, 216], weight: 8 }, // G   淡黄
  { rgb: [255, 206, 150], weight: 14 }, // K   橙
  { rgb: [255, 170, 120], weight: 3 }, // M巨星 橙赤
];
const TINT_TOTAL = STAR_TINTS.reduce((s, t) => s + t.weight, 0);

function pickTint(): [number, number, number] {
  let r = Math.random() * TINT_TOTAL;
  for (const t of STAR_TINTS) {
    if ((r -= t.weight) <= 0) return t.rgb;
  }
  return STAR_TINTS[1].rgb;
}

/**
 * 最終色を作る。彩度は明るさに比例して開く（暗い星は白へ寄る＝暗所では色覚が働かず
 * 微光星は無彩色に見える）。下方（地平線側）ほど大気減光でわずかに橙へ寄せる。
 */
function makeColor(tint: [number, number, number], brightnessT: number, horizonT: number): string {
  const satT = clamp01((brightnessT - 0.35) / 0.65);
  let r = 255 + (tint[0] - 255) * satT;
  let g = 255 + (tint[1] - 255) * satT;
  let b = 255 + (tint[2] - 255) * satT;
  // 地平線減光：下端ほど橙へ寄せる
  const warm = 0.15 * horizonT;
  g += (210 - g) * warm * 0.5;
  b += (150 - b) * warm;
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

/**
 * brightnessT(0=最暗, 1=最輝) と画面位置から 1 星を構築する。
 * 明るさはポグソンの式（5 等差＝100 倍）でフラックスに直し、不透明度・グロー・芯サイズへ写す。
 * 大きさの差ではなく、にじみ（グロー）と不透明度で明るさを表現する。
 */
function makeStar(xPct: number, yPct: number, brightnessT: number): Star {
  // 等級 m: brightnessT=1 → m=1(最輝), =0 → m=6(肉眼限界相当)
  const m = lerp(6, 1, brightnessT);
  const flux = Math.pow(2.512, -(m - 1)); // m=1 で 1、m=6 で約 0.01
  const opacityBase = Math.max(0.18, Math.min(1, 0.22 + 0.78 * Math.pow(flux, 0.45)));
  const size = lerp(0.6, 2.4, brightnessT);
  const glow = brightnessT < 0.5 ? 0 : lerp(0, 14, (brightnessT - 0.5) / 0.5);
  const horizonT = clamp01((yPct - 60) / 40); // 下 60% から効き始め下端で最大
  const opacity = opacityBase * (1 - 0.5 * horizonT); // 地平線減光
  const color = makeColor(pickTint(), brightnessT, horizonT);
  return { xPct, yPct, size, opacity, color, glow };
}

// 天の川の帯：画面中心を通り傾けた線（CSS の .bg-milkyway と同じ -24°）。
const MW_ANGLE = (-24 * Math.PI) / 180;
const MW_COS = Math.cos(MW_ANGLE);
const MW_SIN = Math.sin(MW_ANGLE);

/**
 * 星を一度だけ生成する。等級バンドを 1 段ごとに約 3 倍へ積み上げ（少数の主役＋多数の地の星）、
 * 一部を天の川帯に寄せて粗密のムラを作る。タイル繰り返しを使わず一意配置するため継ぎ目が出ない。
 * アニメーションはしない（初回生成後は静止）。
 */
function generateStars(): Star[] {
  const stars: Star[] = [];

  // [個数, brightnessT 中心]。暗いバンドほど個数が約 3 倍（実際の等級別星数分布に倣う）。
  const bands: [number, number][] = [
    [8, 1.0], // 最輝（1 等相当）
    [22, 0.8], // 2 等相当
    [60, 0.6], // 3 等相当
    [170, 0.4], // 4 等相当
    [440, 0.2], // 5 等相当
    [700, 0.05], // 6 等相当以下（地の星）
  ];

  for (const [count, bt] of bands) {
    for (let i = 0; i < count; i++) {
      const brightnessT = clamp01(bt + rand(-0.08, 0.08));
      let xPct: number;
      let yPct: number;
      if (Math.random() < 0.45) {
        // 天の川帯に寄せる：帯の中心線上の点を取り、帯に直交方向へ薄く散らす
        const t = rand(-1, 1);
        const len = 70;
        const cx = 50 + MW_COS * t * len;
        const cy = 50 + MW_SIN * t * len;
        const off = (Math.random() + Math.random() - 1) * 13; // 帯の太さ
        xPct = clamp01((cx + -MW_SIN * off + rand(-6, 6)) / 100) * 100;
        yPct = clamp01((cy + MW_COS * off + rand(-6, 6)) / 100) * 100;
      } else {
        xPct = rand(0, 100);
        yPct = rand(0, 100);
      }
      stars.push(makeStar(xPct, yPct, brightnessT));
    }
  }

  return stars;
}

export function BgStars() {
  // 初回マウント時に一度だけ生成し、以降は固定（再レンダリングで配置が変わらない）。
  const stars = useMemo(() => generateStars(), []);
  return (
    <div className="bg-stars" aria-hidden>
      <div className="bg-milkyway" />
      {stars.map((s, i) => (
        <span
          key={i}
          className={`bg-star${s.glow > 0 ? ' is-bright' : ''}`}
          style={
            {
              left: `${s.xPct}%`,
              top: `${s.yPct}%`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              opacity: s.opacity,
              '--c': s.color,
              '--glow': `${s.glow}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
