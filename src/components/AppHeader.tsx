import type { CpuSpeed } from '../hooks/useGameLogic';

interface Props {
  cpuSpeed: CpuSpeed;
  setCpuSpeed: (s: CpuSpeed) => void;
  autoPilot: boolean;
  setAutoPilot: (v: boolean) => void;
  onStartNewGame: () => void;
}

export function AppHeader({
  cpuSpeed,
  setCpuSpeed,
  autoPilot,
  setAutoPilot,
  onStartNewGame,
}: Props) {
  return (
    <header className="app-header">
      <h1 className="app-title">星を放つ夜</h1>
      <span className="app-subtitle">CPU対戦版</span>
      <div className="header-controls">
        <label className="header-control">
          <span className="header-control-label">CPU速度</span>
          <select
            className="header-select"
            value={cpuSpeed}
            onChange={(e) => setCpuSpeed(e.target.value as CpuSpeed)}
          >
            <option value="fast">高速</option>
            <option value="normal">標準</option>
            <option value="slow">ゆっくり</option>
            <option value="verySlow">じっくり</option>
          </select>
        </label>
        <label className="header-control autopilot-toggle">
          <input
            type="checkbox"
            checked={autoPilot}
            onChange={(e) => setAutoPilot(e.target.checked)}
          />
          観戦モード
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-restart"
          onClick={onStartNewGame}
        >
          新規ゲーム
        </button>
      </div>
    </header>
  );
}
