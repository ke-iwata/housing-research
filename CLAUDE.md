# 江戸川区 新築戸建てウォッチ

江戸川区の新築一戸建てを毎日調査し、GitHub Pages のダッシュボード（`index.html`）を更新するリポジトリ。
サイトはビルド不要の静的HTMLで、`data/*.json` と `data/reports/latest.md` を読んで表示する。

**このリポジトリは public。** 物件情報と探している条件以外（購入者の年収・年齢・勤務先・現住所など）は、ファイルにもコミットメッセージにも絶対に書かないこと。

---

## 日次更新ルーチン

Claude Code のルーチンから「CLAUDE.md の日次更新ルーチンを実行して」と呼ばれたら、以下を上から順に実行する。無人実行なので質問はせず、判断した前提はレポートに書く。

### 1. 探す条件

**必須**
- 新築一戸建て（建売・未完成の新築を含む。中古は除外）
- 間取り：4LDK以上、または 3LDK＋納戸（3SLDK等）
- 駐車場：1台以上（屋根付き・ビルトインガレージは加点。記載がなければ `"不明"`）
- 価格：7,500万円以下（無理のない範囲は 6,000〜7,000万円）
- 延床面積：110㎡以上（理想は120㎡以上）
- 駅からの距離は問わない（バス便も可）。代わりに最寄りバス停の系統と本数の多さを重視

**status の決め方**
- `match`：必須条件をすべて満たす（駐車場「不明」は満たすとみなし、note に「駐車場要確認」と書く）
- `near`（惜しい）：条件を1つだけ少し外れる。目安は延床100〜110㎡、価格7,500〜8,000万円、3LDK（納戸なし）のいずれか1つ
- `reference`（参考）：候補エリア内だが条件から大きく外れる物件、またはエリア外の相場の参考になる物件。1日5件程度まで
- `grade` は `scripts/update_history.py` が自動計算する（◎＝7,000万円以下かつ120㎡以上／○＝妥協1つ／△＝妥協2つ）。手で書かない

### 2. 候補エリア（`zone`）

| zone | エリア | 理由 |
|---|---|---|
| `first` | 篠崎街道沿い：下篠崎町、上篠崎、南篠崎町、篠崎町（駅から遠い側）、江戸川1〜6丁目 | 京成バス 小72（瑞江駅〜篠崎駅〜小岩駅・区内京成バスで最多便）と 新小71（新小岩駅〜鹿骨〜篠崎駅〜瑞江駅・深夜バスあり）が重なる |
| `second` | 鹿骨1〜6丁目、鹿骨町 | 新小71で新小岩駅に直行 |
| `reserve` | 春江町、東瑞江、西瑞江、一之江町、大杉、東小松川、本一色 | 瑞江・一之江・船堀・新小岩のバス便エリア |
| `other` | 上記以外の江戸川区 | 特に魅力的なものだけ（1〜2件） |

### 3. 調べるサイト（全部見る）

**A. LIFULL HOME'S**（WebFetch で取得できる。メインのソース）
- 町ごとの新築一覧：`https://www.homes.co.jp/kodate/shinchiku/tokyo/edogawa-city/<町コード>-town/list/`
- 判明している町コードは下の表。未判明の町は WebSearch（`allowed_domains: ["homes.co.jp"]`、例「ホームズ 江戸川区 鹿骨 新築一戸建て 物件一覧」）で `…-town/list/` のURLを探し、**見つけたら表に追記してコミット**する

  | 町 | コード |
  |---|---|
  | 下篠崎町 | 13C7EB78EB |
  | 篠崎町 | 13C7EB78E9 |
  | 上篠崎 | 13C7EB797A |
  | 南篠崎町 | 13C7EB7954 |
  | 江戸川 | 13C7EB78C4 |
  | 鹿骨 | 13C7EB78E7 |
  | 春江町 | 13C7EB7910 |
  | 東瑞江 | 13C7EB792F |
  | 西瑞江 | 13C7EB790E |
  | 瑞江 | 13C7EB7979 |
  | 一之江 | 13C7EB78C1 |
  | 一之江町 | 13C7EB78C2 |
  | 大杉 | 13C7EB7974 |
  | 東小松川 | 13C7EB792D |
  | 本一色 | 13C7EB7976 |

- 区全体の一覧 `https://www.homes.co.jp/kodate/shinchiku/tokyo/edogawa-city/list/`（`?page=2` 以降でページ送り。1〜3ページ）
- 条件に合いそうな物件は個別ページ（`https://www.homes.co.jp/kodate/b-…`）を開いて、駐車場・土地面積・間取り・完成時期を確認する

**B. アットホーム**（WebFetch は 405 で失敗しがち）
- まず `https://www.athome.co.jp/kodate/shinchiku/tokyo/edogawa-city/list/` を WebFetch。失敗したら深追いしない
- WebSearch（`allowed_domains: ["athome.co.jp"]`）で町名ごとに検索（例「アットホーム 江戸川区 下篠崎町 新築一戸建て 4LDK」）。検索結果の物件タイトルから所在地・間取り・物件番号・URLを拾う
- 価格や面積が分からない物件は、`price_man` がないと登録できないので `listings` には入れない。レポートの「アットホームで要確認」欄に列挙する
- 賃貸・中古は除外

**C. 不動産会社サイト**（WebFetch で取得できる）
- 三井のリハウス 江戸川区 一戸建て：https://www.rehouse.co.jp/buy/kodate/prefecture/13/city/13123/
- 三井のリハウス 篠崎駅 新築：https://www.rehouse.co.jp/buy/s_kodate/prefecture/13/railway/2353/station/200/
- 東急リバブル 江戸川区 一戸建て：https://www.livable.co.jp/kounyu/kodate/tokyo/a13123/
- 東急リバブル 篠崎駅：https://www.livable.co.jp/kounyu/kodate/tokyo/s2353200/
- 住宅情報館 篠崎駅 新築：https://www.jutakujohokan.co.jp/contents/search_line/house/new/toeishinjuku-line/shinozaki-st
- 瑞江駅・一之江駅も各サイトの駅別ページがあれば見る

**D. SUUMO**
- WebFetch は 404 になりがち。WebSearch（`allowed_domains: ["suumo.jp"]`）で町名＋新築一戸建てを検索し、個別物件が拾えれば使う

**ルール**
- `sources[].url` は**必ず物件の詳細ページのURL**にする（例：`https://www.homes.co.jp/kodate/b-…/`、`https://www.rehouse.co.jp/buy/s_kodate/bkdetail/…/`、`https://www.livable.co.jp/kodate/C…/`）。一覧・検索ページのURLは不可（`scripts/update_history.py` がエラーにする）。一覧ページで詳細URLが分からないときは、WebFetch で「各物件の詳細ページのhrefをそのまま返して」と頼み、そのURLを WebFetch して所在地・価格が一致することを確認してから使う
- 取得できない項目は `null` または `"不明"`。推測で埋めない
- 同じ物件（所在地・価格・延床が一致）が複数サイトにあれば1件にまとめ、`sources` に併記する
- `data/listings.json` の `source_status` に、サイトごとの結果を `"ok"` / `"failed"` / `"not_checked"` で記録する

### 4. 座標（lat / lng）

新しい物件は、国土地理院の住所検索で町丁目の座標を取る（WebFetch で取得できる）。

```
https://msearch.gsi.go.jp/address-search/AddressSearch?q=東京都江戸川区鹿骨二丁目
```

- 丁目は漢数字で書く。戻り値の `coordinates` は `[経度, 緯度]` の順
- 同じ丁目に複数の物件がある場合は、重ならないよう緯度経度を ±0.0006 程度ずらす
- 取得できなければ `data/config.json` にある町の代表点を使う

### 5. `data/listings.json` の更新

今日の日付を D（Asia/Tokyo、`YYYY-MM-DD`）とする。

- 駐車場が「なし」の物件は対象外（`reference` にして note に「駐車場なし」）
- **今回見つかった既存物件**：`last_seen = D`、`missed = 0`。価格が変わっていたら `price_man` を更新し、`price_history` に `{"date": D, "price_man": 新価格}` を追加。note に「○/○ 値下げ」などと書く
- **新しい物件**：`first_seen = last_seen = D`、`price_history = [{"date": D, "price_man": 価格}]`、`active = true`、`missed = 0`
- **今回見つからなかった物件**：`missed` を +1。`missed >= 2` になったら `listings` から外し、`ended` の末尾に `ended_on = D` を付けて移す（1回の取得失敗で消さないため）
- `updated_at`：実行時刻（`+09:00` 付きISO形式）
- `summary`：今日の要点を2〜3文で（新着・値下げ・イチオシ）
- `land`：注文住宅向けの売地（下篠崎・鹿骨など、25〜35坪、3,500万円以下）があれば `{address, price_man, land_m2, site, url, note}` で最大5件。毎回入れ替えてよい

listing の形（新規追加時はこのキーをすべて持たせる）:

```json
{
  "id": "shishibone2-109",            // 町名ローマ字＋丁目＋延床の整数部。重複したら末尾に -b などを付ける
  "address": "東京都江戸川区鹿骨2丁目",
  "town": "鹿骨",
  "zone": "second",                   // first / second / reserve / other
  "lat": 35.7071, "lng": 139.893372,
  "price_man": 7499,                  // 万円・数値
  "building_m2": 109.04, "land_m2": 102.62,
  "layout": "3LDK",
  "parking": "1台（ビルトイン）",       // 不明なら "不明"
  "access": "都営新宿線 篠崎駅 徒歩15分",
  "bus": "京成バス 新小71「鹿骨」停 徒歩3分",   // 分からなければ null
  "completion": "2026年8月",
  "sources": [{"site": "東急リバブル", "url": "https://..."}],
  "status": "near",                   // match / near / reference
  "grade": null,                      // スクリプトが自動計算
  "first_seen": "2026-09-25", "last_seen": "2026-09-25",
  "price_history": [{"date": "2026-09-25", "price_man": 7499}],
  "active": true,
  "missed": 0,
  "note": "土地103㎡と広め"
}
```

### 6. レポート

`data/reports/D.md` を書き、同じ内容を `data/reports/latest.md` にコピーする。

1. サマリー：条件合致数・新着数・値下げ数・イチオシ1〜3件（理由を一言）
2. 新着・価格変更の表（所在地｜交通・バス｜価格｜延床/土地｜間取り｜駐車場｜判定｜掲載元リンク）
3. 掲載終了した物件
4. アットホームで要確認の物件（あれば）
5. 条件合致がゼロの日は、惜しい物件を最大3件
6. 注意：駐車場「不明」の物件、浸水深（区のハザードマップ第2版）とバス停の朝7〜8時台の本数を確認する一言
7. 取得できなかったサイト

### 7. 検証・コミット・push

```bash
python3 scripts/update_history.py        # 検証＋grade再計算＋history.json 追記。エラーなら直してやり直す
git add -A
git commit -m "data: YYYY-MM-DD 日次更新（合致N件・新着N件）"
git push                                   # main に push できなければ claude/ ブランチに push（Actions が main にマージして公開する）
```

- push 先ブランチは作業環境の制約に従う。`claude/` で始まるブランチに push すれば、`.github/workflows/pages.yml` が main にマージして Pages を更新する
- 最後に、レポートの要約（サマリーと新着の表）を最終メッセージとして出力する

---

## ファイル構成

| パス | 内容 |
|---|---|
| `index.html`, `assets/app.js`, `assets/style.css` | ダッシュボード。`#map`（Leaflet の地図＋一覧＋詳細パネル）／`#market`（相場・Chart.js）／`#report`（`data/reports/YYYY-MM-DD.md` を日付ごとに表示）の3画面 |
| `assets/vendor/` | Leaflet 1.9.4 / Chart.js 4.5（同梱。CDN不要） |
| `data/config.json` | 条件・候補エリア（町の代表点）・駅・リンク |
| `data/listings.json` | 掲載中の物件、掲載終了、土地、サマリー |
| `data/history.json` | 日次の集計（スクリプトが追記） |
| `data/reports/` | 日次レポート（Markdown） |
| `data/bus.json` | 候補エリア周辺のバス停・系統と、時間帯別の本数（地図の「バス路線と本数」レイヤーと物件詳細の「近くのバス停」に使う） |
| `scripts/update_history.py` | 検証・grade計算・集計 |
| `scripts/build_bus.py` | `data/bus.json` を作る。都営バスは GTFS-JP、京成バスは時刻表を集めた JSON が入力。ダイヤ改正のときだけ実行する（日次ルーチンでは触らない） |
| `.github/workflows/pages.yml` | claude/** → main マージと Pages デプロイ |

ローカル確認：`python3 -m http.server` を実行して http://localhost:8000 を開く。
