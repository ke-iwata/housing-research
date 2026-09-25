#!/usr/bin/env python3
"""listings.json を検証し、判定(grade)を再計算して history.json に当日分の集計を追記する。

使い方:
  python3 scripts/update_history.py [YYYY-MM-DD]   検証＋grade再計算＋history追記（日付省略時は Asia/Tokyo の今日）
  python3 scripts/update_history.py --check-only   検証のみ（ファイルは変更しない）
エラーがあれば非ゼロで終了する。
"""
import json
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LISTINGS = ROOT / "data" / "listings.json"
HISTORY = ROOT / "data" / "history.json"

STATUSES = {"match", "near", "reference"}
ZONES = {"first", "second", "reserve", "other"}
REQUIRED = ["id", "address", "town", "zone", "price_man", "building_m2", "layout",
            "sources", "status", "first_seen", "last_seen", "price_history", "active"]
PRICE_MAX, PRICE_COMFORT, AREA_MIN, AREA_IDEAL = 7500, 7000, 110, 120


def grade(x):
    """◎=6,000〜7,000万円かつ120㎡以上 / ○=妥協1つ（価格7,000〜7,500万円 または 延床110〜120㎡）/ △=妥協2つ"""
    if x["status"] != "match":
        return None
    compromises = (x["price_man"] > PRICE_COMFORT) + (x["building_m2"] < AREA_IDEAL)
    return "◎○△"[compromises]


def validate(data):
    errors = []
    ids = set()
    for i, x in enumerate(data.get("listings", [])):
        where = f"listings[{i}] ({x.get('id')})"
        for k in REQUIRED:
            if k not in x or x[k] in ("", None) and k not in ("building_m2",):
                errors.append(f"{where}: '{k}' がありません")
        if x.get("id") in ids:
            errors.append(f"{where}: id が重複しています")
        ids.add(x.get("id"))
        if x.get("status") not in STATUSES:
            errors.append(f"{where}: status は {STATUSES} のいずれか")
        if x.get("zone") not in ZONES:
            errors.append(f"{where}: zone は {ZONES} のいずれか")
        if not isinstance(x.get("price_man"), (int, float)):
            errors.append(f"{where}: price_man は数値（万円）")
        if x.get("building_m2") is not None and not isinstance(x.get("building_m2"), (int, float)):
            errors.append(f"{where}: building_m2 は数値（㎡）")
        if x.get("lat") is not None and not (35.60 < x["lat"] < 35.78 and 139.82 < x["lng"] < 139.95):
            errors.append(f"{where}: 座標が江戸川区の範囲外です")
        if x.get("status") == "match":
            if x["price_man"] > PRICE_MAX:
                errors.append(f"{where}: match なのに価格が {PRICE_MAX} 万円超")
            if (x.get("building_m2") or 0) < AREA_MIN:
                errors.append(f"{where}: match なのに延床が {AREA_MIN}㎡ 未満")
    return errors


def main():
    jst = timezone(timedelta(hours=9))
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    date = args[0] if args else datetime.now(jst).strftime("%Y-%m-%d")
    data = json.loads(LISTINGS.read_text(encoding="utf-8"))
    errors = validate(data)
    if errors:
        print("検証エラー:\n  " + "\n  ".join(errors), file=sys.stderr)
        sys.exit(1)
    if "--check-only" in sys.argv:
        json.loads(HISTORY.read_text(encoding="utf-8")) if HISTORY.exists() else None
        print(f"OK: {len(data['listings'])}件、検証エラーなし")
        return

    for x in data["listings"]:
        x["grade"] = grade(x)
    LISTINGS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    active = [x for x in data["listings"] if x.get("active")]
    match = [x for x in active if x["status"] == "match"]
    near = [x for x in active if x["status"] == "near"]
    unit = [x["price_man"] / x["building_m2"] for x in active if x.get("building_m2")]
    entry = {
        "date": date,
        "total": len(active),
        "match": len(match),
        "near": len(near),
        "new": sum(1 for x in active if x.get("first_seen") == date),
        "median_price_match": statistics.median([x["price_man"] for x in match]) if match else None,
        "median_unit_price": round(statistics.median(unit), 2) if unit else None,
    }
    history = json.loads(HISTORY.read_text(encoding="utf-8")) if HISTORY.exists() else []
    history = [h for h in history if h["date"] != date] + [entry]
    history.sort(key=lambda h: h["date"])
    HISTORY.write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK {date}: 掲載中 {entry['total']}件 / 条件合致 {entry['match']}件 / 惜しい {entry['near']}件 / 新着 {entry['new']}件")


if __name__ == "__main__":
    main()
