import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * 「クリアしてからセット」を一度に行う汎用タイマーフック。
 *
 * - `set(cb, ms)` を呼ぶと、既存タイマーがあれば破棄して新しい遅延を仕込む。
 * - `clear()` でいつでも未発火タイマーを取り消せる。
 * - フックがアンマウントされる際は自動でタイマーを破棄する。
 */
export function useTimeout() {
  const ref = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (ref.current !== null) {
      window.clearTimeout(ref.current);
      ref.current = null;
    }
  }, []);

  const set = useCallback(
    (cb: () => void, ms: number) => {
      clear();
      ref.current = window.setTimeout(() => {
        ref.current = null;
        cb();
      }, ms);
    },
    [clear]
  );

  useEffect(() => clear, [clear]);

  // set / clear は安定なので、返すオブジェクトも安定参照にする。
  // これを new object のまま返すと、依存配列に入れた呼び出し側 effect が
  // 毎レンダー再実行されてしまう（CPU 着手タイマーのリセット等の副作用を招く）。
  return useMemo(() => ({ set, clear }), [set, clear]);
}
