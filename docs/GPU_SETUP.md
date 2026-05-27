# GPU 学習環境のセットアップ手順

`@tensorflow/tfjs-node-gpu` が GPU を利用するためのセットアップ手順です。
**WSL2 (Ubuntu 24.04) + NVIDIA RTX シリーズ**を前提とします。

## 前提

- Windows 側に NVIDIA GPU ドライバがインストール済み（`nvidia-smi` が WSL から見える状態）
- WSL Ubuntu に `nvidia-cuda-toolkit`（CUDA 12 系）が apt 経由で入っている
- `@tensorflow/tfjs-node-gpu` が npm install 済み

## 不足ライブラリ（tfjs-node-gpu v4.22 要求）

`@tensorflow/tfjs-node-gpu` 4.22 が同梱する `libtensorflow` は **CUDA 11 ベース**です。
そのため CUDA 12 環境では以下が不足します。

| ライブラリ | 要求バージョン | 解決パッケージ |
|---|---|---|
| `libcudart.so.11.0` | CUDA 11 | `cuda-toolkit-11-8` |
| `libcublas.so.11` | CUDA 11 | `cuda-toolkit-11-8` |
| `libcublasLt.so.11` | CUDA 11 | `cuda-toolkit-11-8` |
| `libcufft.so.10` | CUDA 11 | `cuda-toolkit-11-8` |
| `libcusparse.so.11` | CUDA 11 | `cuda-toolkit-11-8` |
| `libcudnn.so.8` | cuDNN 8 | `libcudnn8` |

## インストール手順（sudo パスワード必要、所要 ~10 分、ディスク ~4 GB）

### Step 1: NVIDIA CUDA repository 追加

```bash
cd /tmp
wget https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt update
```

### Step 2: CUDA 11.8 toolkit インストール

```bash
sudo apt install -y cuda-toolkit-11-8
```

これで `/usr/local/cuda-11.8/` に CUDA 11.8 が入ります（既存 CUDA 12 と共存）。

### Step 3: cuDNN 8 インストール

```bash
sudo apt install -y libcudnn8 libcudnn8-dev
```

`libcudnn8` は CUDA 11.x 用です。cuDNN 9 は CUDA 11/12 両対応ですが、tfjs-node-gpu は `libcudnn.so.8` を要求するため cuDNN 8 を使います。

### Step 4: LD_LIBRARY_PATH 設定

```bash
echo 'export LD_LIBRARY_PATH=/usr/local/cuda-11.8/lib64:${LD_LIBRARY_PATH}' >> ~/.bashrc
source ~/.bashrc
```

### Step 5: 動作確認

```bash
# (A) 必要ライブラリが見つかるか
ldconfig -p | grep -E 'libcudart\.so\.11|libcudnn\.so\.8'
# → libcudart.so.11 / libcudnn.so.8 が出ること

# (B) tfjs-node-gpu が GPU を認識するか
TF_CPP_MIN_LOG_LEVEL=1 npx tsx ai/scripts/nn/_smoke-gpu.ts 2>&1 | head -20
# → "Created TensorFlow device /job:localhost/.../device:GPU:0" が出れば OK
```

## トラブルシューティング

### Q: `sudo apt install cuda-toolkit-11-8` で「Unable to locate package」

`/etc/apt/sources.list.d/cuda-*.list` を確認。なければ Step 1 の cuda-keyring 追加に失敗している。
別の URL を試す:

```bash
# wsl-ubuntu の代わりに ubuntu2404 を使う（CUDA 12 用 keyring。CUDA 11 はホストの NVIDIA driver と無関係なので問題なし）
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt update
```

### Q: cuDNN install 後も `libcudnn.so.8: cannot open shared object file`

`ldconfig` 再実行 + LD_LIBRARY_PATH 確認:

```bash
sudo ldconfig
ldconfig -p | grep libcudnn
```

### Q: GPU は認識されたが学習が CPU 並みに遅い

- `nvidia-smi` で GPU 使用率を確認（学習中に 60%+ なら OK）
- `nvidia-smi` で 7% 程度なら GPU を使えていない可能性
- `tf.getBackend()` が `'tensorflow'` であることを再確認

## CPU 版へのロールバック

GPU 設定に時間がかかる場合、CPU 版で開発を継続できます。

```bash
# tfjs-node-gpu を使わず CPU 版に戻す
npm uninstall @tensorflow/tfjs-node-gpu

# 各 nn/*.ts の import を切替
#   from '@tensorflow/tfjs-node-gpu'  →  from '@tensorflow/tfjs-node'
```

CPU 版は GPU 版より約 1/5〜1/10 の速度ですが、 すべてのコードはそのまま動きます。

## 参考リンク

- TensorFlow GPU セットアップ（公式）: https://www.tensorflow.org/install/gpu
- NVIDIA WSL2 用 CUDA: https://docs.nvidia.com/cuda/wsl-user-guide/
- tfjs-node-gpu README: https://www.npmjs.com/package/@tensorflow/tfjs-node-gpu
