#!/usr/bin/env bash
# tempoChain genome 最適化グリッドを 20 シャード並列で実行（レジューム対応）。
# 既存の /tmp/opt-grid-*.jsonl があれば完了済み候補はスキップして再開する。
#
# セッションから切り離して起動（閉じても生存）:
#   cd /home/futa/meteo-night && setsid bash ai/scripts/_run-optimize.sh > /tmp/opt-launcher.log 2>&1 < /dev/null &
#
# 進捗:    npx tsx ai/scripts/aggregate-tempochain.ts        （部分結果でも集約可）
# 完了判定: /tmp/opt-grid-DONE が存在すれば全シャード完了
set -u
cd /home/futa/meteo-night || exit 1
rm -f /tmp/opt-grid-DONE
for i in $(seq 0 19); do
  npx tsx ai/scripts/optimize-tempochain.ts --shard "$i" --of 20 --games 80 --seed 80001 --out /tmp/opt-grid >> "/tmp/opt-grid-shard-$i.log" 2>&1 &
done
wait
date > /tmp/opt-grid-DONE
echo "ALL 20 SHARDS DONE at $(date)"
