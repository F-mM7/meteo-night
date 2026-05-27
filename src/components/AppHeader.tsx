import { useEffect, useRef, useState } from 'react';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  const clamp = (n: number) => (Number.isFinite(n) && n >= 0 ? n : 0);
  const decrement = () => setCpuSpeed(clamp(cpuSpeed - CPU_SPEED_STEP_MS));
  const increment = () => setCpuSpeed(clamp(cpuSpeed + CPU_SPEED_STEP_MS));

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  return (
    <header className="app-header">
      <h1 className="app-title">星を放つ夜</h1>
      <button
        type="button"
        className="btn btn-ghost btn-restart"
        onClick={onStartNewGame}
      >
        新規ゲーム
      </button>
      <div className="header-menu-wrap" ref={menuWrapRef}>
        <button
          type="button"
          className="hamburger-btn"
          aria-label="設定メニュー"
          aria-expanded={menuOpen}
          aria-haspopup="true"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span className="hamburger-icon" aria-hidden />
        </button>
        {menuOpen && (
          <div className="header-menu" role="menu">
            <div className="header-menu-item">
              <span className="header-menu-label">CPU速度 (ms)</span>
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
            <label className="header-menu-item header-menu-toggle">
              <input
                type="checkbox"
                checked={autoPilot}
                onChange={(e) => setAutoPilot(e.target.checked)}
              />
              観戦モード
            </label>
            <label className="header-menu-item header-menu-toggle">
              <input
                type="checkbox"
                checked={logVisible}
                onChange={(e) => setLogVisible(e.target.checked)}
              />
              ログ表示
            </label>
          </div>
        )}
      </div>
    </header>
  );
}
