// わかち境界分類器の特徴抽出(学習・推論で共有)。
// 入力かな chars[](文字配列)と内部位置 p(chars[p-1] と chars[p] の間に境界があるか)について、
// 周辺文字の n-gram を二値特徴の文字列キーとして返す。入力は読み=ほぼ全てひらがな。
export function feats(chars, p) {
  const n = chars.length;
  const at = (i) => (i < 0 ? '^' : i >= n ? '$' : chars[i]);
  const L1 = at(p - 1), R1 = at(p), L2 = at(p - 2), R2 = at(p + 1), L3 = at(p - 3), R3 = at(p + 2);
  return [
    'b',                       // バイアス
    'L1:' + L1,
    'R1:' + R1,
    'L2:' + L2 + L1,           // 左バイグラム(境界直前まで)
    'R2:' + R1 + R2,           // 右バイグラム(境界直後から)
    'P:' + L1 + R1,            // 境界を跨ぐ対
    'T_L:' + L2 + L1 + R1,     // L2 L1 | R1
    'T_R:' + L1 + R1 + R2,     // L1 | R1 R2
    'Q:' + L2 + L1 + R1 + R2,  // 4-gram 跨ぎ
    'PL:' + L3 + L2 + L1,      // 左トライグラム
    'PR:' + R1 + R2 + R3,      // 右トライグラム
    'pos:' + Math.min(p, 6) + '/' + Math.min(n - p, 6), // 端からの相対位置(粗く)
  ];
}
