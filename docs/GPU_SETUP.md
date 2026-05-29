# GPU 学習環境のセットアップ手順（実施結果込み）

`@tensorflow/tfjs-node-gpu` が GPU を利用するためのセットアップ手順です。
**WSL2 (Ubuntu 24.04) + NVIDIA RTX シリーズ**で実証済み。

## 結論（2026-05-28 実施）

- ✅ **環境構築は成功**: RTX 4080 (16 GB) を tfjs-node-gpu から利用可能
- ⚠️ **現状の学習パイプラインでは GPU の効果はほぼゼロ**（後述「ベンチ結果」 参照）
- GPU の真価を出すには **parallel self-play / 大規模モデル / virtual loss 正しい実装** が必要

## 前提

- Windows 側に NVIDIA GPU ドライバがインストール済み（`nvidia-smi` が WSL から見える状態）
- WSL Ubuntu 24.04 (Noble Numbat)
- `@tensorflow/tfjs-node-gpu` が npm install 済み

## tfjs-node-gpu v4.22 が要求するライブラリ

`@tensorflow/tfjs-node-gpu` 4.22 が同梱する `libtensorflow` は **CUDA 11 ベース**です。

| ライブラリ | パッケージ |
|---|---|
| `libcudart.so.11.0`, `libcublas.so.11`, `libcusparse.so.11`, `libcufft.so.10` 等 | `cuda-cudart-11-8`, `libcublas-11-8`, ... （個別） |
| `libcudnn.so.8` | `nvidia-cudnn` + `update-nvidia-cudnn -u` |

**注意**: `cuda-toolkit-11-8`（フル）は Ubuntu 24.04 では `nsight-systems-2022.4.2` 依存の `libtinfo5` が解決できず失敗するため、 runtime ライブラリだけ個別インストールする。

## インストール手順（sudo 必要、所要 ~15 分、 ディスク 約 4 GB）

### Step 1: cuda-keyring

```bash
cd /tmp
wget https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt-get update
```

### Step 2: CUDA 11.8 runtime ライブラリ（nsight 系は含めない、 ~700 MB DL）

```bash
sudo apt-get install -y --no-install-recommends \
  cuda-cudart-11-8 \
  cuda-nvrtc-11-8 \
  libcublas-11-8 \
  libcufft-11-8 \
  libcurand-11-8 \
  libcusolver-11-8 \
  libcusparse-11-8 \
  libnpp-11-8
```

これで `/usr/local/cuda-11.8/lib64/` 配下に `libcudart.so.11.0`, `libcublas.so.11` 等が配置される。

### Step 3: cuDNN 8.9.2（NVIDIA 公式 tarball を `nvidia-cudnn` 経由で取得、 ~860 MB DL）

```bash
sudo apt-get install -y nvidia-cudnn
sudo /usr/sbin/update-nvidia-cudnn -u
```

`nvidia-cudnn` パッケージ自体はインストールスクリプトのみで、 cuDNN 本体は `update-nvidia-cudnn -u` で別途 NVIDIA developer サーバーからダウンロード・展開する。 これにより `/usr/lib/x86_64-linux-gnu/libcudnn.so.8`（実体 `libcudnn.so.8.9.2`）が配置される。

### Step 4: LD_LIBRARY_PATH

```bash
echo 'export LD_LIBRARY_PATH=/usr/local/cuda-11.8/lib64:${LD_LIBRARY_PATH}' >> ~/.bashrc
source ~/.bashrc
```

### Step 5: 動作確認

```bash
sudo ldconfig
ldconfig -p | grep -E 'libcudart\.so\.11|libcudnn\.so\.8|libcublas\.so\.11'
# 上記 3 つが全部出れば OK

cd /home/futa/meteo-night
LD_LIBRARY_PATH=/usr/local/cuda-11.8/lib64:${LD_LIBRARY_PATH} \
  npx tsx ai/scripts/nn/_smoke-gpu.ts 2>&1 | grep -E 'Created device|backend|forward'
# → "Created device /...GPU:0" + "name: NVIDIA GeForce RTX 4080" が出れば成功
```

## ベンチ結果（hidden=256×2、 ENC=185、 RTX 4080 vs Ryzen CPU、 WSL2）

### 推論（純粋な forward pass）

| batch | GPU ms/step | CPU ms/step | GPU/CPU |
|---|---|---|---|
| 1 | 0.84 | 2.08 | **2.5x 速い** |
| 16 | 0.81 | 1.52 | **1.9x 速い** |
| 64 | 2.25 | 5.19 | **2.3x 速い** |
| 256 | 9.50 | 13.80 | **1.5x 速い** |
| 1024 | 48.99 | 45.39 | 0.93x (CPU 微速) |

### 実 self-play（train.ts、 mcts-batch=16）

#### Gen-3-K10 時点（sequential のみ、 5 games × 1 iter）

| モデル | GPU 所要 | CPU 所要 | 効果 |
|---|---|---|---|
| 小 (hidden=64×2, 18K params, az-v10 init) | 6.7s | 7.4s | 1.10x |
| 中 (hidden=256×3, 188K params, 新規 init) | 7.95s | 7.39s | **0.93x（CPU が速い）** |

#### Gen-3-K11 時点（parallel self-play 追加）

→ K12 でより大きな改善が見つかったため、 表は削除。 詳細は `ai/CHANGELOG.md` Gen-3-K11 参照。

> ⚠️ **【2026-05-29 訂正】 以下の K12「mcts-batch=100 で 1.5x speedup」 は誤りでした。**
> `decideActionNeural` の batch 探索は `batchSize` が大きいと木を降りないバグがあり、
> `batchSize >= iterations` では root すら展開せず探索がほぼ空回りします（`_verify-search.ts` で実証）。
> mcts-batch=100 が「速かった」 のは探索をしていなかったからで、 speedup は無効です。
> **正しい設定は `batchSize <= 8`**。 詳細は `ai/CHANGELOG.md` Gen-3-S エントリ参照。

#### Gen-3-K12 時点（mcts-batch=iterations が真の改善、 大モデル 8 games × 1 iter） ※下表は無効（上の訂正参照）

| 構成 | examples | 所要 | ms/example | A 比 |
|---|---|---|---|---|
| A: GPU seq, mcts-batch=16 (旧 baseline) | 1193 | 23.0s | 19.3 | 1.00x |
| **B: GPU seq, mcts-batch=100 (推奨)** | 960 | **12.2s** | **12.7** | **1.52x** |
| C: GPU parallel=8, mcts-batch=16 (K11) | 1081 | 16.3s | 15.1 | 1.28x |
| D: GPU parallel=8, mcts-batch=100 | 1064 | 12.7s | 11.9 | 1.62x |
| E: CPU seq, mcts-batch=16 | 1282 | 27.2s | 21.2 | 0.91x |
| **F: CPU seq, mcts-batch=100** | 960 | **11.6s** | **12.1** | **1.60x** |
| G: CPU parallel=8, mcts-batch=100 | 1064 | 15.7s | 14.8 | 1.30x |

→ **mcts-batch=100 (iterations と同値) が支配的に効く**（sequential 単体で 1.5x speedup）。 parallel-games は不要。
→ ただし mcts-batch=100 だと **GPU と CPU が同等** （B vs F）。 NN cost が小さくなり GPU の優位性は消える。

#### プロファイル結果（NN predict のコスト構造）

```
batch=  1:  3.15 ms/call  3.148 ms/sample  ← 3 ms 固定オーバーヘッド
batch= 16:  3.68 ms/call  0.230 ms/sample
batch=100: ~9    ms/call  0.090 ms/sample
batch=256: 21.09 ms/call  0.082 ms/sample
```

→ predict 回数を減らす（call/turn を 6 → 1 に）のが最も効く改善。

### 解釈と今後の方針

純粋な forward pass では GPU 2x 速いのに、 train.ts に組み込むと効果が消える。 原因は self-play 中の MCTS 推論が `mcts-batch=16` の逐次小バッチで、 PCIe 転送と TF ランタイムのオーバーヘッドが支配的になるため。

#### Gen-3-K11 → K12 の経緯

K11 で parallel self-play を実装したが、 大モデルで GPU 1.32x が限度。
**プロファイル実測** で律速箇所を特定したところ:

| 改良案 | 期待効果 | 実測効果 | 結論 |
|---|---|---|---|
| parallel self-play（複数 games を同時並行） | 高（3-5x 期待） | 中モデル 1.0x、 大モデル 1.32x | K12 で **不要と判明** |
| **mcts-batch=iterations 化（1 turn = 1 NN call）** | 未予測 | **sequential 1.5x、 parallel と組み合わせて 1.6x** | **K12 採用** |
| virtual loss 正しい実装（K8 で 1 度失敗） | 中（2x 期待） | 未試行 | K13 以降の候補 |
| 大規模モデル（1M+ params） | 中 | GPU が CPU の 1.0-1.6x（mcts-batch 設定次第） | 採用、 ただし GPU 必須ではない |

#### 結論（Gen-3-S で訂正済み）

- ❌ ~~推奨設定: `--mcts-batch 100`~~ → **誤り。 mcts-batch=100 は探索が空回りする（上の訂正バナー参照）**
- ✅ **正しい設定: `--mcts-batch 8`（探索品質を保てる上限付近）**
- mcts-batch=8 でも NN 呼び出しは 1/8 に減らせるので、 GPU/CPU の速度傾向（Gen-3-K10 の結論: 小モデルでは GPU 優位性ほぼ無し）は概ね維持
- 開発中も本番学習も CPU で問題なし。 GPU を使う場合の利点はわずか

## 今後やること（TODO）

GPU セットアップは完了したが、 現行アルゴリズムでは効果が出ない。 以下を順に実施して GPU を真に活かす。

### フェーズ A: アルゴリズム改良

1. ✅ **parallel self-play** （Gen-3-K11、 2026-05-28、 後に K12 で不要と判明）
   - `--parallel-games N` オプション追加
   - 効果: 大モデルで 1.32x → K12 後はゼロ
   - 実装は残置（マイクロモデルで活きる可能性のため）
2. ❌ ~~**mcts-batch=iterations 化** （Gen-3-K12）~~ → **Gen-3-S で撤回**
   - プロファイルで NN predict の 3 ms 固定オーバーヘッドを発見したのは正しい
   - しかし `--mcts-batch 100` は探索が空回りするバグがあり、 speedup は無効だった
   - 正しい上限は `--mcts-batch 8`
3. ✅ **大規模モデル** （hidden=512×6, 1.4M params、 動作確認済み）
4. **virtual loss の正しい実装**（Gen-3-K13 候補、 未着手）
   - K8 の失敗の再挑戦。 path 上の選択 action にだけ仮想 loss
5. **az-v11 大規模学習** （Gen-3-K13 候補、 未着手）
   - mcts-batch=16 vs 100 を 2 条件並行学習して、 強さ（vs smart 勝率）が劣化していないか検証必須

### フェーズ B: 再計測（各改良後に必須）

各改良ごとに、 **このドキュメントの「ベンチ結果」 セクションを更新** すること:

- **計測コマンド**（推論 forward pass、 hidden サイズ・バッチサイズ別）:
  ```bash
  # 計測スクリプトはインラインで再現可能（ai/CHANGELOG.md Gen-3-K10 参照）
  export LD_LIBRARY_PATH=/usr/local/cuda-11.8/lib64:${LD_LIBRARY_PATH}
  cd /home/futa/meteo-night
  # GPU: npx tsx -e '...バッチ別 predict loop...'
  # CPU: CUDA_VISIBLE_DEVICES=-1 npx tsx -e '同じスクリプト'
  ```
- **計測コマンド**（実 self-play、 train.ts 5 games × 1 iter）:
  ```bash
  # GPU
  rm -rf /tmp/gpu-smoke
  time npx tsx ai/scripts/nn/train.ts \
    --games 5 --iter 1 --batch 256 --epochs 1 --seed 99000 \
    --selfplay neural --hidden-units 256 --hidden-layers 3 \
    --mcts-batch 16 --out /tmp/gpu-smoke

  # CPU
  rm -rf /tmp/cpu-smoke
  CUDA_VISIBLE_DEVICES=-1 time npx tsx ai/scripts/nn/train.ts \
    --games 5 --iter 1 --batch 256 --epochs 1 --seed 99000 \
    --selfplay neural --hidden-units 256 --hidden-layers 3 \
    --mcts-batch 16 --out /tmp/cpu-smoke
  ```
- 結果は **「ベンチ結果」 セクションのテーブルを上書き** し、 古い数値は ai/CHANGELOG.md に残す
- 採用判定の基準: 実 self-play での GPU/CPU 比が **1.5x 以上** になっていること

### フェーズ C: 大規模学習の開始

K12 後の推奨設定で、 CPU でも GPU でも同じコマンドで動く:

```bash
# az-v11 候補: 大モデル + mcts-batch=iterations
# GPU 環境
export LD_LIBRARY_PATH=/usr/local/cuda-11.8/lib64:${LD_LIBRARY_PATH}
# CPU 環境（GPU セットアップなしでも同じ性能）
# 何もしない、 普通に実行

npx tsx ai/scripts/nn/train.ts \
  --games 500 --iter 20 --batch 256 --epochs 3 --seed 50000 \
  --selfplay neural --hidden-units 512 --hidden-layers 6 \
  --mcts-batch 8 \
  --out ai/models/az-v11 \
  --copy-to-public public/models/active
```

10000 games の AlphaZero ループは推定 **約 5 時間**（12 ms/example × 100 examples/game × 10000 games / 3600s）。

K12 結論として GPU の利点はほぼ無いが、 開発スピード向上の保険として GPU 環境は維持する。

## トラブルシューティング

### Q: `sudo apt install cuda-toolkit-11-8` で `libtinfo5` の依存解決失敗

→ Ubuntu 24.04 (Noble) には `libtinfo5` が無いため。 上の Step 2 のように **個別パッケージ指定**で `nsight-systems` を回避する。

### Q: `nvidia-cudnn` install 後も `libcudnn.so.8` が見つからない

→ `nvidia-cudnn` パッケージはインストールスクリプトのみ。 `sudo /usr/sbin/update-nvidia-cudnn -u` を別途実行して NVIDIA から tarball を取得する必要がある。

### Q: GPU は認識されたが学習速度が CPU 並み

→ 上記「ベンチ結果」 参照。 現行 self-play は GPU の真価が出ない構造。 改善には neuralMcts の構造改修が必要。

## CPU 版へのロールバック

`ai/scripts/nn/*.ts` の import を `@tensorflow/tfjs-node-gpu` → `@tensorflow/tfjs-node` に戻すか、 環境変数 `CUDA_VISIBLE_DEVICES=-1` で実行すれば CPU で動く。 現状の AlphaZero パイプラインでは CPU でも実質同等速度なので、 開発中は CPU でも全く問題ない。

```bash
# 1 回だけ CPU で実行
CUDA_VISIBLE_DEVICES=-1 npx tsx ai/scripts/nn/train.ts ...
```

## 参考リンク

- TensorFlow GPU セットアップ（公式）: https://www.tensorflow.org/install/gpu
- NVIDIA WSL2 用 CUDA: https://docs.nvidia.com/cuda/wsl-user-guide/
- tfjs-node-gpu README: https://www.npmjs.com/package/@tensorflow/tfjs-node-gpu
