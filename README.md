# ChromiumSearchEngineRestore

Chromium 系ブラウザで、`設定 > 検索エンジン` の登録内容がリセットされたときにバックアップから戻すツール。

## 使い方

初回だけ準備:

1. `****://settings/searchEngines` を開いて F12 で DevTools を開く
2. **Sources → Snippets → + New snippet** を選び、[search-engines-tool.js](search-engines-tool.js) の中身を貼って保存（名前の例: `search-engines`）

以降は:

1. `****://settings/searchEngines` で F12 を押し、スニペットを **Ctrl+Enter**（または右クリック → Run）
2. 画面右下のパネルを使う
   - **💾 バックアップ**: 今の一覧をブラウザ内（設定ページの localStorage）に保存し、JSON もダウンロードする
   - **♻ 保存済みバックアップから復元**: ブラウザ内のバックアップと比べ、差分を確認してから戻す
   - **📂 JSON ファイルから復元**: ダウンロードした JSON から戻す（ブラウザ内の保存まで消えていた場合はこちら）

復元でやること:
- キーワードが見つからないエンジンを追加する
- 名前・URL が変わっているエンジンを元に戻す
- 有効/無効（「無効なショートカット」側か）を元に戻す
- 既定の検索エンジンを元に戻す
