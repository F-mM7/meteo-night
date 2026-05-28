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

### 実 self-play（train.ts、 5 games × 1 iter、 mcts-batch=16）

| モデル | GPU 所要 | CPU 所要 | 効果 |
|---|---|---|---|
| 小 (hidden=64×2, 18K params, az-v10 init) | 6.7s | 7.4s | 1.10x |
| 中 (hidden=256×3, 188K params, 新規 init) | 7.95s | 7.39s | **0.93x（CPU が速い）** |

### 解釈と今後の方針

純粋な forward pass では GPU 2x 速いのに、 train.ts に組み込むと効果が消える。 原因は self-play 中の MCTS 推論が `mcts-batch=16` の逐次小バッチで、 PCIe 転送と TF ランタイムのオーバーヘッドが支配的になるため。

GPU を有効活用するには:

| 改良案 | 期待効果 | 実装難度 |
|---|---|---|
| **parallel self-play**（複数 games を同時並行で進めて 1 回の predict で 64-256 サンプル束ねる） | 高（3-5x speedup 期待） | 中（neuralMcts の構造改修） |
| **virtual loss 正しい実装**（同一ノードで複数 leaf を並列展開、 K8 で 1 度失敗） | 中（2x speedup 期待） | 中 |
| **大規模モデル**（1M+ params） | 中（GPU 計算律速に入る） | 低（CLI 引数で可） |
| **mcts-batch=64+** | 低（並列度の限界がある） | 低 |

つまり「**GPU セットアップは Gen-3-K11 以降のアルゴリズム改良への前提条件**」 という位置付け。 現行コードのまま GPU で回しても恩恵はほぼゼロなので、 大規模学習を始める前に改良が必要。

## 今後やること（TODO）

GPU セットアップは完了したが、 現行アルゴリズムでは効果が出ない。 以下を順に実施して GPU を真に活かす。

### フェーズ A: アルゴリズム改良（Gen-3-K11 以降）

上の改良案を **期待効果が大きい順** に実装する:

1. **parallel self-play** （Gen-3-K11 候補）
   - `ai/scripts/nn/dataset.ts` と `neuralMcts.ts` を改修
   - N games を同時進行させ、 NN 推論を集中バッチ化する
   - 目標: 推論バッチサイズを 16 → 64-256 に引き上げ、 GPU 利用効率を上げる
2. **virtual loss の正しい実装**（Gen-3-K12 候補）
   - 既存 `mctsAI.ts` / `neuralMcts.ts` の virtual loss は Gen-3-K8 で実装したが効果がマイナスだった
   - 単純な visit-count ペナルティではなく、 path 上の選択 action にだけ仮想 loss を加える正しい実装に直す
3. **大規模モデル**（hidden=512×6, 1M+ params）
   - CLI 引数のみで切替可能。 上の 1, 2 が安定したあとで導入

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

フェーズ A・B で「GPU が CPU の 2-3x 以上速い」 が確認できたら、 az-v11 として 10K-50K games の AlphaZero ループを GPU で実施する。 それまでは **CPU での反復開発と小規模実験** に注力（速度差ほぼ無いので CPU で問題なし）。

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
