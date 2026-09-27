#!/usr/bin/env python3
"""江戸川区の小中学校と学区（小学校区・中学校区）をまとめ、data/poi.json を作る。

使い方:
  python3 scripts/build_poi.py --dir <国土数値情報を展開したフォルダ> [--osm shops.json]

入力（国土数値情報・国土交通省、2021年度版。東京都分）
- 学校       P29-21_13_GML.zip  https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P29-v2_0.html
- 小学校区   A27-21_13_GML.zip  https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A27-v3_0.html
- 中学校区   A32-21_13_GML.zip  https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A32-v3_0.html
それぞれ zip を展開した中の *.geojson を読む（測地系は JGD2011。地図の WGS84 と実用上同じ）。

コンビニ・スーパー（任意）: OpenStreetMap の Overpass API で取得した JSON（© OpenStreetMap contributors, ODbL）
  [out:json][bbox:35.63,139.83,35.76,139.93];(nwr["shop"="convenience"];nwr["shop"="supermarket"];);out center tags;

学区は年度によって変わることがあるので、最終的には区の学区表で確認すること。
年に1回程度、新しい版が出たら実行する（日次ルーチンでは触らない）。
"""
import argparse
import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "poi.json"
CITY = "13123"  # 江戸川区
SCHOOL_TYPES = {16001: "小学校", 16002: "中学校"}


def find(base, prefix):
    hits = sorted(Path(base).rglob(f"{prefix}*_13.geojson"))
    if not hits:
        raise SystemExit(f"{prefix} の geojson が {base} に見つかりません")
    return json.loads(hits[-1].read_text(encoding="utf-8"))["features"]


def ring(coords):
    """[lng, lat] の並びを [lat, lng]（小数5桁≒1m）に。連続する同一点は省く"""
    out = []
    for lng, lat in coords:
        p = [round(lat, 5), round(lng, 5)]
        if not out or out[-1] != p:
            out.append(p)
    return out


def districts(features, key):
    res = []
    for f in features:
        p = f["properties"]
        if p[f"{key}_001"] != CITY:
            continue
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        res.append({"school": p[f"{key}_004"], "address": p[f"{key}_005"], "polygons": [[ring(r) for r in poly] for poly in polys]})
    return sorted(res, key=lambda d: d["school"])


def shops(path):
    res = []
    for e in json.loads(Path(path).read_text(encoding="utf-8"))["elements"]:
        t = e.get("tags", {})
        lat, lng = (e["lat"], e["lon"]) if "lat" in e else (e["center"]["lat"], e["center"]["lon"])
        name = t.get("name:ja") or t.get("name") or t.get("brand:ja") or t.get("brand") or ("コンビニ" if t.get("shop") == "convenience" else "スーパー")
        res.append({"n": name, "t": "c" if t.get("shop") == "convenience" else "s", "lat": round(lat, 6), "lng": round(lng, 6)})
    return sorted(res, key=lambda x: (x["t"], x["n"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="国土数値情報の zip を展開したフォルダ")
    ap.add_argument("--osm", help="OpenStreetMap（Overpass API）のコンビニ・スーパーの JSON")
    args = ap.parse_args()
    schools = []
    for f in find(args.dir, "P29-21"):
        p = f["properties"]
        if p["P29_001"] == CITY and p["P29_003"] in SCHOOL_TYPES:
            lng, lat = f["geometry"]["coordinates"]
            schools.append({"name": p["P29_004"], "type": SCHOOL_TYPES[p["P29_003"]], "address": p["P29_005"], "lat": round(lat, 6), "lng": round(lng, 6)})
    schools.sort(key=lambda s: (s["type"], s["name"]))
    out = {
        "generated": date.today().isoformat(),
        "sources": [{"label": "国土数値情報（学校・小学校区・中学校区 2021年度）国土交通省", "url": "https://nlftp.mlit.go.jp/ksj/"}],
        "note": "学区は2021年度時点のデータです。最新の学区は江戸川区の通学区域で確認してください。",
        "schools": schools,
        "elementary_districts": districts(find(args.dir, "A27-21"), "A27"),
        "junior_districts": districts(find(args.dir, "A32-21"), "A32"),
    }
    if args.osm:
        out["shops"] = shops(args.osm)
        out["sources"].append({"label": "コンビニ・スーパー：© OpenStreetMap contributors（ODbL）", "url": "https://www.openstreetmap.org/copyright"})
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: 店舗 {len(out.get('shops', []))} / 学校 {len(schools)} / 小学校区 {len(out['elementary_districts'])} / 中学校区 {len(out['junior_districts'])} / {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
