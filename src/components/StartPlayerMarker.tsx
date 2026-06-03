import { CrestEmblem } from './CardView';

interface Props {
  position: 'top' | 'bottom' | 'left' | 'right';
}

export function StartPlayerMarker({ position }: Props) {
  return (
    <div
      className={`start-marker start-marker-${position}`}
      aria-label="スタートプレイヤー"
      title="スタートプレイヤー"
    >
      <svg
        className="start-marker-crest"
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden
      >
        <CrestEmblem />
      </svg>
    </div>
  );
}
