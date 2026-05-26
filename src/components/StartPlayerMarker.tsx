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
      <span className="start-marker-symbol" aria-hidden>
        SP
      </span>
    </div>
  );
}
