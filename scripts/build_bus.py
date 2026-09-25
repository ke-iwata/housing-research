#!/usr/bin/env python3
"""候補エリア周辺のバス路線と時間帯別の本数をまとめ、data/bus.json を作る。

使い方:
  python3 scripts/build_bus.py --toei ToeiBus-GTFS.zip --keisei keisei.json

入力
- 都営バス: 東京都交通局 GTFS-JP（公共交通オープンデータセンター、CC BY 4.0）
    https://api-public.odpt.org/api/v4/files/Toei/data/ToeiBus-GTFS.zip
- 京成バス: 時刻表を停留所ごとに集めた JSON（{"stops": {id: {name, lat, lng}}, "deps": [{stop, trip, line, day, h, m, route, dest}]}）
    京成バスは GTFS を公開していないため、時刻表サイトから別途集めたものを使う。

出力（data/bus.json）
- stops:  停留所。h = 曜日区分ごとの1時間あたりの発車本数（両方向の合計, 0〜23時）、am = 平日6〜9時台の系統・行き先別の本数
- routes: 系統。edges = 隣り合う停留所の区間と、その区間を通る便の数（両方向の合計, 時間帯別）

ダイヤ改正があったら入力を取り直して再実行する（毎日の更新ルーチンでは実行しない）。
"""
import argparse
import csv
import io
import json
import math
import re
import unicodedata
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "bus.json"
DAYS = ["weekday", "saturday", "holiday"]
NEAR_M = 700          # 候補エリアの町の代表点からこの距離内の停留所を「エリア内」とみなす
MIN_NEAR_STOPS = 3    # 都営バスは、エリア内の停留所を3つ以上通る系統だけ採用


def norm_route(name):
    s = unicodedata.normalize("NFKC", name).replace("－", "-").replace("−", "-")
    return re.sub(r"深夜$", "", s).strip()


def dist_m(a, b):
    return math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * 90400)


def zone_points():
    cfg = json.loads((ROOT / "data" / "config.json").read_text(encoding="utf-8"))
    return [(t["lat"], t["lng"]) for z in cfg.get("zones", []) for t in z["towns"]]


class Acc:
    """停留所・区間の本数を積み上げる"""

    def __init__(self):
        self.stops = {}
        self.stop_h = defaultdict(lambda: {d: [0] * 24 for d in DAYS})
        self.stop_am = defaultdict(lambda: defaultdict(lambda: [0, 0, 0, 0]))
        self.stop_routes = defaultdict(set)
        self.edges = defaultdict(lambda: {d: [0] * 24 for d in DAYS})
        self.route_op = {}

    def trip(self, op, route, day, seq):
        """seq = [(stop_id, hour, dest)] 停車順"""
        self.route_op[route] = op
        for i, (sid, h, dest) in enumerate(seq):
            hh = h % 24
            if i < len(seq) - 1:  # 終点は発車しない
                self.stop_h[sid][day][hh] += 1
                if day == "weekday" and 6 <= h <= 9:
                    self.stop_am[sid][(route, dest)][h - 6] += 1
            self.stop_routes[sid].add(route)
            if i:
                a = seq[i - 1][0]
                if a != sid:
                    key = (route, *sorted((a, sid)))
                    self.edges[key][day][seq[i - 1][1] % 24] += 1


def load_toei(path, acc, pts):
    z = zipfile.ZipFile(path)
    rd = lambda n: csv.DictReader(io.TextIOWrapper(z.open(n), encoding="utf-8-sig"))
    raw_stops = {r["stop_id"]: r for r in rd("stops.txt")}
    parent = {sid: (r["parent_station"] or sid) for sid, r in raw_stops.items()}
    routes = {r["route_id"]: norm_route(r["route_short_name"]) for r in rd("routes.txt")}
    cal = {}
    for r in rd("calendar.txt"):
        if r["monday"] == "1":
            cal[r["service_id"]] = "weekday"
        elif r["saturday"] == "1":
            cal[r["service_id"]] = "saturday"
        elif r["sunday"] == "1":
            cal[r["service_id"]] = "holiday"
    trips = {r["trip_id"]: (routes[r["route_id"]], cal.get(r["service_id"]), r.get("trip_headsign", "")) for r in rd("trips.txt")}

    near = {sid for sid, r in raw_stops.items() if r["stop_lat"] and min(dist_m((float(r["stop_lat"]), float(r["stop_lon"])), p) for p in pts) < NEAR_M}
    seqs = defaultdict(list)
    for r in rd("stop_times.txt"):
        seqs[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"], r["departure_time"] or r["arrival_time"]))
    near_by_route = defaultdict(set)
    for tid, seq in seqs.items():
        route = trips[tid][0]
        for _, sid, _ in seq:
            if sid in near:
                near_by_route[route].add(parent[sid])
    keep = {r for r, s in near_by_route.items() if len(s) >= MIN_NEAR_STOPS}
    print("都営バス 採用系統:", ", ".join(sorted(keep)))
    for tid, seq in seqs.items():
        route, day, head = trips[tid]
        if route not in keep or not day:
            continue
        seq.sort()
        dest = head or raw_stops[seq[-1][1]]["stop_name"]
        items = [(f"t{parent[sid]}", int(t.split(":")[0]), dest) for _, sid, t in seq]
        acc.trip("toei", route, day, items)
        for _, sid, _ in seq:
            p = raw_stops[parent[sid]]
            acc.stops[f"t{parent[sid]}"] = {"name": p["stop_name"], "lat": float(p["stop_lat"]), "lng": float(p["stop_lon"]), "op": "toei"}


# 時刻表の系統表示が「路線バス」「深夜」などになっている便の呼び名（(路線ページID, 表示) → 系統名）
KEISEI_ALIAS = {
    ("00012460", "路線バス"): "小72",   # 瑞江駅-江戸川スポーツランドの区間便
    ("00012460", ""): "小72",          # 同・深夜便
    ("00012472", "路線バス"): "小73・76（清掃工場便）",
    ("00012477", "SS07"): "シャトル☆セブン",
    ("00012477", "SS08"): "シャトル☆セブン",
}


def load_keisei(path, acc):
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    for sid, s in d["stops"].items():
        if s.get("lat") is not None:
            acc.stops[f"k{sid}"] = {"name": s["name"], "lat": s["lat"], "lng": s["lng"], "op": "keisei"}
    trips = defaultdict(list)
    for x in d["deps"]:
        trips[(x["line"], x["trip"], x["day"])].append(x)
    seen = set()
    n = 0
    for (line, trip, day), deps in trips.items():
        deps.sort(key=lambda x: (x["h"], x["m"]))
        # 同じ便が複数のページに載っている場合の重複を除く（系統・曜日・停留所と時刻の並びが同じなら同一便）
        route = norm_route(deps[0]["route"])
        route = KEISEI_ALIAS.get((line, route), route)
        sig = (day, route, tuple((x["stop"], x["h"], x["m"]) for x in deps))
        if sig in seen:
            continue
        seen.add(sig)
        dest = deps[0]["dest"] or ""
        # 終点は時刻表に載らないので、最後の停留所の次は行き先名の停留所へつなぐ
        items = [(f"k{x['stop']}", x["h"], dest) for x in deps]
        last = [sid for sid, s in d["stops"].items() if s["name"] == dest]
        prev = d["stops"][deps[-1]["stop"]]
        near_end = last and dist_m((prev["lat"], prev["lng"]), (d["stops"][last[0]]["lat"], d["stops"][last[0]]["lng"])) <= MAX_GAP_M
        if near_end and f"k{last[0]}" != items[-1][0]:
            items.append((f"k{last[0]}", deps[-1]["h"], dest))
        else:
            items.append(items[-1])  # 終点の扱いをそろえるためのダミー（同一停留所の区間は数えない）
        acc.trip("keisei", route, day, items)
        n += 1
    print("京成バス 便数（重複除去後）:", n)


MAX_GAP_M = 1200  # 京成バスで隣り合う停留所とみなす最大距離
LONG_OK = {"シャトル☆セブン"}
BBOX = (35.645, 35.745, 139.835, 139.935)  # 江戸川区の北部〜中部（候補エリアの周り）だけ地図に出す


def inside(s):
    return BBOX[0] <= s["lat"] <= BBOX[1] and BBOX[2] <= s["lng"] <= BBOX[3]


def build(acc):
    stops_out = []

    def ok(k):
        route, a, b = k
        if not (a in acc.stops and b in acc.stops and inside(acc.stops[a]) and inside(acc.stops[b])):
            return False
        # 京成バスは時刻表ページに載らない停留所があり、離れた停留所どうしが直結されることがあるので除く（急行のシャトル☆セブンは除外しない）
        sa, sb = acc.stops[a], acc.stops[b]
        return acc.route_op[route] != "keisei" or route in LONG_OK or dist_m((sa["lat"], sa["lng"]), (sb["lat"], sb["lng"])) <= MAX_GAP_M

    for key in [k for k in acc.edges if not ok(k)]:
        del acc.edges[key]
    used = set()
    for (_, a, b) in acc.edges:
        used |= {a, b}
    for sid, s in acc.stops.items():
        if sid not in used:
            continue
        am = [{"route": r, "dest": dest, "n": v} for (r, dest), v in sorted(acc.stop_am[sid].items()) if sum(v)]
        stops_out.append({"id": sid, **s, "routes": sorted(acc.stop_routes[sid]), "h": acc.stop_h[sid], "am": am})
    routes = defaultdict(list)
    for (route, a, b), f in acc.edges.items():
        if a in acc.stops and b in acc.stops:
            routes[route].append({"a": a, "b": b, "f": f})
    routes_out = [{"name": r, "op": acc.route_op[r], "edges": e} for r, e in sorted(routes.items())]
    return stops_out, routes_out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--toei", help="都営バス GTFS-JP の zip")
    ap.add_argument("--keisei", help="京成バスの時刻表 JSON")
    args = ap.parse_args()
    acc = Acc()
    if args.toei:
        load_toei(args.toei, acc, zone_points())
    if args.keisei:
        load_keisei(args.keisei, acc)
    stops, routes = build(acc)
    out = {
        "generated": date.today().isoformat(),
        "sources": [
            {"label": "都営バス：東京都交通局 GTFS-JP（公共交通オープンデータセンター、CC BY 4.0）", "url": "https://ckan.odpt.org/dataset/b_bus_gtfs_jp-toei"},
            {"label": "京成バス：路線バス時刻表（NAVITIME）から停留所ごとの本数を集計", "url": "https://www.navitime.co.jp/bus/company/00001040/"},
        ],
        "note": "線は停留所を順に結んだもので、実際の道路の形とは異なります。本数は両方向の合計です。",
        "stops": stops,
        "routes": routes,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: 停留所 {len(stops)} / 系統 {len(routes)} / {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
