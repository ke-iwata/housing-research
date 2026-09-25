/* 江戸川区 新築戸建てウォッチ — 表示ロジック（データは data/*.json、ビルド不要） */
(() => {
  "use strict";

  const STATUS = {
    match: { label: "条件合致", var: "--match" },
    near: { label: "惜しい", var: "--near" },
    reference: { label: "参考", var: "--ref" },
  };
  const ZONE_LABEL = { first: "第一候補", second: "第二候補", reserve: "予備", other: "エリア外" };
  const ZONE_ORDER = ["first", "second", "reserve", "other"];

  const state = { statuses: new Set(["match", "near", "reference"]), zone: "all", sort: { key: "status", dir: 1 } };
  let config, data, history, map, markerLayer, zoneLayer, floodLayer, tideLayer;
  const markers = new Map();
  const charts = {};

  const $ = (s) => document.querySelector(s);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const man = (v) => (v == null ? "—" : v >= 10000 ? `${Math.floor(v / 10000)}億${v % 10000 ? (v % 10000).toLocaleString() + "万" : ""}円` : `${v.toLocaleString()}万円`);
  const m2 = (v) => (v == null ? "—" : `${Number(v).toFixed(2).replace(/\.?0+$/, "")}㎡`);
  const fmtDate = (s) => (s ? s.slice(5).replace("-", "/") : "—");

  async function getJSON(path, fallback) {
    try {
      const r = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      console.warn("読み込み失敗", path, e);
      return fallback;
    }
  }

  async function init() {
    [config, data, history] = await Promise.all([
      getJSON("data/config.json", {}),
      getJSON("data/listings.json", { listings: [], ended: [], land: [] }),
      getJSON("data/history.json", []),
    ]);
    renderHeader();
    renderChips();
    renderZoneSelect();
    initMap();
    renderAll();
    renderEnded();
    renderLand();
    renderLinks();
    initCalc();
    loadReport();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { renderCharts(); renderMarkers(); renderZones(); });
  }

  const active = () => (data.listings || []).filter((x) => x.active !== false);
  const filtered = () => active().filter((x) => state.statuses.has(x.status) && (state.zone === "all" || x.zone === state.zone));

  function renderHeader() {
    const c = config.criteria || {};
    $("#criteria").textContent = `${c.type ?? "新築一戸建て"}｜${c.layout ?? ""}｜延床${c.building_min_m2 ?? 110}㎡以上（理想${c.building_ideal_m2 ?? 120}㎡）｜駐車場${c.parking ?? ""}｜${(c.price_max_man ?? 7500).toLocaleString()}万円以下`;
    if (data.updated_at) {
      const d = new Date(data.updated_at);
      $("#updated").textContent = d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
    }
    $("#summary").textContent = data.summary || "サマリーはまだありません。";
    const ss = data.source_status || {};
    $("#source-status").innerHTML = Object.entries(ss)
      .map(([k, v]) => `<li class="${v === "ok" ? "ok" : v === "failed" ? "ng" : "na"}" title="${v === "ok" ? "取得できた" : v === "failed" ? "取得できなかった" : "未確認"}">${esc(k)}</li>`)
      .join("");
  }

  function renderKpis() {
    const a = active();
    const match = a.filter((x) => x.status === "match");
    const near = a.filter((x) => x.status === "near");
    const today = history.length ? history[history.length - 1].date : null;
    const newCount = a.filter((x) => x.first_seen === today).length;
    const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const best = [...match].sort((p, q) => "◎○△".indexOf(p.grade) - "◎○△".indexOf(q.grade) || p.price_man - q.price_man)[0];
    const prev = history.length > 1 ? history[history.length - 2] : null;
    const delta = (cur, key) => (prev && prev[key] != null ? cur - prev[key] : null);
    const dtxt = (d) => (d == null ? "" : d === 0 ? "前日と同じ" : `前日比 ${d > 0 ? "+" : ""}${d}`);
    const tiles = [
      { label: "条件合致", dot: "--match", value: match.length, unit: "件", sub: dtxt(delta(match.length, "match")) },
      { label: "惜しい", dot: "--near", value: near.length, unit: "件", sub: dtxt(delta(near.length, "near")) },
      { label: "本日の新着", value: newCount, unit: "件", sub: `掲載中 ${a.length}件` },
      { label: "条件合致の中央値", value: median(match.map((x) => x.price_man)), unit: "万円", fmt: true, sub: best ? `イチオシ：${best.town} ${best.grade ?? ""}` : "—" },
    ];
    $("#kpis").innerHTML = tiles
      .map((t) => `<div class="kpi"><div class="label">${t.dot ? `<span class="dot" style="background:var(${t.dot})"></span>` : ""}${t.label}</div>
        <div class="value">${t.value == null ? "—" : t.fmt ? Math.round(t.value).toLocaleString() : t.value}<small>${t.value == null ? "" : t.unit}</small></div>
        <div class="sub">${esc(t.sub)}</div></div>`)
      .join("");
  }

  function renderChips() {
    const counts = {};
    active().forEach((x) => (counts[x.status] = (counts[x.status] || 0) + 1));
    $("#status-chips").innerHTML = Object.entries(STATUS)
      .map(([k, s]) => `<button type="button" class="chip" data-status="${k}" aria-pressed="${state.statuses.has(k)}"><span class="dot" style="background:var(${s.var})"></span>${s.label}<span class="muted">${counts[k] || 0}</span></button>`)
      .join("");
    $("#status-chips").querySelectorAll(".chip").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.status;
        state.statuses.has(k) ? state.statuses.delete(k) : state.statuses.add(k);
        b.setAttribute("aria-pressed", state.statuses.has(k));
        renderAll();
      })
    );
  }

  function renderZoneSelect() {
    const sel = $("#zone-filter");
    ZONE_ORDER.forEach((z) => {
      const zc = (config.zones || []).find((q) => q.id === z);
      const o = document.createElement("option");
      o.value = z;
      o.textContent = zc ? zc.label : ZONE_LABEL[z];
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => { state.zone = sel.value; renderAll(); });
  }

  function renderAll() {
    renderKpis();
    renderMarkers();
    renderCharts();
    renderTable();
  }

  /* ---------- 地図 ---------- */
  function initMap() {
    map = L.map("map", { scrollWheelZoom: false, zoomControl: true }).setView([35.698, 139.888], 14);
    L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
      maxZoom: 18, className: "base-tiles",
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>',
    }).addTo(map);
    floodLayer = L.tileLayer("https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png", { opacity: 0.55, maxNativeZoom: 17, maxZoom: 18, attribution: "洪水浸水想定：ハザードマップポータル" });
    tideLayer = L.tileLayer("https://disaportaldata.gsi.go.jp/raster/03_hightide_l2_shinsuishin_data/{z}/{x}/{y}.png", { opacity: 0.55, maxNativeZoom: 17, maxZoom: 18, attribution: "高潮浸水想定：ハザードマップポータル" });
    zoneLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    map.on("click", () => map.scrollWheelZoom.enable());
    map.on("mouseout", () => map.scrollWheelZoom.disable());

    (config.stations || []).forEach((s) => {
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: "", html: `<div style="width:12px;height:12px;background:var(--surface);border:3px solid var(--text-2);border-radius:3px"></div>`, iconSize: [12, 12] }),
        keyboard: false,
      }).bindTooltip(`${s.name}`, { permanent: true, direction: "right", className: "station-label", offset: [6, 0] }).addTo(map);
    });

    const toggle = (id, layer, onAdd) => $(id).addEventListener("change", (e) => {
      e.target.checked ? layer.addTo(map) : map.removeLayer(layer);
      if (onAdd) onAdd();
    });
    toggle("#lyr-zones", zoneLayer);
    const hazardNote = () => ($("#hazard-note").hidden = !($("#lyr-flood").checked || $("#lyr-tide").checked));
    toggle("#lyr-flood", floodLayer, hazardNote);
    toggle("#lyr-tide", tideLayer, hazardNote);

    const legend = L.control({ position: "bottomleft" });
    legend.onAdd = () => {
      const d = L.DomUtil.create("div", "map-legend");
      d.innerHTML = Object.values(STATUS).map((s) => `<div><span class="dot" style="background:var(${s.var})"></span>${s.label}</div>`).join("") +
        `<div><span class="ring" style="border-color:var(--zone-first)"></span>第一候補</div><div><span class="ring" style="border-color:var(--zone-second)"></span>第二候補</div><div><span class="ring" style="border-color:var(--zone-reserve)"></span>予備</div>`;
      return d;
    };
    legend.addTo(map);
    renderZones();
    const pts = [];
    (config.zones || []).forEach((z) => z.towns.forEach((t) => pts.push([t.lat, t.lng])));
    active().filter((x) => x.lat != null && x.zone !== "other").forEach((x) => pts.push([x.lat, x.lng]));
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.08));
  }

  function renderZones() {
    zoneLayer.clearLayers();
    (config.zones || []).forEach((z) => {
      const color = css(`--zone-${z.id}`);
      z.towns.forEach((t) => {
        L.circle([t.lat, t.lng], { radius: z.id === "reserve" ? 380 : 480, color, weight: 2, dashArray: "6 6", fillColor: color, fillOpacity: 0.06 })
          .bindTooltip(`<b>${esc(t.name)}</b><br>${esc(z.label)}<br><span style="font-size:11px">${esc(z.note)}</span>`, { sticky: true })
          .addTo(zoneLayer);
      });
    });
  }

  function popupHtml(x) {
    const src = (x.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.site)}</a>`).join("・");
    return `<div class="pop"><h3>${esc(x.address.replace("東京都江戸川区", ""))} ${x.grade ? `<span class="grade">${x.grade}</span>` : ""}</h3>
      <div class="price">${man(x.price_man)}</div>
      <div>延床 ${m2(x.building_m2)}／土地 ${m2(x.land_m2)}／${esc(x.layout)}</div>
      <div>${esc(x.access || "")}${x.bus ? `<br>バス：${esc(x.bus)}` : ""}</div>
      <div>駐車場：${esc(x.parking || "不明")}／完成：${esc(x.completion || "—")}</div>
      ${x.note ? `<div class="muted">${esc(x.note)}</div>` : ""}
      <div>${src}</div></div>`;
  }

  function renderMarkers() {
    markerLayer.clearLayers();
    markers.clear();
    const ring = css("--surface");
    const order = { reference: 0, near: 1, match: 2 };
    [...filtered()].sort((p, q) => order[p.status] - order[q.status]).forEach((x) => {
      if (x.lat == null) return;
      const m = L.circleMarker([x.lat, x.lng], {
        radius: x.status === "match" ? 10 : 8, color: ring, weight: 2, fillColor: css(STATUS[x.status].var), fillOpacity: 1,
      }).bindPopup(popupHtml(x), { maxWidth: 280 })
        .bindTooltip(`${esc(x.town)}｜${man(x.price_man)}｜${m2(x.building_m2)}`, { direction: "top", offset: [0, -8] });
      m.addTo(markerLayer);
      markers.set(x.id, m);
    });
  }

  function focus(id) {
    const m = markers.get(id);
    if (!m) return;
    map.setView(m.getLatLng(), 15, { animate: true });
    m.openPopup();
    $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ---------- グラフ ---------- */
  function baseOpts() {
    const text2 = css("--text-2"), grid = css("--grid"), surface = css("--surface"), text = css("--text"), border = css("--border");
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = text2;
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, boxHeight: 8, color: text2 } },
        tooltip: { backgroundColor: surface, titleColor: text, bodyColor: text2, borderColor: border, borderWidth: 1, padding: 10, cornerRadius: 8, usePointStyle: true, boxPadding: 4 },
      },
      scales: {
        x: { grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { padding: 6 } },
        y: { grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { padding: 6 } },
      },
    };
  }

  const budgetPlugin = {
    id: "budget",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x, y } } = chart;
      const c = config.criteria || {};
      const [lo, hi] = c.price_comfort_man || [6000, 7000];
      ctx.save();
      ctx.fillStyle = css("--band");
      const y1 = Math.max(y.getPixelForValue(hi), a.top), y2 = Math.min(y.getPixelForValue(lo), a.bottom);
      if (y2 > y1) ctx.fillRect(a.left, y1, a.right - a.left, y2 - y1);
      ctx.strokeStyle = css("--text-2");
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      const hline = (v, label) => { const py = y.getPixelForValue(v); if (py < a.top || py > a.bottom) return; ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke(); ctx.fillStyle = css("--text-2"); ctx.fillText(label, a.left + 4, py - 4); };
      const vline = (v, label) => { const px = x.getPixelForValue(v); if (px < a.left || px > a.right) return; ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.fillStyle = css("--text-2"); ctx.fillText(label, px + 4, a.top + 12); };
      ctx.font = `11px ${Chart.defaults.font.family}`;
      hline(c.price_max_man || 7500, "上限 7,500万円");
      vline(c.building_min_m2 || 110, "110㎡");
      vline(c.building_ideal_m2 || 120, "120㎡");
      ctx.restore();
    },
  };

  function renderCharts() {
    Object.values(charts).forEach((c) => c.destroy());
    const opts = baseOpts();
    const rows = filtered().filter((x) => x.building_m2 != null);

    charts.scatter = new Chart($("#chart-scatter"), {
      type: "scatter",
      data: {
        datasets: Object.entries(STATUS).filter(([k]) => state.statuses.has(k)).map(([k, s]) => ({
          label: s.label,
          data: rows.filter((x) => x.status === k).map((x) => ({ x: x.building_m2, y: x.price_man, item: x })),
          backgroundColor: css(s.var), borderColor: css("--surface"), borderWidth: 2, pointRadius: k === "match" ? 7 : 6, pointHoverRadius: 9, pointHitRadius: 12,
        })),
      },
      options: {
        ...opts,
        interaction: { mode: "nearest", intersect: true },
        onClick: (e, els) => { if (els[0]) focus(els[0].element.$context.raw.item.id); },
        plugins: {
          ...opts.plugins,
          tooltip: { ...opts.plugins.tooltip, callbacks: {
            title: (it) => it[0].raw.item.address.replace("東京都江戸川区", ""),
            label: (it) => `${man(it.raw.y)}｜延床 ${m2(it.raw.x)}｜${it.raw.item.layout}`,
            afterLabel: (it) => it.raw.item.access || "",
          } },
        },
        scales: {
          x: { ...opts.scales.x, title: { display: true, text: "延床面積（㎡）" }, suggestedMin: 95, suggestedMax: 140 },
          y: { ...opts.scales.y, title: { display: true, text: "価格（万円）" }, suggestedMin: 5000, suggestedMax: 9500, ticks: { ...opts.scales.y.ticks, callback: (v) => v.toLocaleString() } },
        },
      },
      plugins: [budgetPlugin],
    });

    const zoneRows = ZONE_ORDER.filter((z) => state.zone === "all" || z === state.zone);
    charts.zones = new Chart($("#chart-zones"), {
      type: "bar",
      data: {
        labels: zoneRows.map((z) => ZONE_LABEL[z]),
        datasets: Object.entries(STATUS).filter(([k]) => state.statuses.has(k)).map(([k, s]) => ({
          label: s.label,
          data: zoneRows.map((z) => filtered().filter((x) => x.zone === z && x.status === k).length),
          backgroundColor: css(s.var), borderColor: css("--surface"), borderWidth: { right: 2 }, borderRadius: 4, borderSkipped: "left", barThickness: 22,
        })),
      },
      options: {
        ...opts, indexAxis: "y",
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { ...opts.scales.x, stacked: true, ticks: { ...opts.scales.x.ticks, precision: 0 }, title: { display: true, text: "件数" } },
          y: { ...opts.scales.y, stacked: true, grid: { display: false } },
        },
      },
    });

    const h = history.slice(-90);
    const lineDs = (label, key, colorVar) => ({
      label, data: h.map((r) => r[key]), borderColor: css(colorVar), backgroundColor: css(colorVar), borderWidth: 2, tension: 0.25,
      pointRadius: h.length > 20 ? 0 : 4, pointHoverRadius: 6, pointBorderColor: css("--surface"), pointBorderWidth: 2, spanGaps: true,
    });
    const hopts = {
      ...opts,
      interaction: { mode: "index", intersect: false },
      scales: { x: { ...opts.scales.x, grid: { display: false } }, y: { ...opts.scales.y, beginAtZero: true, ticks: { ...opts.scales.y.ticks, precision: 0 } } },
    };
    charts.count = new Chart($("#chart-count"), {
      type: "line",
      data: { labels: h.map((r) => fmtDate(r.date)), datasets: [lineDs("条件合致", "match", "--match"), lineDs("惜しい", "near", "--near")] },
      options: hopts,
    });
    charts.unit = new Chart($("#chart-unit"), {
      type: "line",
      data: { labels: h.map((r) => fmtDate(r.date)), datasets: [lineDs("㎡単価（万円/㎡）", "median_unit_price", "--match")] },
      options: { ...hopts, plugins: { ...hopts.plugins, legend: { display: false } }, scales: { ...hopts.scales, y: { ...hopts.scales.y, beginAtZero: false } } },
    });
  }

  /* ---------- 一覧 ---------- */
  function renderTable() {
    const rows = filtered();
    const rank = { match: 0, near: 1, reference: 2 };
    const { key, dir } = state.sort;
    rows.sort((p, q) => {
      let a = p[key], b = q[key];
      if (key === "status") { a = rank[p.status] * 10 + "◎○△".indexOf(p.grade ?? "△"); b = rank[q.status] * 10 + "◎○△".indexOf(q.grade ?? "△"); }
      if (a == null) return 1;
      if (b == null) return -1;
      return (a > b ? 1 : a < b ? -1 : 0) * dir || p.price_man - q.price_man;
    });
    const latest = history.length ? history[history.length - 1].date : null;
    $("#list-count").textContent = `${rows.length}件表示`;
    $("#table tbody").innerHTML = rows.map((x) => {
      const ph = x.price_history || [];
      const prevPrice = ph.length > 1 ? ph[ph.length - 2].price_man : null;
      const pchg = prevPrice != null && prevPrice !== x.price_man ? `<span class="pchg">${prevPrice.toLocaleString()}→${x.price_man.toLocaleString()}万</span>` : "";
      const src = (x.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(s.site)}</a>`).join("<br>");
      return `<tr data-id="${esc(x.id)}">
        <td><span class="badge"><span class="dot" style="background:var(${STATUS[x.status].var})"></span>${STATUS[x.status].label}${x.grade ? ` <span class="grade">${x.grade}</span>` : ""}</span></td>
        <td>${esc(x.address.replace("東京都江戸川区", ""))}${x.first_seen === latest ? '<span class="new">NEW</span>' : ""}<span class="note-line">${esc(ZONE_LABEL[x.zone])}${x.note ? "｜" + esc(x.note) : ""}</span></td>
        <td class="num">${man(x.price_man)}${pchg}</td>
        <td class="num">${m2(x.building_m2)}</td>
        <td class="num">${m2(x.land_m2)}</td>
        <td>${esc(x.layout)}</td>
        <td>${esc(x.access || "—")}${x.bus ? `<span class="note-line">${esc(x.bus)}</span>` : ""}</td>
        <td>${esc(x.parking || "不明")}</td>
        <td class="num">${fmtDate(x.first_seen)}</td>
        <td>${src}</td></tr>`;
    }).join("") || `<tr><td colspan="10" class="muted">該当する物件はありません</td></tr>`;
    $("#table tbody").querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => focus(tr.dataset.id)));
    document.querySelectorAll("#table th[data-sort]").forEach((th) => {
      th.classList.toggle("sorted-asc", th.dataset.sort === key && dir === 1);
      th.classList.toggle("sorted-desc", th.dataset.sort === key && dir === -1);
      th.onclick = () => { state.sort = { key: th.dataset.sort, dir: state.sort.key === th.dataset.sort ? -state.sort.dir : 1 }; renderTable(); };
    });
  }

  function renderEnded() {
    const ended = [...(data.ended || []), ...(data.listings || []).filter((x) => x.active === false)].slice(-15).reverse();
    $("#ended").innerHTML = ended.length
      ? ended.map((x) => `<li><span class="dot" style="background:var(${(STATUS[x.status] || STATUS.reference).var})"></span> ${esc((x.address || "").replace("東京都江戸川区", ""))}｜${man(x.price_man)}｜${m2(x.building_m2)}<span class="muted small">（${fmtDate(x.first_seen)}〜${fmtDate(x.ended_on || x.last_seen)}）</span></li>`).join("")
      : `<li class="muted">まだありません</li>`;
  }

  function renderLand() {
    const land = data.land || [];
    $("#land").innerHTML = land.length
      ? land.map((x) => `<li>${esc((x.address || "").replace("東京都江戸川区", ""))}｜${man(x.price_man)}｜${m2(x.land_m2)}${x.land_m2 ? `（約${(x.land_m2 / 3.30579).toFixed(1)}坪）` : ""} ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.site || "掲載元")}</a>` : ""}${x.note ? `<span class="note-line">${esc(x.note)}</span>` : ""}</li>`).join("")
      : `<li class="muted">条件に合う土地は見つかっていません</li>`;
  }

  function renderLinks() {
    $("#links").innerHTML = (config.links || []).map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a></li>`).join("");
  }

  /* ---------- 返済シミュレーション ---------- */
  function initCalc() {
    const pmt = (loanMan, rate, years) => { const n = years * 12, r = rate / 100 / 12, P = loanMan * 10000; return r === 0 ? P / n : (P * r) / (1 - Math.pow(1 + r, -n)); };
    const yen = (v) => `${(v / 10000).toFixed(1)}万円`;
    const update = () => {
      const loan = +$("#calc-loan").value, rate = +$("#calc-rate").value, years = +$("#calc-years").value;
      if (!(loan > 0 && years > 0)) return;
      const m = pmt(loan, rate, years);
      $("#calc-monthly").textContent = yen(m);
      $("#calc-total").textContent = `${Math.round((m * years * 12) / 10000).toLocaleString()}万円`;
      $("#calc-stress").textContent = `${yen(pmt(loan, 2.5, years))} ／ ${yen(pmt(loan, 3.5, years))}`;
    };
    ["#calc-loan", "#calc-rate", "#calc-years"].forEach((s) => $(s).addEventListener("input", update));
    update();
  }

  /* ---------- 最新レポート（簡易Markdown） ---------- */
  function md(src) {
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out = [];
    let list = false, table = false;
    const close = () => { if (list) out.push("</ul>"); if (table) out.push("</table>"); list = table = false; };
    src.split("\n").forEach((line) => {
      if (/^\|/.test(line)) {
        if (/^\|\s*:?-{2,}/.test(line)) return;
        if (!table) { close(); out.push("<table>"); table = true; }
        out.push("<tr>" + line.replace(/^\||\|$/g, "").split("|").map((c) => `<td>${inline(c.trim())}</td>`).join("") + "</tr>");
      } else if (/^\s*[-*] /.test(line)) {
        if (!list) { close(); out.push("<ul>"); list = true; }
        out.push(`<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`);
      } else if (/^#{1,4} /.test(line)) { close(); out.push(`<h3>${inline(line.replace(/^#+ /, ""))}</h3>`); }
      else if (line.trim()) { close(); out.push(`<p>${inline(line)}</p>`); }
      else close();
    });
    close();
    return out.join("");
  }
  async function loadReport() {
    try {
      const r = await fetch(`data/reports/latest.md?v=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw 0;
      const t = await r.text();
      $("#report").innerHTML = md(t);
      $("#report-link").href = "data/reports/latest.md";
    } catch { $("#report").textContent = "レポートはまだありません。"; $("#report-link").hidden = true; }
  }

  init();
})();
