import type { Card, Color } from '../game/types';

interface Props {
  card: Card;
  emphasized?: boolean;
  facedown?: boolean;
}

const COLOR_LABEL: Record<Color, string> = {
  red: '赤',
  green: '緑',
  yellow: '黄',
  purple: '紫',
  blue: '青',
};

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

export function CardView({ card, emphasized, facedown }: Props) {
  if (facedown) {
    return (
      <div className="card card-facedown" aria-label="裏向き">
        <CrystalMark />
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
