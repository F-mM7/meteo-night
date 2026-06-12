import { useEffect, useRef, useState } from 'react';
import type { EffectDelay } from '../hooks/useGameLogic';
import { GRM_P_STAR } from '../ai/grmAI';

interface Props {
  effectDelay: EffectDelay;
  setEffectDelay: (s: EffectDelay) => void;
  autoPilot: boolean;
  setAutoPilot: (v: boolean) => void;
  logVisible: boolean;
  setLogVisible: (v: boolean) => void;
  /** CPU の目標確率 P（既定 P*。1.0 で「確実な発火しか狙わない」保守的＝弱めの CPU になる）。 */
  cpuP: number;
  setCpuP: (v: number) => void;
  onStartNewGame: () => void;
  recordingEnabled: boolean;
  setRecordingEnabled: (v: boolean) => void;
  recordedGameCount: number;
  onExportGames: () => void;
  onClearGames: () => void;
}

const EFFECT_DELAY_STEP_MS = 50;

export function AppHeader({
  effectDelay,
  setEffectDelay,
  autoPilot,
  setAutoPilot,
  logVisible,
  setLogVisible,
  cpuP,
  setCpuP,
  onStartNewGame,
  recordingEnabled,
  setRecordingEnabled,
  recordedGameCount,
  onExportGames,
  onClearGames,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  const clamp = (n: number) => (Number.isFinite(n) && n >= 0 ? n : 0);
  const decrement = () => setEffectDelay(clamp(effectDelay - EFFECT_DELAY_STEP_MS));
  const increment = () => setEffectDelay(clamp(effectDelay + EFFECT_DELAY_STEP_MS));

  const handleClearGames = () => {
    if (recordedGameCount === 0) return;
    if (window.confirm(`記録した ${recordedGameCount} 局をすべて消去しますか？`)) {
      onClearGames();
    }
  };

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
        className="btn btn-primary"
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
              <span className="header-menu-label">演出ディレイ (ms)</span>
              <div className="stepper">
                <button
                  type="button"
                  className="stepper-btn"
                  aria-label="演出ディレイを下げる"
                  onClick={decrement}
                  disabled={effectDelay <= 0}
                >
                  −
                </button>
                <input
                  type="number"
                  className="stepper-input"
                  value={effectDelay}
                  min={0}
                  step={EFFECT_DELAY_STEP_MS}
                  onChange={(e) => setEffectDelay(clamp(Number(e.target.value)))}
                  aria-label="演出ディレイ (ms)"
                />
                <button
                  type="button"
                  className="stepper-btn"
                  aria-label="演出ディレイを上げる"
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
            <label
              className="header-menu-item header-menu-toggle"
              title="CPU が「確実に目標点を取れる発火」しか狙わなくなる保守的な設定（弱め）。オフ＝最適値 P* で最強"
            >
              <input
                type="checkbox"
                checked={cpuP === 1}
                onChange={(e) => setCpuP(e.target.checked ? 1 : GRM_P_STAR)}
              />
              CPU 慎重モード (P=1)
            </label>
            <label className="header-menu-item header-menu-toggle">
              <input
                type="checkbox"
                checked={logVisible}
                onChange={(e) => setLogVisible(e.target.checked)}
              />
              ログ表示
            </label>
            <label className="header-menu-item header-menu-toggle">
              <input
                type="checkbox"
                checked={recordingEnabled}
                onChange={(e) => setRecordingEnabled(e.target.checked)}
              />
              対局を記録
            </label>
            <div className="header-menu-item header-menu-record">
              <span className="header-menu-label">記録: {recordedGameCount} 局</span>
              <div className="record-actions">
                <button
                  type="button"
                  className="btn btn-secondary record-btn"
                  onClick={onExportGames}
                  disabled={recordedGameCount === 0}
                >
                  書き出し
                </button>
                <button
                  type="button"
                  className="btn btn-secondary record-btn"
                  onClick={handleClearGames}
                  disabled={recordedGameCount === 0}
                >
                  消去
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
