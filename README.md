# novel-editor

オリジナルかな配列で小説を書く専用エディタ。OS の IME を使わない。
仕様の正典: `/Users/AoyamaRito/PJs/novel-editor/SPEC.md`(決定の経緯込み)

## 起動

```sh
cd /Users/AoyamaRito/grok_build/novel-editor
npm start
```

(Electron 30.5.1 固定 = Node 18 互換。`main.cjs` の webSecurity:false / nodeIntegration:true は
完全ローカル・リモートコンテンツゼロの前提でのみ正当な割り切り)

## 操作(現行・2026-06-12 確定)

| キー | 動作 |
|---|---|
| 文字キー | 単打面のかな |
| **Shift + 文字キー** | シフト面のかな(モディファイア方式。同時打鍵の判定窓は存在しない) |
| ゛(F) | 直前の字を変形: か→が、は→ば→ぱ、あ→ぁ(循環) |
| **Space**(7・右Cmd・かな も同じ) | 変換 / 候補送り(末尾にひらがな→カタカナ、循環) |
| Enter | ▼決定 → 未確定かな確定+閉じカッコ実体化 → 改行(三層。決定と改行は同時に走らない) |
| 8 / Tab / F1〜F10 | カタカナ確定 / 予測をひらがな確定 / 全角数字(F10=0) |
| 英数 / Option / Backspace | 候補をやめて打った分だけかなに戻す |
| Cmd+S | 保存(10秒ごと+終了時にも自動保存) |

- 「…」キー一打で「……」。直後の Space で ――・「」・『』・（） に変換(ペアはカーソルが中)
- 「『（ を打つと閉じが予約表示され、閉じキーか Enter で実体化
- 作法エンジン: 地の文の行頭は自動字下げ(セリフ行はしない)、！？の後の全角アキ、「。」」の句点除去
- 表示色: 青=未確定 / 薄青=予測ゴースト / 緑フラッシュ=いま変換した字 / 黒=確定

## 変換の層(優先順位順)

1. **あなたの確定**(userDict) — 開く選択も学習される
2. **自動登録**(autoDict) — ローカルLLMが原稿から固有名詞を採取。原稿に実在する表記のみ・2回観察で登録
3. **自分のコーパス**(dict.json — 過去作品から生成)
4. **基底辞書**(basedict.json 89.6万読み = mozc + IPADIC活用展開 + SKK系)
5. ラティス(最小コスト経路)が複数語の同時変換と分割を決める
6. **ローカルLLM審査員**(同梱 TinySwallow-1.5B)が文脈で第一候補を選び、不自然候補を除外。
   出力は候補番号のみ=本文を一文字も生成しない。ユーザが先に動けば黙る

## 練習モード

6ステージ: ホーム段 → 単打面 → シフト面(Shift+キー) → ゛変形 → 変換(Space) → 実文(変換込み)。
出題は全部自分のコーパス。次に押すキーがグロー+十字エフェクト、シフト面では逆側の⇧が点灯。
字/分とミスを計測。Enter=スキップ、Esc=終了。

## データ生成(リポジトリに含まれない大物)

```sh
cd /Users/AoyamaRito/PJs/novel-editor   # corpus/ と data/ があるパイプライン側
node tools/build-basedict2.js > basedict.json   # mozc/IPADIC/SKK(要 data/ 取得)
node tools/build-dict.js > dict.json            # 自己コーパス辞書
node tools/build-drills.js > drills.json        # 練習教材
node tools/layout-gen.js                        # 配列改訂(anchor)。--fresh は白紙導出
```

LLM(`llm/`、リポジトリ外): llama.cpp の llama-server(mac/win)+ TinySwallow-1.5B GGUF を配置。
パッケージは electron-packager に `--asar.unpack="**/llm/**"` 必須。

## テスト(e2e-snow-ball)

```sh
node e2e.mjs   # 偽DOM+偽llama-server上で keydown列→描画を検証
```

変更のたびにテストを「ついでに」足して育てる(yume-lite の Pre-git ritual)。

## 備考

- `layout.json` の slot 名 `+SP` は旧 space和音設計の名残で、現在は「シフト面」を意味する
- 原稿は yume-lite Block(履歴32版)+ `書類/novel-editor/manuscript.txt` に自動保存
- ログ: ne:userDict(確定学習)/ ne:autoDict・ne:observed(自動登録)/ ne:graph(原稿履歴)
- 著者証明: log.jsonl は SHA-256 ハッシュチェーン(paste/import/移動も全記録)、原稿状態の sha256 を保存毎にチェーンへ固定。
  anchors.jsonl は OpenTimestamps カレンダーの **pending 証明**(標準 .ots 形式での第三者検証導線は未整備=次フェーズ)。
  「カレンダー応答を当日中に取得した」ことの記録であり、Bitcoin ブロックへの確定検証はまだ主張しない
