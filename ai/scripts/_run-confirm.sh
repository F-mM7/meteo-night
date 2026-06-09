#!/usr/bin/env bash
# tempoChain 上位 genome の確証を 20 シャード並列で実行（games をシャード分割）。
# 確証は二重計上を避けるためクリーンスタート（該当 out の旧 jsonl を削除してから走る）。
#
# 使い方:
#   bash ai/scripts/_run-confirm.sh <idx-csv> <seed> <games> <out-prefix> [base-la] [budget]
# 例（seed 2本・LA=0・1000局）:
#   cd /home/futa/meteo-night
#   setsid bash ai/scripts/_run-confirm.sh 12,5,134,77 90001 1000 /tmp/confirm-s90001 0 300 > /tmp/confirm-s90001.log 2>&1 < /dev/null &
#   setsid bash ai/scripts/_run-confirm.sh 12,5,134,77 92001 1000 /tmp/confirm-s92001 0 300 > /tmp/confirm-s92001.log 2>&1 < /dev/null &
#
# 進捗:    npx tsx ai/scripts/confirm-aggregate.ts /tmp/confirm
# 完了判定: <out-prefix>-DONE が存在すれば完了
set -u
cd /home/futa/meteo-night || exit 1
IDX="${1:?idx-csv が必要}"
SEED="${2:?seed が必要}"
GAMES="${3:?games が必要}"
OUT="${4:?out-prefix が必要}"
BASELA="${5:-0}"
BUDGET="${6:-300}"
OF=20

rm -f "${OUT}-DONE" "${OUT}"-*.jsonl
for i in $(seq 0 $((OF - 1))); do
  npx tsx ai/scripts/confirm-tempochain.ts \
    --idx "$IDX" --games "$GAMES" --seed "$SEED" \
    --shard "$i" --of "$OF" --base-la "$BASELA" --budget "$BUDGET" \
    --out "$OUT" >> "${OUT}-shard-$i.log" 2>&1 &
done
wait
date > "${OUT}-DONE"
echo "CONFIRM DONE (idx=$IDX seed=$SEED games=$GAMES la=$BASELA) at $(date)"
