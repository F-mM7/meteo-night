import type { Card, Color } from '../game/types';

interface Props {
  card: Card;
  size?: 'sm' | 'md' | 'lg';
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
      <g className="card-crystal-strokes">
        <polygon points="50,12 62,38 62,62 50,88 38,62 38,38" />
        <line x1="50" y1="12" x2="50" y2="88" />
        <line x1="38" y1="38" x2="62" y2="38" />
        <line x1="38" y1="62" x2="62" y2="62" />
        <line x1="38" y1="38" x2="62" y2="62" />
        <line x1="62" y1="38" x2="38" y2="62" />
      </g>
    </svg>
  );
}

export function CardView({ card, size = 'md', emphasized, facedown }: Props) {
  if (facedown) {
    return (
      <div className={`card card-facedown card-${size}`} aria-label="裏向き">
        <CrystalMark />
      </div>
    );
  }
  return (
    <div
      className={`card card-${size} card-${card.color}${emphasized ? ' card-emphasized' : ''}`}
      title={COLOR_LABEL[card.color]}
      aria-label={`${COLOR_LABEL[card.color]}の星のかけら`}
    >
      <CrystalMark />
    </div>
  );
}
