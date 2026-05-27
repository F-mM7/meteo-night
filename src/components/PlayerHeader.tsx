import type { Player } from '../game/types';

interface Props {
  player: Player;
  isCurrent: boolean;
  position: 'top' | 'bottom' | 'left' | 'right';
}

export function PlayerHeader({ player, isCurrent, position }: Props) {
  return (
    <div
      className={`player-header-card pos-${position}${isCurrent ? ' header-current' : ''}`}
      aria-label={`${player.name} スコア ${player.score}点`}
    >
      <span className="player-name">{player.name}</span>
      <span className="player-score">{player.score}点</span>
    </div>
  );
}
