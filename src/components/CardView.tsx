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

// ===== 裏向きカードの紋章（夜空の円盤＋金の流星十字） =====
// 角丸枠の隅 (cx,cy) を中心に、base±span°（度・y 下向き）の弧へ n 個の珠を等間隔に並べる。
function beadArc(cx: number, cy: number, base: number, span: number, n: number) {
  return Array.from({ length: n }, (_, i) => {
    const a = ((base - span + (2 * span * i) / (n - 1)) * Math.PI) / 180;
    return { x: cx + 12.4 * Math.cos(a), y: cy + 12.4 * Math.sin(a) };
  });
}

// 4 つの先端を凹カーブで結ぶ流星十字。制御点を中心へ t だけ寄せて括れを作る。
function crossPath(tips: ReadonlyArray<readonly [number, number]>, t: number) {
  const c = tips.map(([x, y]) => [x + t * (50 - x), y + t * (50 - y)] as const);
  let d = `M${tips[0][0]},${tips[0][1]}`;
  for (let i = 0; i < tips.length; i++) {
    const j = (i + 1) % tips.length;
    d += ` C${c[i][0]},${c[i][1]} ${c[j][0]},${c[j][1]} ${tips[j][0]},${tips[j][1]}`;
  }
  return `${d}Z`;
}

// 縦長の流星十字（上下の先端が左右より長い）
const STAR_D = crossPath([[50, 10], [76, 50], [50, 90], [24, 50]], 0.57);
// 対角 2 隅（右上・左下）に連ねる主の光珠
const BEADS = [...beadArc(80.5, 19.5, -45, 70, 10), ...beadArc(19.5, 80.5, 135, 70, 10)];
// 残り 2 隅（左上・右下）の控えめな点
const TICKS = [...beadArc(19.5, 19.5, 135, 26, 3), ...beadArc(80.5, 80.5, -45, 26, 3)];

function MeteoCrest() {
  // 複数の裏向きカードが同時に並ぶため、グラデーション ID をインスタンスごとに一意化する
  const uid = useId();
  const med = `${uid}m`;
  const star = `${uid}s`;
  return (
    <svg className="card-back-crest" viewBox="0 0 100 100" aria-hidden>
      <defs>
        <radialGradient id={med} cx="0.35" cy="0.56" r="0.78">
          <stop offset="0" stopColor="#eef0ff" />
          <stop offset="0.28" stopColor="#b3bbf0" />
          <stop offset="0.58" stopColor="#7079d2" />
          <stop offset="0.82" stopColor="#4c4196" />
          <stop offset="1" stopColor="#332868" />
        </radialGradient>
        <radialGradient id={star} cx="0.5" cy="0.44" r="0.6">
          <stop offset="0" stopColor="#fff6bf" />
          <stop offset="0.5" stopColor="#ffe25a" />
          <stop offset="1" stopColor="#f0a818" />
        </radialGradient>
      </defs>
      <rect className="crest-frame" x="6.5" y="6.5" width="87" height="87" rx="13" />
      {BEADS.map((p, i) => (
        <circle key={`b${i}`} className="crest-bead" cx={p.x} cy={p.y} r="1.3" />
      ))}
      {TICKS.map((p, i) => (
        <circle key={`t${i}`} className="crest-tick" cx={p.x} cy={p.y} r="1" />
      ))}
      <circle className="crest-halo" cx="50" cy="50" r="30.4" />
      <circle cx="50" cy="50" r="29" fill={`url(#${med})`} />
      <circle className="crest-disc-rim" cx="50" cy="50" r="29" />
      <path className="crest-star" d={STAR_D} fill={`url(#${star})`} />
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
