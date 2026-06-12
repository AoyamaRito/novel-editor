# novel-editor

オリジナルかな配列で小説を書く専用エディタ。OS の IME を使わない。
仕様の正典: `/Users/AoyamaRito/PJs/novel-editor/SPEC.md`

## 起動

```sh
cd /Users/AoyamaRito/grok_build/novel-editor
npm start
```

(Electron アプリ。electron 30.5.1 = Node 18 互換版を固定。
`main.js` の webSecurity:false は file:// 上で ES module と fetch を通すための割り切り —
完全ローカル・リモートコンテンツゼロの前提でのみ正当)

## 操作

| キー | 動作 |
|---|---|
| 文字キー | 単打面のかな |
| space + 文字キー(同時) | 和音面のかな |
| ゛(F) | 直前の字を変形: か→が、は→ば→ぱ、あ→ぁ(循環) |
| かな(右親指) | 変換マーク ▽ 開始 / 変換発動 / 候補送り(末尾にひらがな無変換、循環) |
| 英数(左親指) | ▼→読みに戻る / ▽→解除(読みは本文へ) |
| 次のかなを打つ | 候補を暗黙確定 |
| Enter | 確定+改行 / Backspace | 削除(▼では読みに戻る) |
| Cmd+S / 保存ボタン | yume-lite Block にコミット(履歴つき) |

かな/英数キーが反応しないときは、画面下の `code:` 表示で実際のコード名を確認し、
`editor.js` 冒頭の `HENKAN_CODES` / `CANCEL_CODES` に追加する。

## 練習モード(チュートリアル)

ヘッダの「練習」ボタン。6ステージ制、**出題は全部自分の小説コーパス**:

1. ホーム段(単打) → 2. 単打面ぜんぶ → 3. 和音面(space同時) → 4. ゛変形 → 5. 変換(かなキー) → 6. 実文(自分の小説のかな化文)

- 次に押すキーが配列チャート上でハイライトされる(和音は和音面側が光る)
- ミスは弾かれて赤フラッシュ(誤字は入らない)。Enter=スキップ、Esc=終了
- ステージ進行は localStorage に保存、字/分とミス数を計測
- 教材の再生成: `/PJs/novel-editor/tools/build-drills.js` → `drills.json` をコピー

## データ

- `layout.json` — 配列(導出元: `/PJs/novel-editor/tools/layout-gen.js`)。コーパスが増えたら再生成してコピー
- `dict.json` — 自己コーパス辞書(`/PJs/novel-editor/tools/build-dict.js`)
- 確定学習: localStorage `ne:userDict`(自分の確定が corpus 頻度より常に優先)
- 原稿: localStorage `ne:graph`(yume-lite Graph、`novel:manuscript` Block の versions が履歴)

## MVP の割り切り(SPEC からの差分)

- 送り仮名マークは未実装。代わりに**読みを活用形まで全部打って変換**
  (辞書が corpus の活用形表記を持っているので「はしった→走った」が引ける)。英数は戻る/解除専用
- カーソルは末尾固定(追記+Backspace のみ)。挿入編集は次フェーズ
- 同時打鍵窓 40ms 固定(`CHORD_WINDOW_MS`)。実打で調整する
