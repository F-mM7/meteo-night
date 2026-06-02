import { useMemo } from 'react';

interface Star {
  xPct: number;
  yPct: number;
  size: number;
  opacity: number;
  warm: boolean;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * 星を一度だけ乱数生成する。CSS の background-repeat のようなタイル繰り返しを使わず、
 * 画面全体に一意配置するため継ぎ目（繰り返し）が一切出ない。クラスタ（密集）と
 * 全体散在を混ぜて自然な粗密のムラを作る。アニメーションはしない。
 */
function generateStars(): Star[] {
  const stars: Star[] = [];

  // 全体に散る細かい星（暗め）
  for (let i = 0; i < 340; i++) {
    stars.push({
      xPct: rand(0, 100),
      yPct: rand(0, 100),
      size: rand(0.6, 1.6),
      opacity: rand(0.25, 0.6),
      warm: Math.random() < 0.08,
    });
  }

  // クラスタ（粗密の偏りを作る）: 中心の周りに三角分布で寄せる
  for (let c = 0; c < 7; c++) {
    const cx = rand(8, 92);
    const cy = rand(8, 92);
    const n = Math.floor(rand(18, 34));
    const spreadX = rand(8, 18);
    const spreadY = rand(7, 15);
    for (let i = 0; i < n; i++) {
      const dx = (Math.random() + Math.random() - 1) * spreadX;
      const dy = (Math.random() + Math.random() - 1) * spreadY;
      stars.push({
        xPct: Math.min(100, Math.max(0, cx + dx)),
        yPct: Math.min(100, Math.max(0, cy + dy)),
        size: rand(0.6, 1.8),
        opacity: rand(0.3, 0.7),
        warm: Math.random() < 0.1,
      });
    }
  }

  // 明るい星（少数・大きめ）
  for (let i = 0; i < 40; i++) {
    stars.push({
      xPct: rand(0, 100),
      yPct: rand(0, 100),
      size: rand(1.6, 2.6),
      opacity: rand(0.7, 0.95),
      warm: Math.random() < 0.2,
    });
  }

  return stars;
}

export function BgStars() {
  // 初回マウント時に一度だけ生成し、以降は固定（再レンダリングで配置が変わらない）。
  const stars = useMemo(() => generateStars(), []);
  return (
    <div className="bg-stars" aria-hidden>
      {stars.map((s, i) => (
        <span
          key={i}
          className={`bg-star${s.warm ? ' bg-star-warm' : ''}`}
          style={{
            left: `${s.xPct}%`,
            top: `${s.yPct}%`,
            width: `${s.size}px`,
            height: `${s.size}px`,
            opacity: s.opacity,
          }}
        />
      ))}
    </div>
  );
}
