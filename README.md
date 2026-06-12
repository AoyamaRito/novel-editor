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
| **Space**(右Cmd・かな も同じ) | 変換 / 候補送り(末尾にひらがな→カタカナ、循環) |
| 数字段 **4・5・7・8** | だ・で・じ・が(最頻濁音の単打ショートカット。頻度→コストで席決め) |
| **：** | 表記を開く: 押すたび すべてカタカナ⇄すべてひらがな。漢字候補の表示中からも戻せる |
| Enter | ▼決定 → 未確定かな確定+閉じカッコ実体化 → 改行(三層。決定と改行は同時に走らない) |
| Tab / F1〜F10 | 予測をひらがな確定 / 全角数字(F10=0) |
| 英数 / Option / Backspace | 候補をやめて打った分だけかなに戻す |
| **F11**(英数キーも可) | ABCモードのトグル(刻印どおりの半角英数。英数はOSに取られる環境があるため F11 が本命) |
| Cmd+S | 保存(10秒ごと+終了時にも自動保存) |

- 「…」キー一打で「……」。直後の Space で ――・「」・『』・（） に変換(ペアはカーソルが中)
- 「『（ は閉じも一度に実体で入り、カーソルは中。Enter=閉じの外へ(。」の句点は自動で落ちる)、直後の Backspace=ペアごと削除(」に専用キーは無い)
- 作法エンジン: 地の文の行頭は自動字下げ(セリフ行はしない)、！？の後の全角アキ、「。」」の句点除去
- 表示色: 青=未確定 / 薄青=予測ゴースト / 緑フラッシュ=いま変換した字 / 黒=確定

## 変換の層(優先順位順)

0. **文脈学習**(ctxDict) — 「直前1字+読み→表記」を確定時に学習。「彼女の髪」と「あの神」が並存し、同じ文脈では文脈側が全体頻度より優先。ラティス変換にも経路の直前文字で割引が効く。同点候補は直近に使った方が先(直近性)
1. **あなたの確定**(userDict) — 開く選択も学習される
2. **自動登録**(autoDict) — ローカルLLMが原稿から固有名詞を採取。原稿に実在する表記のみ・2回観察で登録
3. **自分のコーパス**(dict.json — 過去作品から生成)
4. **基底辞書**(basedict.json 190万読み = mozc + IPADIC活用展開 + SKK系 + mozc-UT穴埋め層(jawiki/人名/地名/sudachi、新規読みのみ1候補))
5. ラティス(最小コスト経路)が複数語の同時変換と分割を決める
6. **ローカルLLM審査員**(同梱2モデルの**合議**: TinySwallow-1.5B + Qwen3-4B)。両者の第一候補が**一致した時だけ**並びを採用、不一致なら沈黙して辞書+文脈学習の順を保つ(実測で能動的誤審ゼロ)。採取・品詞・棚卸しは賢い方(Qwen3)が担当。役割は**変換候補のフィルタ**——
   文脈上あり得ない候補の除去と並べ替え**のみ**。出力は既存候補の番号に拘束され、
   本文の文字を生成・変更する経路は存在しない。**人間の打鍵を変更する動作は一切行わない**。
   ユーザが先に候補送りしていれば黙る。「証」ボタンの証明書にもこの保証が明記される

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

LLM(`llm/`、リポジトリ外): llama.cpp の llama-server(mac/win)+ model.gguf(TinySwallow-1.5B)+ model2.gguf(Qwen3-4B Q4_K_M、合議の相方)を配置。
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
- 注意: ブラウザ実行(非Electron)では log.jsonl を書けないためチェーン head だけが進む。証明用途は Electron 実行が前提

## ライセンスと同梱物

- コード(editor.js / main.cjs / e2e.mjs / tools/ / vendor/yume-lite-core.js): **MIT**(LICENSE 参照)
- `dict.json` / `drills.json` / `layout.json`: 作者自身のなろう公開作品から生成した派生データ(MIT 扱いで公開)
- `basedict.json`(基底辞書)は**リポジトリに含まれない**。各自 `tools/build-basedict2.js` で生成する:
  - 取得元: mozc dictionary_oss(BSD-3-Clause)、mecab-ipadic-seed(IPAライセンス)、SKK-JISYO L/jinmei/geo/propernoun/station(GPL)、mozc-UT jawiki/personal-names/place-names/sudachidict(各配布条件)
  - 生成物は GPL 等の混合物になるため再配布せず、手元生成・私的利用とする
- LLM モデル(`llm/model.gguf`, `llm/model2.gguf`)も同梱しない。TinySwallow-1.5B-Instruct(Apache-2.0)と Qwen3-4B-Instruct(Apache-2.0)の GGUF を置く。llama-server バイナリは llama.cpp(MIT)

## 先行技術としての公開(防衛的公開)

本リポジトリは 2026-06-12〜13 に実装された以下の機構を、MIT ライセンスで**公知の先行技術**として公開するものです:

1. **打鍵ログのハッシュチェーン+公証による著者証明**: 全打鍵を SHA-256 チェーン(各行が前行ハッシュを内包する append-only ログ)で記録し、チェーン先頭ハッシュを OpenTimestamps で外部時刻に固定。決定的変換エンジンと合わせ「本文が人間の打鍵から再導出できる」ことを第三者検証可能にする。外部由来テキスト(ペースト/取込)は全文をチェーンに記録して開示する
2. **公理0(LLM非介在の生成経路)+LLM フィルタ審査**: かな漢字変換は辞書 lookup と最小コスト経路のみで決定的に行い、LLM は提示済み候補の番号のみを出力する審査員として作用する(本文の字面を生成しない)
3. **複数ローカルLLMの合議審査**: 2モデルの第一候補が一致した時だけ採用し、不一致なら沈黙して辞書順を保つ(能動的誤審の排除)
4. **自己コーパス導出キー配列**: 著者自身の原稿の打鍵単位頻度・bigramからキー配列を導出し、anchor モードで増分再導出して学習済み配列の連続性を守る
5. **文脈1字学習と直近性による候補順最適化**: 確定時に「直前1字+読み→表記」を学習し、同一文脈で全体頻度より優先。ラティス経路にも文脈割引を適用
6. **素txt+台帳JSONによる作品フォルダ**: 作品=フォルダ、話=100%プレーンな txt、隣の台帳(novel-editor.json)が各 txt の sha-256・チェーン錨・保存時刻を持つ。本文ファイルを汚さずに改ざん検出と打鍵チェーンへの対応付けができる(旧・末尾メタ埋め込み形式も読み込み互換)
7. **エンジン版のチェーン固定**: 起動時に配列 sha とエンジン sha をチェーンに記録し、打鍵リプレイの再現性を版に対して保証する
