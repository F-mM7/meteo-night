import type { CpuSpeed } from '../hooks/useGameLogic';

interface Props {
  cpuSpeed: CpuSpeed;
  setCpuSpeed: (s: CpuSpeed) => void;
  autoPilot: boolean;
  setAutoPilot: (v: boolean) => void;
  logVisible: boolean;
  setLogVisible: (v: boolean) => void;
  onStartNewGame: () => void;
}

const CPU_SPEED_STEP_MS = 50;

export function AppHeader({
  cpuSpeed,
  setCpuSpeed,
  autoPilot,
  setAutoPilot,
  logVisible,
  setLogVisible,
  onStartNewGame,
}: Props) {
  const clamp = (n: number) => (Number.isFinite(n) && n >= 0 ? n : 0);
  const decrement = () => setCpuSpeed(clamp(cpuSpeed - CPU_SPEED_STEP_MS));
  const increment = () => setCpuSpeed(clamp(cpuSpeed + CPU_SPEED_STEP_MS));

  return (
    <header className="app-header">
      <h1 className="app-title">星を放つ夜</h1>
      <div className="header-controls">
        <div className="header-control">
          <span className="header-control-label">CPU速度 (ms)</span>
          <div className="stepper">
            <button
              type="button"
              className="stepper-btn"
              aria-label="CPU速度を下げる"
              onClick={decrement}
              disabled={cpuSpeed <= 0}
            >
              −
            </button>
            <input
              type="number"
              className="stepper-input"
              value={cpuSpeed}
              min={0}
              step={CPU_SPEED_STEP_MS}
              onChange={(e) => setCpuSpeed(clamp(Number(e.target.value)))}
              aria-label="CPU速度 (ms)"
            />
            <button
              type="button"
              className="stepper-btn"
              aria-label="CPU速度を上げる"
              onClick={increment}
            >
              ＋
            </button>
          </div>
        </div>
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
          className="btn btn-ghost"
          aria-pressed={!logVisible}
          onClick={() => setLogVisible(!logVisible)}
        >
          {logVisible ? 'ログ非表示' : 'ログ表示'}
        </button>
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
