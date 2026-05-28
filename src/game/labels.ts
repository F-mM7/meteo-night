import type { Color } from './types';

/**
 * カードの色 → 日本語表示ラベル。
 * `Record<Color, string>` 型のため、新色追加時に欠損キーを TypeScript が検出できる。
 */
export const COLOR_LABEL: Record<Color, string> = {
  red: '赤',
  green: '緑',
  yellow: '黄',
  purple: '紫',
  blue: '青',
};
