#!/usr/bin/env python3
"""江戸川区内を約250m四方のマスに分け、各マスから通勤先までの所要時間（平日朝・バス＋電車）を見積もって data/commute.json を作る。

使い方:
  python3 scripts/build_commute.py --rail rail.json --toei ToeiBus-GTFS.zip --keisei keisei.json --poi-dir <国土数値情報フォルダ>

入力
- rail.json: {"駅名": {"min": 分}} … 各駅から通勤先までの電車の所要時間（平日朝、乗換案内で調べた最短）。
             通勤先の名前はこのリポジトリ（public）には書かない。
- 都営バス GTFS-JP / 京成バスの時刻表 JSON … build_bus.py と同じもの。バスの乗車時間と本数に使う。
- 江戸川区の範囲 … data/poi.json の小学校区を合わせた範囲。

見積もりの考え方（マスごとに、次のうち最も早いもの）
- 徒歩で駅へ：直線距離×1.3 を分速80mで歩く ＋ 駅での余裕 STATION_MARGIN 分 ＋ 電車
- バスで駅へ：バス停まで徒歩 ＋ 平均待ち時間（7時台の本数から、間隔の半分。最大15分）
              ＋ 乗車時間（7:00〜8:30発の便の中央値）＋ バス停から改札 STATION_MARGIN 分 ＋ 電車
ダイヤ改正や通勤先の変更があったら入力を作り直して再実行する（日次ルーチンでは触らない）。
"""
import argparse
import csv
import io
import json
import math
import statistics
import sys
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_bus import KEISEI_ALIAS, norm_route, tokyo_to_wgs84  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "commute.json"

# 江戸川区とその周辺の駅（世界測地系）
STATIONS = {
    "小岩": (35.7331, 139.8823), "新小岩": (35.7169, 139.8580), "平井": (35.7065, 139.8425),
    "篠崎": (35.7062, 139.9035), "瑞江": (35.6932, 139.8976), "一之江": (35.6863, 139.8830),
    "船堀": (35.6838, 139.8641), "東大島": (35.6899, 139.8461), "葛西": (35.6636, 139.8727),
    "西葛西": (35.6646, 139.8593), "葛西臨海公園": (35.6445, 139.8616), "京成小岩": (35.7433, 139.8846),
    "江戸川": (35.7390, 139.8960), "本八幡": (35.7210, 139.9270), "市川": (35.7292, 139.9081),
    "南行徳": (35.6726, 139.9020), "行徳": (35.6826, 139.9140),
}
STATION_NAME = {"江戸川": "江戸川（京成）"}
WALK_M_PER_MIN = 80
DETOUR = 1.3             # 道のりは直線距離の約1.3倍とみなす
STATION_MARGIN = 3       # 改札・ホームまでの余裕（分）
STATION_STOP_M = 350     # 駅からこの距離内のバス停を「駅のバス停」とみなす
MAX_WALK_STATION_M = 2500
MAX_WALK_STOP_M = 800
CELL_M = 250
AM_FROM, AM_TO = 7 * 60, 8 * 60 + 30


def dist_m(a, b):
    return math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * 90400)


def walk_min(m):
    return m * DETOUR / WALK_M_PER_MIN


def bus_trips(toei_zip, keisei_json):
    """平日の便: [(route, [(stop_key, (lat, lng), minute_of_day), ...])]"""
    trips = []
    z = zipfile.ZipFile(toei_zip)
    rd = lambda n: csv.DictReader(io.TextIOWrapper(z.open(n), encoding="utf-8-sig"))
    stops = {r["stop_id"]: r for r in rd("stops.txt")}
    parent = {sid: (r["parent_station"] or sid) for sid, r in stops.items()}
    routes = {r["route_id"]: norm_route(r["route_short_name"]) for r in rd("routes.txt")}
    weekday = {r["service_id"] for r in rd("calendar.txt") if r["monday"] == "1"}
    tr = {r["trip_id"]: routes[r["route_id"]] for r in rd("trips.txt") if r["service_id"] in weekday}
    seqs = defaultdict(list)
    for r in rd("stop_times.txt"):
        if r["trip_id"] in tr:
            h, m, _ = (int(v) for v in (r["departure_time"] or r["arrival_time"]).split(":"))
            p = stops[parent[r["stop_id"]]]
            seqs[r["trip_id"]].append((int(r["stop_sequence"]), f"t{parent[r['stop_id']]}", (float(p["stop_lat"]), float(p["stop_lon"])), h * 60 + m))
    for tid, s in seqs.items():
        s.sort()
        trips.append((tr[tid], [(k, ll, t) for _, k, ll, t in s]))

    d = json.loads(Path(keisei_json).read_text(encoding="utf-8"))
    kst = {sid: tokyo_to_wgs84(s["lat"], s["lng"]) for sid, s in d["stops"].items() if s.get("lat") is not None}
    groups = defaultdict(list)
    for x in d["deps"]:
        if x["day"] == "weekday":
            groups[(x["line"], x["trip"])].append(x)
    seen = set()
    for (line, _), deps in groups.items():
        deps.sort(key=lambda x: (x["h"], x["m"]))
        route = KEISEI_ALIAS.get((line, norm_route(deps[0]["route"])), norm_route(deps[0]["route"]))
        seq = [(f"k{x['stop']}", kst[x["stop"]], x["h"] * 60 + x["m"]) for x in deps if x["stop"] in kst]
        # 時刻表には終点の到着が載らないので、行き先名のバス停を終点として足す（到着は距離から見積もる。分速300m≒時速18km）
        dest = deps[0].get("dest") or ""
        ends = [sid for sid, s in d["stops"].items() if s["name"] == dest and sid in kst]
        if seq and ends and f"k{ends[0]}" != seq[-1][0]:
            m = dist_m(seq[-1][1], kst[ends[0]])
            if m <= 1500:
                seq.append((f"k{ends[0]}", kst[ends[0]], seq[-1][2] + max(1, round(m / 300))))
        sig = (route, tuple((k, t) for k, _, t in seq))
        if sig in seen or len(seq) < 2:
            continue
        seen.add(sig)
        trips.append((route, seq))
    return trips


def stop_costs(trips, rail):
    """バス停ごとに「そのバス停から通勤先まで」の最短見積もり（分）と経路"""
    station_stops = {st: set() for st in rail}
    locs = {}
    for _, seq in trips:
        for k, ll, _ in seq:
            locs[k] = ll
    for k, ll in locs.items():
        for st in rail:
            if dist_m(ll, STATIONS[st]) <= STATION_STOP_M:
                station_stops[st].add(k)
    ride = defaultdict(list)       # (stop, station, route) -> [乗車分]
    count = defaultdict(int)       # (stop, station) -> 7時台の本数
    for route, seq in trips:
        for i, (k, _, t) in enumerate(seq):
            if not (AM_FROM <= t <= AM_TO):
                continue
            reached = set()
            for k2, _, t2 in seq[i + 1:]:
                for st, ss in station_stops.items():
                    if k2 in ss and st not in reached and k not in ss:
                        reached.add(st)
                        ride[(k, st, route)].append(t2 - t)
                        if t < 8 * 60:
                            count[(k, st)] += 1
    best = {}
    for (k, st, route), rs in ride.items():
        n = max(count[(k, st)], 1)
        wait = min(15, 30 / n)
        c = wait + statistics.median(rs) + STATION_MARGIN + rail[st]
        if k not in best or c < best[k][0]:
            best[k] = (c, st, route)
    return best, locs


def edogawa_polygons(poi_path):
    poi = json.loads(Path(poi_path).read_text(encoding="utf-8"))
    return [poly[0] for d in poi["elementary_districts"] for poly in d["polygons"]]


def inside(pt, ring):
    lat, lng = pt
    c = False
    for i in range(len(ring)):
        a, b = ring[i], ring[i - 1]
        if (a[0] > lat) != (b[0] > lat) and lng < (b[1] - a[1]) * (lat - a[0]) / (b[0] - a[0]) + a[1]:
            c = not c
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rail", required=True)
    ap.add_argument("--toei", required=True)
    ap.add_argument("--keisei", required=True)
    args = ap.parse_args()
    rail = {k: v["min"] for k, v in json.loads(Path(args.rail).read_text(encoding="utf-8")).items() if v.get("min") and k in STATIONS}
    best, locs = stop_costs(bus_trips(args.toei, args.keisei), rail)
    rings = edogawa_polygons(ROOT / "data" / "poi.json")
    lat0, lat1 = min(p[0] for r in rings for p in r), max(p[0] for r in rings for p in r)
    lng0, lng1 = min(p[1] for r in rings for p in r), max(p[1] for r in rings for p in r)
    dlat, dlng = CELL_M / 111000, CELL_M / 90400
    via, cells = [], []
    lat = lat0 + dlat / 2
    while lat < lat1:
        lng = lng0 + dlng / 2
        while lng < lng1:
            pt = (lat, lng)
            if any(inside(pt, r) for r in rings):
                opts = []
                for st, t in rail.items():
                    m = dist_m(pt, STATIONS[st])
                    if m <= MAX_WALK_STATION_M:
                        opts.append((walk_min(m) + STATION_MARGIN + t, f"徒歩→{STATION_NAME.get(st, st)}"))
                for k, (c, st, route) in best.items():
                    m = dist_m(pt, locs[k])
                    if m <= MAX_WALK_STOP_M:
                        opts.append((walk_min(m) + c, f"バス（{route}）→{STATION_NAME.get(st, st)}"))
                if opts:
                    t, v = min(opts)
                    if v not in via:
                        via.append(v)
                    cells.append([round(lat, 5), round(lng, 5), round(t), via.index(v)])
            lng += dlng
        lat += dlat
    out = {
        "generated": date.today().isoformat(),
        "note": "平日朝（9時着）の目安。徒歩は直線距離×1.3を分速80m、バスは7〜8時台の時刻表から待ち時間と乗車時間を見積もり、電車は乗換案内の最短所要時間。",
        "cell": [round(dlat, 6), round(dlng, 6)],
        "via": via,
        "cells": cells,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    ts = [c[2] for c in cells]
    print(f"{OUT.relative_to(ROOT)}: マス {len(cells)} / {min(ts)}〜{max(ts)}分 / {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
