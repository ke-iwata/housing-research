/* 江戸川ハウスウォッチ — 表示ロジック（データは data/*.json と data/reports/*.md、ビルド不要） */
(() => {
  "use strict";

  const STATUS_LABEL = { match: "条件合致", near: "惜しい", reference: "参考" };
  const STATUS_RANK = { match: 0, near: 1, reference: 2 };
  const GRADE_RANK = { "◎": 0, "○": 1, "△": 2 };
  const ZONE_LABEL = { first: "第一候補", second: "第二候補", reserve: "予備", other: "エリア外" };
  const ZONE_FULL = { first: "第一候補 · 篠崎街道沿い", second: "第二候補 · 鹿骨", reserve: "予備エリア", other: "エリア外" };
  const ZONE_ORDER = ["first", "second", "reserve", "other"];
  const LOAN = { rate: 1.3, years: 35 };
  const COLORS = { accent: "#087a58", accentPin: "#12a87a", near: "#ee9b1a", ref: "#b8c1bd", ink: "#14201c", muted: "#67736f", grid: "#eef1ee", blue: "#2f6fe4" };

  const state = { view: "map", filter: "match", onlyNew: false, sort: "price", q: "", sel: null, scope: "all", reportDate: null };
  let config = {}, data = {}, history = [], latest = null;
  let map, popup, pinLayer, zoneLayer, stationLayer, floodLayer, tideLayer;
  let mapReady = false, marketDrawn = false, reportDrawn = false;
  const charts = {};

  /* ---------- 小物 ---------- */
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => (v == null ? "—" : Number(v).toLocaleString("ja-JP"));
  const m2 = (v) => (v == null ? "不明" : `${Number(v).toFixed(2).replace(/\.?0+$/, "")}㎡`);
  const short = (addr) => String(addr || "").replace("東京都江戸川区", "");
  const mmdd = (s) => (s ? `${+s.slice(5, 7)}/${+s.slice(8, 10)}` : "—");
  const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const unit = (x) => (x.building_m2 ? x.price_man / x.building_m2 : null);
  const pmt = (loanMan, rate, years) => { const n = years * 12, r = rate / 100 / 12, P = loanMan * 10000; return r === 0 ? P / n : (P * r) / (1 - Math.pow(1 + r, -n)); };
  const monthly = (man) => (pmt(man, LOAN.rate, LOAN.years) / 10000).toFixed(1);
  const jpDate = (s) => { const [y, m, d] = s.split("-").map(Number); return `${m}月${d}日（${"日月火水木金土"[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`; };
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できない環境では何もしない */ } },
  };

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
  async function getText(path) {
    const r = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    return r.text();
  }

  const active = () => (data.listings || []).filter((x) => x.active !== false);
  const isFresh = (x) => x.first_seen === latest;
  const lastDrop = (x) => {
    const ph = x.price_history || [];
    if (ph.length < 2) return null;
    const a = ph[ph.length - 2], b = ph[ph.length - 1];
    return b.price_man < a.price_man ? { date: b.date, from: a.price_man, to: b.price_man } : null;
  };
  const byId = (id) => (data.listings || []).find((x) => x.id === id);

  /* ---------- 起動 ---------- */
  async function init() {
    [config, data, history] = await Promise.all([
      getJSON("data/config.json", {}),
      getJSON("data/listings.json", { listings: [], ended: [], land: [] }),
      getJSON("data/history.json", []),
    ]);
    latest = history.length ? history[history.length - 1].date : active().reduce((m, x) => (x.last_seen > m ? x.last_seen : m), "");
    renderHeadstats();
    bindMapControls();
    bindMarket();
    window.addEventListener("hashchange", route);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
    route();
  }

  function route() {
    const h = location.hash.replace("#", "") || "map";
    const view = ["map", "list", "market", "report"].includes(h) ? h : "map";
    state.view = view === "list" ? "map" : view;
    document.body.dataset.view = state.view;
    document.body.classList.toggle("sheet-open", view === "list");
    $$(".tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.view === state.view ? "page" : "false"));
    $$(".bottomnav a").forEach((a) => a.setAttribute("aria-current", a.dataset.view === view ? "page" : "false"));
    $("#view-map").hidden = state.view !== "map";
    $("#view-market").hidden = state.view !== "market";
    $("#view-report").hidden = state.view !== "report";
    if (state.view === "map") {
      if (!mapReady) initMap();
      else map.invalidateSize();
    }
    if (state.view === "market" && !marketDrawn) { renderMarket(); marketDrawn = true; }
    if (state.view === "report" && !reportDrawn) { renderReportShell(); reportDrawn = true; }
    if (state.view !== "map") window.scrollTo(0, 0);
  }

  function renderHeadstats() {
    const a = active();
    const t = data.updated_at ? new Date(data.updated_at) : null;
    const time = t ? t.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
    $("#headstats").innerHTML = `
      <span class="hs-match">条件合致<b>${a.filter((x) => x.status === "match").length}</b></span>
      <span class="hs-new">新着<b>${a.filter(isFresh).length}</b></span>
      <span class="hs-drop">値下げ<b>${a.filter((x) => { const d = lastDrop(x); return d && d.date === latest; }).length}</b></span>
      <span>掲載中<b>${a.length}</b></span>
      <span class="hs-time">${esc(time)} 更新</span>`;
  }

  /* ======================= 地図 ======================= */
  function filtered() {
    const q = state.q.trim().toLowerCase();
    return active().filter((x) =>
      (state.filter === "all" || x.status === state.filter) &&
      (!state.onlyNew || isFresh(x)) &&
      (!q || [x.address, x.town, x.access, x.bus, ZONE_LABEL[x.zone]].some((s) => String(s || "").toLowerCase().includes(q)))
    );
  }
  function sorted(rows) {
    const r = [...rows];
    const cmp = {
      price: (a, b) => a.price_man - b.price_man,
      area: (a, b) => (b.building_m2 || 0) - (a.building_m2 || 0),
      fresh: (a, b) => (b.first_seen > a.first_seen ? 1 : b.first_seen < a.first_seen ? -1 : 0) || a.price_man - b.price_man,
      grade: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (GRADE_RANK[a.grade] ?? 3) - (GRADE_RANK[b.grade] ?? 3) || a.price_man - b.price_man,
    }[state.sort];
    return r.sort(cmp);
  }

  function bindMapControls() {
    $("#q").addEventListener("input", (e) => { state.q = e.target.value; renderMapView(); });
    $("#only-new").addEventListener("click", (e) => { state.onlyNew = !state.onlyNew; e.currentTarget.setAttribute("aria-pressed", state.onlyNew); renderMapView(); });
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
    $("#drawer-close").addEventListener("click", closeDetail);
    $("#sheet-handle").addEventListener("click", () => { location.hash = document.body.classList.contains("sheet-open") ? "map" : "list"; });
    $("#list").addEventListener("click", (e) => {
      const b = e.target.closest(".item");
      if (!b) return;
      if (document.body.classList.contains("sheet-open")) location.hash = "map";
      select(b.dataset.id, { fly: true });
    });
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-open-detail]");
      if (b) openDetail(b.dataset.openDetail);
    });
  }

  function initMap() {
    mapReady = true;
    map = L.map("map", { zoomControl: false, attributionControl: true }).setView([35.698, 139.888], 14);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
      maxZoom: 18, className: "base-tiles",
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>',
    }).addTo(map);
    floodLayer = L.tileLayer("https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png", { opacity: 0.5, maxNativeZoom: 17, maxZoom: 18, attribution: "洪水浸水想定：ハザードマップポータル" });
    tideLayer = L.tileLayer("https://disaportaldata.gsi.go.jp/raster/03_hightide_l2_shinsuishin_data/{z}/{x}/{y}.png", { opacity: 0.5, maxNativeZoom: 17, maxZoom: 18, attribution: "高潮浸水想定：ハザードマップポータル" });
    zoneLayer = L.layerGroup().addTo(map);
    stationLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    popup = L.popup({ className: "card-pop", offset: [0, -34], maxWidth: 300, minWidth: 290, autoPanPadding: [24, 24] });

    const zoneStyle = { first: [COLORS.accentPin, 0.12, 480], second: [COLORS.near, 0.12, 480], reserve: [COLORS.muted, 0.07, 380] };
    (config.zones || []).forEach((z) => {
      const [color, op, radius] = zoneStyle[z.id] || zoneStyle.reserve;
      z.towns.forEach((t) =>
        L.circle([t.lat, t.lng], { radius, stroke: false, fillColor: color, fillOpacity: op, interactive: true })
          .bindTooltip(`<b>${esc(t.name)}</b>　${esc(z.label)}`, { sticky: true })
          .addTo(zoneLayer)
      );
    });
    (config.stations || []).forEach((s) =>
      L.marker([s.lat, s.lng], { interactive: false, keyboard: false, icon: L.divIcon({ className: "station-icon", html: `<div class="station"><i></i><span>${esc(s.name)}</span></div>`, iconSize: [0, 0] }) }).addTo(stationLayer)
    );

    const toggle = (id, layer) => $(id).addEventListener("change", (e) => {
      e.target.checked ? layer.addTo(map) : map.removeLayer(layer);
      $("#hazard-note").hidden = !($("#lyr-flood").checked || $("#lyr-tide").checked);
    });
    toggle("#lyr-zones", zoneLayer);
    toggle("#lyr-stations", stationLayer);
    toggle("#lyr-flood", floodLayer);
    toggle("#lyr-tide", tideLayer);

    const pts = [];
    (config.zones || []).forEach((z) => z.towns.forEach((t) => pts.push([t.lat, t.lng])));
    active().filter((x) => x.lat != null && x.status === "match").forEach((x) => pts.push([x.lat, x.lng]));
    const mobile = window.matchMedia("(max-width: 860px)").matches;
    if (mobile) $("#layers").open = false;
    if (pts.length) {
      const h = $("#map").clientHeight;
      map.fitBounds(L.latLngBounds(pts), mobile
        ? { paddingTopLeft: [16, 60], paddingBottomRight: [16, Math.round(h * 0.44) + 16] }
        : { paddingTopLeft: [24, 24], paddingBottomRight: [240, 24] });
    }
    map.on("zoomend", declutter);

    renderMapView();
  }

  function renderMapView() {
    renderStatusTabs();
    renderList();
    if (mapReady) renderPins();
  }

  function renderStatusTabs() {
    const a = active().filter((x) => !state.onlyNew || isFresh(x));
    const n = (s) => a.filter((x) => x.status === s).length;
    const tabs = [["match", "合致", n("match")], ["near", "惜しい", n("near")], ["reference", "参考", n("reference")], ["all", "すべて", a.length]];
    $("#status-tabs").innerHTML = tabs.map(([k, l, c]) => `<button type="button" data-f="${k}" aria-pressed="${state.filter === k}">${l}<span class="n">${c}</span></button>`).join("");
    $$("#status-tabs button").forEach((b) => b.addEventListener("click", () => { state.filter = b.dataset.f; renderMapView(); }));
  }

  function tileHtml(x) {
    const [main, ...rest] = String(x.layout || "—").split("+");
    return `<span class="tile ${x.status}"><b>${esc(main)}</b>${rest.length ? `<em>+${esc(rest.join("+"))}</em>` : ""}<span>${x.building_m2 ? Math.round(x.building_m2) + "㎡" : "—"}</span></span>`;
  }

  function renderList() {
    const rows = sorted(filtered());
    const med = median(rows.map((x) => x.price_man));
    $("#list-count").textContent = `${rows.length}件`;
    $("#list-median").innerHTML = med == null ? "" : `価格の中央値 <b>${num(Math.round(med))}万円</b>`;
    $("#list").innerHTML = rows.length ? rows.map((x) => {
      const drop = lastDrop(x);
      const tag = isFresh(x) ? '<span class="tag">NEW</span>' : x.grade === "◎" ? '<span class="tag g">◎</span>' : "";
      return `<button type="button" class="item" role="listitem" data-id="${esc(x.id)}" aria-current="${x.id === state.sel}">
        ${tileHtml(x)}
        <span class="item-body">
          <span class="item-top"><span class="item-name">${esc(short(x.address))}${tag}</span><span class="item-price">${num(x.price_man)}<small>万円</small></span></span>
          <span class="item-line">${esc(x.layout)} · 延床${m2(x.building_m2)} · 土地${m2(x.land_m2)} · 駐車${esc(String(x.parking || "不明").split("（")[0])}</span>
          <span class="item-line sub">${drop ? `<span class="pchg">${mmdd(drop.date)} 値下げ ${num(drop.from)}→${num(drop.to)}</span> · ` : ""}${esc(String(x.access || "").split("／")[0])} · ${ZONE_LABEL[x.zone]}</span>
        </span></button>`;
    }).join("") : `<p class="empty">条件に合う物件はありません</p>`;
  }

  function pinHtml(x) {
    const cls = [x.status, x.grade === "◎" ? "best" : "", x.id === state.sel ? "sel" : ""].join(" ");
    return `<button type="button" class="pin ${cls}" aria-label="${esc(short(x.address))} ${num(x.price_man)}万円">${num(x.price_man)}${x.grade === "◎" ? " ◎" : ""}</button>`;
  }

  let pinMarkers = [];
  function renderPins() {
    pinLayer.clearLayers();
    const rows = filtered();
    const sel = state.sel && byId(state.sel);
    if (sel && !rows.includes(sel)) rows.push(sel);
    pinMarkers = rows.filter((x) => x.lat != null).map((x) => {
      const z = x.id === state.sel ? 1000 : { match: 300, near: 200, reference: 100 }[x.status];
      const marker = L.marker([x.lat, x.lng], { keyboard: false, zIndexOffset: z, riseOnHover: true, icon: L.divIcon({ className: "pin-icon", html: pinHtml(x), iconSize: [0, 0] }) })
        .on("click", () => select(x.id, { scroll: true }))
        .addTo(pinLayer);
      return { x, marker };
    });
    declutter();
  }

  // 近い物件の価格ラベルが重ならないよう、優先度の低いものから上にずらす（線で元の位置とつなぐ）
  function declutter() {
    const placed = [];
    const hit = (r) => placed.some((q) => r.x1 < q.x2 && q.x1 < r.x2 && r.y1 < q.y2 && q.y1 < r.y2);
    [...pinMarkers]
      .sort((a, b) => (b.x.id === state.sel) - (a.x.id === state.sel) || STATUS_RANK[a.x.status] - STATUS_RANK[b.x.status] || a.x.price_man - b.x.price_man)
      .forEach(({ x, marker }) => {
        const el = marker.getElement() && marker.getElement().querySelector(".pin");
        if (!el) return;
        const p = map.latLngToLayerPoint([x.lat, x.lng]);
        const w = el.offsetWidth || 60;
        const rect = (lift) => ({ x1: p.x - w / 2 - 2, x2: p.x + w / 2 + 2, y1: p.y - 35 - lift, y2: p.y - 5 - lift });
        let lift = 0;
        while (lift < 28 * 6 && hit(rect(lift))) lift += 28;
        placed.push(rect(lift));
        el.style.setProperty("--lift", `${lift}px`);
        el.classList.toggle("lifted", lift > 0);
      });
  }

  function popupHtml(x) {
    const badge = x.status === "match" ? `<span class="badge match">条件合致 ${esc(x.grade || "")}</span>` : `<span class="badge ${x.status === "near" ? "near" : ""}">${STATUS_LABEL[x.status]}</span>`;
    return `<div class="pop">
      <div class="pop-badges">${badge}${isFresh(x) ? '<span class="badge new">NEW</span>' : ""}<span class="badge">${ZONE_LABEL[x.zone]}</span></div>
      <span class="pop-where">${esc(short(x.address))} · ${esc(x.completion || "完成時期 要確認")}</span>
      <span class="price">${num(x.price_man)}<small>万円</small></span>
      <span class="pop-line">${esc(x.layout)} · 延床${m2(x.building_m2)} · 土地${m2(x.land_m2)}</span>
      <span class="pop-where">${esc(String(x.access || "").split("／")[0])}</span>
      <div class="pop-actions"><button type="button" class="btn primary grow" data-open-detail="${esc(x.id)}">詳細を見る</button></div>
    </div>`;
  }

  function select(id, opts = {}) {
    const x = byId(id);
    if (!x) return;
    state.sel = id;
    $$("#list .item").forEach((b) => b.setAttribute("aria-current", b.dataset.id === id));
    if (opts.scroll) { const el = $(`#list .item[data-id="${CSS.escape(id)}"]`); if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
    if (!mapReady || x.lat == null) return;
    renderPins();
    if (opts.fly) {
      // スマホは下半分を一覧シートが覆うので、物件が見える位置（上寄り）に中心をずらす
      const zoom = Math.max(map.getZoom(), 15);
      const shift = window.matchMedia("(max-width: 860px)").matches ? $("#map").clientHeight * 0.22 : 0;
      map.flyTo(map.unproject(map.project([x.lat, x.lng], zoom).add([0, shift]), zoom), zoom, { duration: 0.6 });
    }
    popup.setLatLng([x.lat, x.lng]).setContent(popupHtml(x)).openOn(map);
    if (!$("#drawer").hidden) openDetail(id);
  }

  /* ---------- 詳細パネル ---------- */
  const CHECKS = ["駐車場の台数・車種制限", "浸水深（区ハザードマップ第2版）", "最寄りバス停の朝7〜8時台の本数", "掲載元ごとの価格差", "日当たり・前面道路"];

  function openDetail(id) {
    const x = byId(id);
    if (!x) return;
    state.sel = id;
    const checked = store.get(`hw-check:${id}`, []);
    const badge = x.status === "match" ? `<span class="badge match">条件合致 ${esc(x.grade || "")}</span>` : `<span class="badge ${x.status === "near" ? "near" : ""}">${STATUS_LABEL[x.status]}</span>`;
    const ph = x.price_history || [];
    $("#drawer-body").innerHTML = `
      <div class="d-sec">
        <div class="pop-badges">${badge}<span class="badge">${ZONE_FULL[x.zone]}</span><span class="badge">初掲載 ${mmdd(x.first_seen)}</span>${isFresh(x) ? '<span class="badge new">NEW</span>' : ""}</div>
        <h2 class="d-title">${esc(x.address.replace("東京都", ""))}</h2>
        <span class="d-price">${num(x.price_man)}<small>万円</small></span>
        <span class="d-monthly">月々の目安 <b>${monthly(x.price_man)}万円</b>（全額借入・金利${LOAN.rate}%・${LOAN.years}年）</span>
      </div>
      <div class="d-sec">
        <div class="d-specs">
          <div><span>間取り</span><b>${esc(x.layout)}</b></div>
          <div><span>延床</span><b>${m2(x.building_m2)}</b></div>
          <div><span>土地</span><b>${m2(x.land_m2)}</b></div>
        </div>
        <dl class="d-dl">
          <dt>駐車場</dt><dd>${esc(x.parking || "不明")}</dd>
          <dt>交通</dt><dd>${esc(x.access || "—")}</dd>
          <dt>バス</dt><dd>${esc(x.bus || "記載なし（要確認）")}</dd>
          <dt>完成</dt><dd>${esc(x.completion || "要確認")}</dd>
        </dl>
      </div>
      ${x.note ? `<div class="d-sec"><h3>メモ</h3><p class="d-note">${esc(x.note)}</p></div>` : ""}
      <div class="d-sec"><h3>価格の推移</h3><div class="phist">${ph.map((p, i) => `<div><span>${mmdd(p.date)} ${i === 0 ? "初掲載" : p.price_man < ph[i - 1].price_man ? "値下げ" : "価格変更"}</span><b>${num(p.price_man)}万円</b></div>`).join("")}</div></div>
      <div class="d-sec checks"><h3>見学前に確認</h3>${CHECKS.map((c, i) => `<label><input type="checkbox" data-check="${i}" ${checked.includes(i) ? "checked" : ""}>${esc(c)}</label>`).join("")}</div>
      <div class="d-sec"><h3>掲載元</h3><div class="srcs">${(x.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.site)}<span>開く ↗</span></a>`).join("")}</div></div>`;
    $$("#drawer-body [data-check]").forEach((cb) => cb.addEventListener("change", () => {
      store.set(`hw-check:${id}`, $$("#drawer-body [data-check]").filter((c) => c.checked).map((c) => +c.dataset.check));
    }));
    $("#drawer").hidden = false;
    $("#drawer-body").scrollTop = 0;
    if (mapReady) map.closePopup();
    $$("#list .item").forEach((b) => b.setAttribute("aria-current", b.dataset.id === id));
    $("#drawer-close").focus({ preventScroll: true });
  }
  function closeDetail() {
    if ($("#drawer").hidden) return;
    $("#drawer").hidden = true;
    const x = state.sel && byId(state.sel);
    if (x && mapReady && x.lat != null) popup.setLatLng([x.lat, x.lng]).setContent(popupHtml(x)).openOn(map);
  }

  /* ======================= 相場 ======================= */
  function bindMarket() {
    $$("#market-scope button").forEach((b) => b.addEventListener("click", () => {
      state.scope = b.dataset.scope;
      $$("#market-scope button").forEach((q) => q.setAttribute("aria-pressed", q === b));
      renderMarket();
    }));
    const update = () => {
      const loan = +$("#calc-loan").value, rate = +$("#calc-rate").value, years = +$("#calc-years").value;
      if (!(loan > 0 && years > 0)) return;
      const m = pmt(loan, rate, years);
      $("#calc-monthly").textContent = `${(m / 10000).toFixed(1)}万円`;
      $("#calc-total").textContent = `${num(Math.round((m * years * 12) / 10000))}万円`;
      $("#calc-stress").textContent = `${(pmt(loan, 2.5, years) / 10000).toFixed(1)}万円 ／ ${(pmt(loan, 3.5, years) / 10000).toFixed(1)}万円`;
    };
    ["#calc-loan", "#calc-rate", "#calc-years"].forEach((s) => $(s).addEventListener("input", update));
    update();
  }

  const scoped = () => active().filter((x) => state.scope === "all" || x.status === "match");

  function renderMarket() {
    renderKpis();
    renderScatter();
    renderZoneBars();
    renderHisto();
    renderTownBars();
    renderHistory();
    renderSourceBars();
  }

  function deltaBadge(cur, prev, { unitLabel = "", digits = 0, upIsGood = true } = {}) {
    if (prev == null || cur == null) return "";
    const d = +(cur - prev).toFixed(digits);
    if (d === 0) return `<span class="badge">前日と同じ</span>`;
    const good = d > 0 === upIsGood;
    const fmt = (v) => (digits ? v.toFixed(digits) : num(v));
    return `<span class="badge ${good ? "match-soft" : "near"}">前日 ${fmt(prev)}${unitLabel}から ${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}${unitLabel}</span>`;
  }

  function renderKpis() {
    const a = active();
    const match = a.filter((x) => x.status === "match");
    const prev = history.length > 1 ? history[history.length - 2] : null;
    const medMatch = median(match.map((x) => x.price_man));
    const medUnit = median(a.map(unit).filter((v) => v != null));
    const cnt = (s) => a.filter((x) => x.status === s).length;
    $("#kpis").innerHTML = [
      { label: "条件合致の価格（中央値）", value: medMatch == null ? "—" : num(Math.round(medMatch)), unit: "万円", badge: deltaBadge(medMatch && Math.round(medMatch), prev && prev.median_price_match && Math.round(prev.median_price_match), { unitLabel: "万円", upIsGood: false }) },
      { label: "㎡単価（全物件の中央値）", value: medUnit == null ? "—" : medUnit.toFixed(1), unit: "万円/㎡", badge: deltaBadge(medUnit, prev && prev.median_unit_price, { digits: 1, upIsGood: false }) },
      { label: "条件合致", value: match.length, unit: "件", badge: deltaBadge(match.length, prev && prev.match, { unitLabel: "件" }) },
      { label: "掲載中", value: a.length, unit: "件", badge: `<span class="badge">合致${cnt("match")} · 惜しい${cnt("near")} · 参考${cnt("reference")}</span>` },
    ].map((k) => `<div class="kpi"><span class="kpi-label">${k.label}</span><span class="kpi-value">${k.value}<small>${k.unit}</small></span>${k.badge}</div>`).join("");
  }

  const zonePlugin = {
    id: "zones",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x, y } } = chart;
      const c = config.criteria || {};
      const [lo, hi] = c.price_comfort_man || [6000, 7000];
      const max = c.price_max_man || 7500, minA = c.building_min_m2 || 110, idealA = c.building_ideal_m2 || 120;
      const clampX = (v) => Math.min(Math.max(v, a.left), a.right), clampY = (v) => Math.min(Math.max(v, a.top), a.bottom);
      ctx.save();
      ctx.fillStyle = "rgba(8,122,88,.06)";
      const rx = clampX(x.getPixelForValue(minA)), ry = clampY(y.getPixelForValue(max));
      ctx.fillRect(rx, ry, a.right - rx, a.bottom - ry);
      ctx.fillStyle = "rgba(47,111,228,.07)";
      const by1 = clampY(y.getPixelForValue(hi)), by2 = clampY(y.getPixelForValue(lo));
      ctx.fillRect(a.left, by1, a.right - a.left, by2 - by1);
      ctx.lineWidth = 1.2;
      ctx.font = `11px ${Chart.defaults.font.family}`;
      const line = (x1, y1, x2, y2, color, dash) => { ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
      const py = y.getPixelForValue(max);
      if (py >= a.top && py <= a.bottom) { line(a.left, py, a.right, py, "#9c5a00", [5, 4]); ctx.fillStyle = "#9c5a00"; ctx.fillText(`上限 ${num(max)}万円`, a.left + 6, py - 5); }
      [[minA, [5, 4]], [idealA, [2, 4]]].forEach(([v, dash]) => { const px = x.getPixelForValue(v); if (px >= a.left && px <= a.right) { line(px, a.top, px, a.bottom, COLORS.accent, dash); ctx.fillStyle = COLORS.accent; ctx.fillText(`${v}㎡`, px + 4, a.top + 12); } });
      ctx.restore();
    },
  };

  function chartDefaults() {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = COLORS.muted;
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, boxHeight: 8, color: "#3e4a46" } },
        tooltip: { backgroundColor: "#ffffff", titleColor: COLORS.ink, bodyColor: "#3e4a46", borderColor: "#d8ddd9", borderWidth: 1, padding: 10, cornerRadius: 10, usePointStyle: true, boxPadding: 4 },
      },
      scales: {
        x: { grid: { color: COLORS.grid, drawTicks: false }, border: { display: false }, ticks: { padding: 6 } },
        y: { grid: { color: COLORS.grid, drawTicks: false }, border: { display: false }, ticks: { padding: 6 } },
      },
    };
  }

  function renderScatter() {
    if (charts.scatter) charts.scatter.destroy();
    const o = chartDefaults();
    const rows = scoped().filter((x) => x.building_m2 != null);
    const pt = (x) => ({ x: x.building_m2, y: x.price_man, item: x });
    const ds = [
      { label: "参考", data: rows.filter((x) => x.status === "reference").map(pt), backgroundColor: COLORS.ref, pointRadius: 5.5 },
      { label: "惜しい", data: rows.filter((x) => x.status === "near").map(pt), backgroundColor: COLORS.near, pointRadius: 6 },
      { label: "条件合致", data: rows.filter((x) => x.status === "match" && x.grade !== "◎").map(pt), backgroundColor: COLORS.accent, pointRadius: 6.5 },
      { label: "◎", data: rows.filter((x) => x.grade === "◎").map(pt), backgroundColor: "#ffffff", borderColor: COLORS.accent, borderWidth: 3, pointRadius: 8 },
    ].filter((d) => d.data.length).map((d) => ({ borderColor: "#ffffff", borderWidth: 1.5, pointHoverRadius: 9, pointHitRadius: 12, ...d }));
    charts.scatter = new Chart($("#chart-scatter"), {
      type: "scatter",
      data: { datasets: ds },
      options: {
        ...o,
        interaction: { mode: "nearest", intersect: true },
        onClick: (e, els) => { if (!els[0]) return; const it = els[0].element.$context.raw.item; location.hash = "map"; setTimeout(() => select(it.id, { fly: true, scroll: true }), 60); },
        onHover: (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; },
        plugins: {
          ...o.plugins,
          tooltip: { ...o.plugins.tooltip, callbacks: {
            title: (it) => short(it[0].raw.item.address),
            label: (it) => `${num(it.raw.y)}万円 · 延床${m2(it.raw.x)} · ${it.raw.item.layout}`,
            afterLabel: (it) => it.raw.item.access || "",
          } },
        },
        scales: {
          x: { ...o.scales.x, title: { display: true, text: "延床面積（㎡）" }, suggestedMin: 95, suggestedMax: 140 },
          y: { ...o.scales.y, title: { display: true, text: "価格（万円）" }, suggestedMin: 5000, suggestedMax: 9500, ticks: { ...o.scales.y.ticks, callback: (v) => num(v) } },
        },
      },
      plugins: [zonePlugin],
    });
  }

  function renderZoneBars() {
    const rows = scoped();
    const maxN = Math.max(1, ...ZONE_ORDER.map((z) => rows.filter((x) => x.zone === z).length));
    const zoneUnit = {};
    $("#zone-bars").innerHTML = ZONE_ORDER.map((z) => {
      const g = rows.filter((x) => x.zone === z);
      const u = median(g.map(unit).filter((v) => v != null));
      zoneUnit[z] = u;
      const seg = ["match", "near", "reference"].map((s) => { const n = g.filter((x) => x.status === s).length; return n ? `<i class="s-${s}" style="width:${(n / g.length) * 100}%" title="${STATUS_LABEL[s]} ${n}件"></i>` : ""; }).join("");
      return `<div><div class="zb-head"><b>${ZONE_FULL[z]}</b><span>${g.length}件${u ? ` · ${u.toFixed(1)}万/㎡` : ""}</span></div>
        <div class="stack" style="width:${Math.max(6, (g.length / maxN) * 100)}%">${seg}</div></div>`;
    }).join("");
    const cand = ["first", "second", "reserve"].map((z) => zoneUnit[z]).filter((v) => v != null);
    const other = zoneUnit.other;
    $("#zone-callout").textContent = cand.length && other && Math.max(...cand) < other
      ? `候補エリアの㎡単価は${Math.min(...cand).toFixed(1)}〜${Math.max(...cand).toFixed(1)}万円で、エリア外（${other.toFixed(1)}万円）より${Math.round((1 - median(cand) / other) * 100)}%ほど安い水準です。`
      : "";
  }

  function renderHisto() {
    const c = config.criteria || {};
    const comfort = (c.price_comfort_man || [6000, 7000])[1], max = c.price_max_man || 7500;
    const prices = active().filter((x) => x.status !== "reference").map((x) => x.price_man);
    if (!prices.length) { $("#histo").innerHTML = `<p class="empty">データがありません</p>`; return; }
    const lo = Math.floor(Math.min(...prices) / 500) * 500, hi = Math.floor(Math.max(...prices) / 500) * 500;
    const bins = [];
    for (let b = lo; b <= hi; b += 500) bins.push({ b, n: prices.filter((p) => p >= b && p < b + 500).length });
    const top = Math.max(...bins.map((x) => x.n));
    $("#histo").innerHTML = bins.map(({ b, n }) => {
      const cls = b + 500 <= comfort ? "" : b + 500 <= max ? "mid" : "over";
      return `<div>${n}<i class="${cls}" style="height:${(n / top) * 80}%"></i><span>${num(b)}〜</span></div>`;
    }).join("");
  }

  function renderTownBars() {
    const rows = scoped();
    const towns = {};
    rows.forEach((x) => { const u = unit(x); if (u != null) (towns[x.town] = towns[x.town] || []).push(u); });
    const list = Object.entries(towns).filter(([, v]) => v.length >= 2).map(([t, v]) => ({ t, u: median(v), n: v.length })).sort((a, b) => a.u - b.u);
    if (!list.length) { $("#town-bars").innerHTML = `<p class="empty" style="grid-column:1/-1">2件以上掲載の町はまだありません</p>`; return; }
    const all = median(rows.map(unit).filter((v) => v != null));
    const lo = Math.floor(Math.min(...list.map((x) => x.u)) - 3), hi = Math.ceil(Math.max(...list.map((x) => x.u)) + 1);
    $("#town-bars").innerHTML = list.map((x) => `<span class="lbl">${esc(x.t)}</span><span class="bar"><i class="${x.u > all ? "hi" : ""}" style="width:${((x.u - lo) / (hi - lo)) * 100}%"></i></span><span class="v">${x.u.toFixed(1)}</span><span class="c">${x.n}件</span>`).join("");
  }

  function renderHistory() {
    if (charts.history) charts.history.destroy();
    const o = chartDefaults();
    const h = history.slice(-120);
    $("#history-sub").textContent = `記録${history.length}日分`;
    const line = (label, key, color, axis, dash) => ({ label, data: h.map((r) => r[key]), yAxisID: axis, borderColor: color, backgroundColor: color, borderWidth: 2.5, borderDash: dash || [], tension: 0.25, pointRadius: h.length > 30 ? 0 : 4, pointHoverRadius: 6, pointBorderColor: "#fff", pointBorderWidth: 2, spanGaps: true });
    charts.history = new Chart($("#chart-history"), {
      type: "line",
      data: { labels: h.map((r) => mmdd(r.date)), datasets: [line("掲載中", "total", COLORS.ink, "y"), line("条件合致", "match", COLORS.accent, "y"), line("㎡単価（右軸）", "median_unit_price", COLORS.blue, "y2", [5, 4])] },
      options: {
        ...o,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { ...o.scales.x, grid: { display: false } },
          y: { ...o.scales.y, beginAtZero: true, ticks: { ...o.scales.y.ticks, precision: 0 }, title: { display: true, text: "件数" } },
          y2: { ...o.scales.y, position: "right", grid: { display: false }, title: { display: true, text: "万円/㎡" } },
        },
      },
    });
  }

  function renderSourceBars() {
    const cnt = {};
    scoped().forEach((x) => (x.sources || []).forEach((s) => (cnt[s.site] = (cnt[s.site] || 0) + 1)));
    const list = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
    const top = Math.max(1, ...list.map((x) => x[1]));
    $("#source-bars").innerHTML = list.map(([k, n]) => `<span class="lbl">${esc(k)}</span><span class="bar"><i style="width:${(n / top) * 100}%"></i></span><span class="v">${n}</span>`).join("");
  }

  /* ======================= レポート ======================= */
  function renderReportShell() {
    const dates = history.map((h) => h.date).reverse();
    if (!dates.length && latest) dates.push(latest);
    state.reportDate = dates[0] || null;
    const hmap = Object.fromEntries(history.map((h) => [h.date, h]));
    $("#backnumbers").innerHTML = dates.map((d) => {
      const h = hmap[d];
      return `<button type="button" data-date="${d}" aria-current="${d === state.reportDate}"><b>${jpDate(d)}</b><span>${h ? `合致${h.match} · 新着${h.new} · 掲載${h.total}` : ""}</span></button>`;
    }).join("") || `<span class="r-empty">まだありません</span>`;
    $$("#backnumbers button").forEach((b) => b.addEventListener("click", () => {
      state.reportDate = b.dataset.date;
      $$("#backnumbers button").forEach((q) => q.setAttribute("aria-current", q === b));
      loadReport();
    }));
    const lbl = { ok: "OK", failed: "取得失敗", not_checked: "未確認" };
    $("#source-status").innerHTML = Object.entries(data.source_status || {}).map(([k, v]) => `<li><span>${esc(k)}</span><span class="${esc(v)}">${lbl[v] || esc(v)}</span></li>`).join("") || "<li>—</li>";
    $("#links").innerHTML = (config.links || []).map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a></li>`).join("");
    loadReport();
  }

  async function loadReport() {
    const d = state.reportDate;
    const main = $("#report-main");
    let text = null;
    try { text = await getText(d ? `data/reports/${d}.md` : "data/reports/latest.md"); }
    catch { try { if (d === latest) text = await getText("data/reports/latest.md"); } catch { /* なし */ } }
    const h = history.find((r) => r.date === d);
    const endedN = (data.ended || []).filter((x) => x.ended_on === d).length;
    const dropN = active().filter((x) => (x.price_history || []).some((p, i, a) => i > 0 && p.date === d && p.price_man < a[i - 1].price_man)).length;
    const kpis = h ? `<div class="kpis r-kpis">
      <div class="kpi hero"><span class="kpi-label">条件合致</span><span class="kpi-value">${h.match}<small>件</small></span></div>
      <div class="kpi"><span class="kpi-label">新着</span><span class="kpi-value">${h.new}<small>件</small></span></div>
      <div class="kpi"><span class="kpi-label">値下げ</span><span class="kpi-value">${dropN}<small>件</small></span></div>
      <div class="kpi"><span class="kpi-label">掲載終了</span><span class="kpi-value">${endedN}<small>件</small></span></div></div>` : "";
    main.innerHTML = `<div><span class="r-eyebrow">DAILY REPORT</span><h1 class="r-title">${d ? `${jpDate(d)}の日次レポート` : "日次レポート"}</h1></div>${kpis}${text ? mdSections(text) : `<section class="r-sec"><p class="r-empty">この日のレポートはありません。</p></section>`}`;
  }

  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function mdBlock(lines) {
    const out = [];
    let list = null, table = null;
    const flush = () => {
      if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; }
      if (table) {
        const [head, ...body] = table;
        const cell = (c) => {
          const m = c.replace(/\*\*/g, "").trim().match(/^(match|near|reference)\s*([◎○△])?$/);
          if (!m) return `<td>${inline(c)}</td>`;
          const cls = m[1] === "match" ? "match" : m[1] === "near" ? "near" : "";
          return `<td><span class="badge ${cls}">${STATUS_LABEL[m[1]]}${m[2] ? " " + m[2] : ""}</span></td>`;
        };
        out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map(cell).join("")}</tr>`).join("")}</tbody></table></div>`);
        table = null;
      }
    };
    lines.forEach((line) => {
      if (/^\s*\|/.test(line)) {
        if (/^\s*\|\s*:?-{2,}/.test(line)) return;
        if (list) flush();
        (table = table || []).push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        if (table) flush();
        const tag = /^\s*\d+\./.test(line) ? "ol" : "ul";
        if (list && list.tag !== tag) flush();
        list = list || { tag, items: [] };
        list.items.push(line.replace(/^\s*([-*]|\d+\.)\s+/, ""));
      } else if (/^#{3,4}\s/.test(line)) { flush(); out.push(`<h3>${inline(line.replace(/^#+\s/, ""))}</h3>`); }
      else if (line.trim()) { flush(); out.push(`<p>${inline(line)}</p>`); }
      else flush();
    });
    flush();
    return out.join("");
  }

  function mdSections(src) {
    const secs = [];
    let cur = { title: null, lines: [] };
    src.split("\n").forEach((line) => {
      if (/^#\s/.test(line)) return;
      if (/^##\s/.test(line)) { secs.push(cur); cur = { title: line.replace(/^##\s/, "").trim(), lines: [] }; }
      else cur.lines.push(line);
    });
    secs.push(cur);
    // 見出しより前の行（「条件合致 N件／…」の要約）は上の数字カードと重複するので出さない
    return secs.filter((s) => s.title).map((s) => {
      const warn = s.title && /注意/.test(s.title);
      return `<section class="r-sec${warn ? " warn" : ""}">${s.title ? `<h2>${inline(s.title)}</h2>` : ""}${mdBlock(s.lines)}</section>`;
    }).join("");
  }

  init();
})();
