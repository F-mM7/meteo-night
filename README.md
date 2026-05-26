# 星を放つ夜（MeteoNight）CPU対戦Web

RIDDLER（リドラ）が制作したボードゲーム『星を放つ夜（MeteoNight）』のCPU対戦版Webアプリです。
プレイヤー1人 vs CPU3体の4人プレイで遊べます。

> 本アプリは非公式のファン作品です。原作のゲームについては [ゲームマーケット公式ページ](https://gamemarket.jp/game/187954) をご覧ください。

## ルール書き起こし

ルール解釈は [`docs/RULES.md`](docs/RULES.md) に書き起こしています。
動画と公式情報から補完しているため、誤りがあれば該当mdとロジックを修正してください。

## ローカル動作確認

```bash
npm install
npm run dev
```

ブラウザで `http://localhost:5173/meteo-night/` を開く。

ヘッダーの「観戦モード」を ON にすると、自分の手番も AI が代行するので、ゲーム挙動全体を眺めて確認できます。

## ビルド & プレビュー

```bash
npm run build
npm run preview
```

## ユニットテスト

```bash
npx vitest run
```

ゲームロジック（連鎖判定・得点計算・基本フロー）の最低限のテストを `src/game/__tests__/` に置いています。

## ディレクトリ構成

```
docs/
  RULES.md             # ルール書き起こし（誤りがあればここを直す）
src/
  ai/                  # CPU 思考（簡易：1手先評価関数）
  components/          # React UI コンポーネント
  game/                # 純粋関数のゲームロジック
    types.ts           # 型定義
    setup.ts           # 初期状態
    combo.ts           # 同色3枚以上の検出・除去
    scoring.ts         # 得点計算（仮：基礎点と同額のコンボボーナス）
    engine.ts          # 連鎖処理ユーティリティ
    reducer.ts         # アクションリデューサー
  hooks/
    useGameLogic.ts    # state 管理 + CPU 自動駆動
  styles/index.css     # 夜空風スタイル
```

## GitHub Pages デプロイ

`main` ブランチへの push で `.github/workflows/deploy.yml` の Actions が走り、GitHub Pages へ自動デプロイされます。

### 初回セットアップ

1. GitHub に **publicリポジトリ** を作成する（任意の名前で OK。例：`meteo-night`）
2. 本ディレクトリで以下を実行:

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin git@github.com:<ユーザー名>/<リポジトリ名>.git
   git push -u origin main
   ```

3. リポジトリの **Settings → Pages → Source** を **GitHub Actions** に変更
4. Actions タブで `Deploy to GitHub Pages` が成功すると公開される

公開URL: `https://<ユーザー名>.github.io/<リポジトリ名>/`

Vite の `base` は CI 時に `BASE_URL=/<リポジトリ名>/` が自動で渡されるため、リポジトリ名を変更しても対応できます。

## 技術スタック

- TypeScript 5
- React 19
- Vite 6
- Vitest 3
- GitHub Pages（GitHub Actions 経由）
