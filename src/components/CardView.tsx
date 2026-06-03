import { useId } from 'react';
import type { Card } from '../game/types';
import { COLOR_LABEL } from '../game/labels';

interface Props {
  card: Card;
  emphasized?: boolean;
  facedown?: boolean;
}

function CrystalMark() {
  return (
    <svg
      className="card-crystal"
      viewBox="0 0 100 100"
      aria-hidden
    >
      <polygon
        className="crystal-tint"
        points="50,8 72,32 68,72 50,92 32,72 28,32"
      />
      <g className="crystal-strokes">
        <polygon
          className="crystal-outline"
          points="50,8 72,32 68,72 50,92 32,72 28,32"
        />
        <line className="crystal-edge" x1="50" y1="8" x2="50" y2="92" />
        <line className="crystal-edge" x1="28" y1="32" x2="72" y2="32" />
        <line className="crystal-edge" x1="32" y1="72" x2="68" y2="72" />
        <line className="crystal-edge crystal-edge-inner" x1="50" y1="8" x2="28" y2="32" />
        <line className="crystal-edge crystal-edge-inner" x1="50" y1="8" x2="72" y2="32" />
        <line className="crystal-edge crystal-edge-inner" x1="50" y1="92" x2="32" y2="72" />
        <line className="crystal-edge crystal-edge-inner" x1="50" y1="92" x2="68" y2="72" />
      </g>
    </svg>
  );
}

// ===== 裏向きカードの紋章（中央の円盤＋流星十字＋隅の装飾フレーム） =====
// 中心から外向きベクトルに直交する向き（時計回り路で先端の左右の肩を出すのに使う）。
function perp([x, y]: readonly [number, number]): [number, number] {
  return [-y, x];
}

// 先端を丸めた流星十字。各先端は「肩 In →（制御点＝尖り）→ 肩 Out」の二次ベジェで丸め、
// 隣り合う肩どうしは中心へ t 寄せた制御点でつないで辺を凹ませる。round が大きいほど先端が丸い。
function roundedCross(tips: ReadonlyArray<readonly [number, number]>, t: number, round: number) {
  const cx = 50, cy = 50;
  const inn: Array<[number, number]> = [];
  const out: Array<[number, number]> = [];
  for (const [x, y] of tips) {
    const dx = x - cx, dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const u: [number, number] = [dx / len, dy / len];
    const v = perp(u);
    const b = round * 0.65, s = round;   // 先端を b 引っ込め、左右へ s ずらした肩
    inn.push([x - b * u[0] - s * v[0], y - b * u[1] - s * v[1]]);
    out.push([x - b * u[0] + s * v[0], y - b * u[1] + s * v[1]]);
  }
  let d = `M${inn[0][0].toFixed(2)},${inn[0][1].toFixed(2)}`;
  for (let i = 0; i < tips.length; i++) {
    const T = tips[i], O = out[i];
    d += ` Q${T[0]},${T[1]} ${O[0].toFixed(2)},${O[1].toFixed(2)}`;
    const j = (i + 1) % tips.length;
    const N = inn[j];
    const c1: [number, number] = [O[0] + t * (cx - O[0]), O[1] + t * (cy - O[1])];
    const c2: [number, number] = [N[0] + t * (cx - N[0]), N[1] + t * (cy - N[1])];
    d += ` C${c1[0].toFixed(2)},${c1[1].toFixed(2)} ${c2[0].toFixed(2)},${c2[1].toFixed(2)} ${N[0].toFixed(2)},${N[1].toFixed(2)}`;
  }
  return `${d}Z`;
}

// 縦長の流星十字（上下の先端が左右より長い）。辺を中央へ深くえぐり、先端は小さめに丸める。
const STAR_D = roundedCross([[50, 8], [88, 50], [50, 92], [12, 50]], 0.7, 2);
// 装飾フレーム（accent 色）: 左上隅と右下隅から各 2 本の線を中央を少し過ぎるまで引く。
const FRAME_INSET = 4;                  // カード端から線までの内側マージン（縁寄り）
const PAST = 68;                        // 中央(50)を少し過ぎる端点（線を少し長めに）
const FAR = 100 - FRAME_INSET;          // 反対の隅 = 88
const NEAR = 100 - PAST;                // = 44
const CORNER_GAP = 10;                   // 左上・右下の角で 2 本の線を離す隙間
const FRAME_LINES = [
  [FRAME_INSET + CORNER_GAP, FRAME_INSET, PAST, FRAME_INSET], // 左上 → 右（角から離す）
  [FRAME_INSET, FRAME_INSET + CORNER_GAP, FRAME_INSET, PAST], // 左上 → 下
  [FAR, FAR - CORNER_GAP, FAR, NEAR],                         // 右下 → 上
  [FAR - CORNER_GAP, FAR, NEAR, FAR],                         // 右下 → 左
] as const;
// 右上: 「左上→右」線端と「右下→上」線端を 90° 弧で結ぶ 5 点。中心 (PAST, NEAR)、半径 FAR-PAST。
// 両端は線の端点（90°/0°）から離すため 15°〜75° に内寄せして配置する。
const ARC_R = FAR - PAST;
const ARC_DOT_R = ARC_R - 3;            // ドットは弧（線端を結ぶ円）より少し内側へ
const ARC_TR = Array.from({ length: 5 }, (_, i) => {
  const a = ((75 - 15 * i) * Math.PI) / 180;
  return { x: PAST + ARC_DOT_R * Math.cos(a), y: NEAR - ARC_DOT_R * Math.sin(a) };
});
// 左下: 右上の点群を中心 (50,50) まわりに 180° 回転して対称配置。
const ARC_DOTS = [...ARC_TR, ...ARC_TR.map((p) => ({ x: 100 - p.x, y: 100 - p.y }))];

// 左上・右下の角: 離れた 2 本の線端の間を、gap に直交する短い線 3 本（並行）で結ぶ。
function linkTicks(ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len; // gap に直交する単位ベクトル（短線の向き）
  const h = 1; // 短線の半長（短め）
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const il = Math.hypot(50 - mx, 50 - my) || 1;
  const ix = ((50 - mx) / il) * 1.5, iy = ((50 - my) / il) * 1.5; // 中央側へ 1.5 ずらす
  return [0.25, 0.5, 0.75].map((t) => {
    const cx = ax + dx * t + ix, cy = ay + dy * t + iy;
    return { x1: cx - px * h, y1: cy - py * h, x2: cx + px * h, y2: cy + py * h };
  });
}
const LINK_TICKS = [
  ...linkTicks(FRAME_INSET + CORNER_GAP, FRAME_INSET, FRAME_INSET, FRAME_INSET + CORNER_GAP), // 左上
  ...linkTicks(FAR, FAR - CORNER_GAP, FAR - CORNER_GAP, FAR),                                 // 右下
];

// 円環: 外＝楕円・内＝楕円を evenodd で抜いた環。45° 回転で右上-左下を太く・左上-右下を細く。
const RING_D =
  'M23.5,50 a26.5,29.5 0 1,0 53,0 a26.5,29.5 0 1,0 -53,0 Z M24.5,50 a25.5,22.5 0 1,0 51,0 a25.5,22.5 0 1,0 -51,0 Z';

// back とスタートプレイヤーマーカーで共通の中央エンブレム（淡青の円環＋金の流星十字）。
// viewBox 0 0 100 100 を前提に、親 <svg> の中へ置いて使う。
export function CrestEmblem() {
  const star = useId();
  return (
    <>
      <defs>
        <radialGradient id={star} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#f6e042" />
          <stop offset="0.55" stopColor="#f9ee95" />
          <stop offset="1" stopColor="#ffffff" />
        </radialGradient>
      </defs>
      <path className="crest-ring" fillRule="evenodd" transform="rotate(45 50 50)" d={RING_D} />
      <path className="crest-star" d={STAR_D} fill={`url(#${star})`} />
    </>
  );
}

export function MeteoCrest() {
  // 複数の裏向きカードが同時に並ぶため、グラデーション ID をインスタンスごとに一意化する
  const uid = useId();
  const panel = `${uid}p`;
  return (
    <svg className="card-back-crest" viewBox="0 0 100 100" aria-hidden>
      <defs>
        <radialGradient id={panel} gradientUnits="userSpaceOnUse" cx="50" cy="50" r="58">
          <stop offset="0" stopColor="#331d58" />
          <stop offset="0.55" stopColor="#180e2c" />
          <stop offset="1" stopColor="#000000" />
        </radialGradient>
      </defs>
      <rect x="-1" y="-1" width="102" height="102" fill={`url(#${panel})`} />
      {FRAME_LINES.map(([x1, y1, x2, y2], i) => (
        <line key={`l${i}`} className="crest-line" x1={x1} y1={y1} x2={x2} y2={y2} />
      ))}
      {ARC_DOTS.map((p, i) => {
        // 各正方形を中央 (50,50) からの半径方向へ回転し、辺が中央を向くようにする
        const deg = (Math.atan2(p.y - 50, p.x - 50) * 180) / Math.PI;
        const s = (i % 5) % 2 === 0 ? 5.6 : 2.8; // 各弧の 1,3,5 番目を約 2 倍に
        return (
          <rect
            key={`d${i}`}
            className="crest-dot"
            x={p.x - s / 2}
            y={p.y - s / 2}
            width={s}
            height={s}
            transform={`rotate(${deg.toFixed(1)} ${p.x.toFixed(2)} ${p.y.toFixed(2)})`}
          />
        );
      })}
      {LINK_TICKS.map((s, i) => (
        <line key={`k${i}`} className="crest-line" x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
      ))}
      <CrestEmblem />
    </svg>
  );
}

export function CardView({ card, emphasized, facedown }: Props) {
  if (facedown) {
    return (
      <div className="card card-facedown" aria-label="裏向き">
        <MeteoCrest />
      </div>
    );
  }
  return (
    <div
      className={`card card-${card.color}${emphasized ? ' card-emphasized' : ''}`}
      title={COLOR_LABEL[card.color]}
      aria-label={`${COLOR_LABEL[card.color]}の星のかけら`}
    >
      <CrystalMark />
    </div>
  );
}
