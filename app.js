// ガソリン代ルート比較アプリ（MVP＋UI/UX改善）
// 地名検索：Nominatim、ルート検索：OSRM、地図表示：Leaflet

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const NOMINATIM_INTERVAL_MS = 1100; // Nominatim の利用ルール（1秒に1回まで）を守るための間隔
const AUTOCOMPLETE_DEBOUNCE_MS = 700; // 入力が止まってから候補を取得するまでの待ち時間
const AUTOCOMPLETE_MIN_LENGTH = 3; // これより短い入力では候補を取得しない
const ROUTE_COLORS = ["#1f6feb", "#8250df", "#2da44e"];
const CHEAPEST_COLOR = "#e36209";

const form = document.getElementById("input-form");
const calcButton = document.getElementById("calc-button");
const bannerEl = document.getElementById("banner");
const hintEl = document.getElementById("hint");
const candidatesSection = document.getElementById("candidates");
const resultSection = document.getElementById("result");
const mapOverlay = document.getElementById("map-overlay");
const mapOverlayText = document.getElementById("map-overlay-text");

const FIELDS = [
  { id: "origin", test: (v) => v.trim().length > 0, message: "出発地を入力してください。" },
  { id: "destination", test: (v) => v.trim().length > 0, message: "目的地を入力してください。" },
  { id: "efficiency", test: (v) => parseFloat(v) > 0, message: "燃費は0より大きい数値を入力してください。" },
  { id: "price", test: (v) => parseFloat(v) > 0, message: "単価は0より大きい数値を入力してください。" },
];

// 地図の初期表示（日本全体）
const map = L.map("map").setView([36.5, 138], 5);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);

// 今回の計算条件と、選ばれた地点
let current = null;
// 自動補完で選ばれた地点（入力欄の文字列がこれと一致する間だけ有効）
let selectedPlaces = { origin: null, destination: null };
// 描画中のルート（カードをタップして地図上で強調するために保持）
let activeRoutes = [];

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = readInput();
  if (!input) return;

  current = {
    ...input,
    originPlace: matchesSelected("origin", input.origin) ? selectedPlaces.origin : null,
    destinationPlace: matchesSelected("destination", input.destination) ? selectedPlaces.destination : null,
  };
  hideCandidates();
  resultSection.hidden = true;
  routeLayer.clearLayers();
  hideBanner();
  hideHint();
  setBusy(true);

  try {
    let originList, destinationList;

    if (current.originPlace) {
      originList = [current.originPlace];
    } else {
      showLoading("地名を検索しています…");
      originList = await throttledGeocode(input.origin);
    }

    if (current.destinationPlace) {
      destinationList = [current.destinationPlace];
    } else {
      showLoading("地名を検索しています…");
      destinationList = await throttledGeocode(input.destination);
    }

    if (originList.length === 0) throw new UserError(`出発地「${input.origin}」が見つかりませんでした。`);
    if (destinationList.length === 0) throw new UserError(`目的地「${input.destination}」が見つかりませんでした。`);

    if (originList.length === 1) current.originPlace = originList[0];
    if (destinationList.length === 1) current.destinationPlace = destinationList[0];

    if (current.originPlace && current.destinationPlace) {
      await calculate();
    } else {
      showCandidates(originList, destinationList);
      showHint("候補が複数あります。下の一覧から選んでください。");
      hideLoading();
      setBusy(false);
    }
  } catch (err) {
    handleError(err);
  }
});

// 入力チェック。問題なければ入力値を返し、問題があれば該当欄を赤枠にして知らせる
function readInput() {
  let firstInvalid = null;

  FIELDS.forEach(({ id, test, message }) => {
    const el = document.getElementById(id);
    const errorEl = document.getElementById(`${id}-error`);
    const ok = test(el.value);
    el.classList.toggle("invalid", !ok);
    if (errorEl) {
      errorEl.textContent = ok ? "" : message;
      errorEl.hidden = ok;
    }
    if (!ok && !firstInvalid) firstInvalid = el;
  });

  if (firstInvalid) {
    firstInvalid.focus();
    return null;
  }

  return {
    origin: document.getElementById("origin").value.trim(),
    destination: document.getElementById("destination").value.trim(),
    efficiency: parseFloat(document.getElementById("efficiency").value),
    price: parseFloat(document.getElementById("price").value),
  };
}

function clearFieldError(id) {
  const el = document.getElementById(id);
  const errorEl = document.getElementById(`${id}-error`);
  el.classList.remove("invalid");
  if (errorEl) errorEl.hidden = true;
}

FIELDS.forEach(({ id }) => {
  document.getElementById(id).addEventListener("input", () => clearFieldError(id));
});

// 地名 → 緯度経度の候補一覧（Nominatim の利用ルールを守るため、呼び出し元は throttledGeocode を使う）
async function geocode(query) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "5",
    countrycodes: "jp",
    "accept-language": "ja",
  });
  const res = await fetch(`${NOMINATIM_URL}?${params}`);
  if (!res.ok) throw new ServiceError("地名検索");
  const data = await res.json();
  return data.map((p) => ({ name: p.display_name, lat: parseFloat(p.lat), lon: parseFloat(p.lon) }));
}

// geocode を「前回の問い合わせから1.1秒以上あける」形で直列に実行するためのキュー
let geocodeQueue = Promise.resolve();
let lastGeocodeAt = 0;
function throttledGeocode(query) {
  const result = geocodeQueue.then(async () => {
    const waitMs = Math.max(0, lastGeocodeAt + NOMINATIM_INTERVAL_MS - Date.now());
    if (waitMs > 0) await wait(waitMs);
    lastGeocodeAt = Date.now();
    return geocode(query);
  });
  // 1件が失敗しても後続の問い合わせは続けられるようにする
  geocodeQueue = result.catch(() => {});
  return result;
}

// ---- 地名の自動補完 ----

setupAutocomplete("origin");
setupAutocomplete("destination");

function setupAutocomplete(fieldId) {
  const input = document.getElementById(fieldId);
  const box = document.getElementById(`${fieldId}-suggestions`);
  let debounceTimer = null;
  let requestSeq = 0;

  input.addEventListener("input", () => {
    if (selectedPlaces[fieldId] && input.value !== selectedPlaces[fieldId].name) {
      selectedPlaces[fieldId] = null;
    }
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    if (query.length < AUTOCOMPLETE_MIN_LENGTH) {
      hideSuggestions(box);
      return;
    }
    const seq = ++requestSeq;
    debounceTimer = setTimeout(async () => {
      try {
        const list = await throttledGeocode(query);
        if (seq !== requestSeq) return; // 途中でさらに入力が進んでいたら結果は捨てる
        renderSuggestions(box, list, (place) => {
          input.value = place.name;
          selectedPlaces[fieldId] = place;
          hideSuggestions(box);
        });
      } catch {
        // 自動補完の失敗は静かに無視する（「計算」実行時に改めてエラーを表示する）
        hideSuggestions(box);
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);
  });

  input.addEventListener("blur", () => {
    // クリックで選択できるよう、少し待ってから候補を閉じる
    setTimeout(() => hideSuggestions(box), 150);
  });
}

function renderSuggestions(box, list, onSelect) {
  box.innerHTML = "";
  if (list.length === 0) {
    hideSuggestions(box);
    return;
  }
  list.forEach((place) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = place.name;
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // blur より先にクリックを成立させる
    btn.addEventListener("click", () => onSelect(place));
    box.appendChild(btn);
  });
  box.hidden = false;
}

function hideSuggestions(box) {
  box.hidden = true;
  box.innerHTML = "";
}

function matchesSelected(fieldId, value) {
  return selectedPlaces[fieldId] && selectedPlaces[fieldId].name === value;
}

// 候補が複数ある地点について、選択用の一覧を表示する
function showCandidates(originList, destinationList) {
  renderCandidateGroup("origin-candidates", "出発地", originList, "originPlace");
  renderCandidateGroup("destination-candidates", "目的地", destinationList, "destinationPlace");
  candidatesSection.hidden = false;
}

function hideCandidates() {
  candidatesSection.hidden = true;
}

function renderCandidateGroup(containerId, label, list, key) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (list.length <= 1) return;

  const group = document.createElement("div");
  group.className = "candidate-group";
  const h3 = document.createElement("h3");
  h3.textContent = label;
  const ul = document.createElement("ul");

  list.forEach((place) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = place.name;
    btn.addEventListener("click", async () => {
      ul.querySelectorAll("button").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      current[key] = place;
      if (current.originPlace && current.destinationPlace) {
        setBusy(true);
        try {
          await calculate();
        } catch (err) {
          handleError(err);
        }
      }
    });
    li.appendChild(btn);
    ul.appendChild(li);
  });

  group.append(h3, ul);
  container.appendChild(group);
}

// ルートを取得してガソリン代を計算し、地図とカードに表示する
async function calculate() {
  showLoading("ルートを検索しています…");
  const { originPlace: o, destinationPlace: d, efficiency, price } = current;
  const coords = `${o.lon},${o.lat};${d.lon},${d.lat}`;
  const params = new URLSearchParams({ alternatives: "3", overview: "full", geometries: "geojson" });

  const res = await fetch(`${OSRM_URL}/${coords}?${params}`);
  if (!res.ok) throw new ServiceError("ルート検索");
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
    throw new UserError("ルートが見つかりませんでした。別の地名で試してください。");
  }

  const routes = data.routes.slice(0, 3).map((r, i) => {
    const km = r.distance / 1000;
    return {
      label: `ルート${i + 1}`,
      km,
      minutes: r.duration / 60,
      cost: (km / efficiency) * price, // 距離(km) ÷ 燃費(km/L) × 単価(円/L)
      geometry: r.geometry,
      color: ROUTE_COLORS[i],
    };
  });
  const sorted = [...routes].sort((a, b) => a.cost - b.cost);
  const cheapest = sorted[0];

  drawRoutes(routes, cheapest, o, d);
  renderCards(routes, sorted, cheapest);
  hideBanner();
  hideLoading();
  setBusy(false);
}

function drawRoutes(routes, cheapest, o, d) {
  routeLayer.clearLayers();
  activeRoutes = routes;
  // 最安ルートを最後に描いて一番上に表示する
  const ordered = routes.filter((r) => r !== cheapest).concat(cheapest);
  ordered.forEach((r) => {
    const isCheapest = r === cheapest;
    r.layer = L.geoJSON(r.geometry, {
      style: {
        color: isCheapest ? CHEAPEST_COLOR : r.color,
        weight: isCheapest ? 7 : 4,
        opacity: isCheapest ? 0.9 : 0.6,
      },
    }).bindTooltip(`${r.label}：${formatYen(r.cost)}`).addTo(routeLayer);
  });
  L.marker([o.lat, o.lon]).bindPopup(`出発：${o.name}`).addTo(routeLayer);
  L.marker([d.lat, d.lon]).bindPopup(`到着：${d.name}`).addTo(routeLayer);

  const bounds = L.featureGroup(routeLayer.getLayers()).getBounds();
  map.fitBounds(bounds, { padding: [20, 20] });
}

// カードをタップしたとき、そのルートを地図上で強調する
function highlightRoute(route) {
  activeRoutes.forEach((r) => {
    if (!r.layer) return;
    const isTarget = r === route;
    r.layer.setStyle({
      weight: isTarget ? 7 : 4,
      opacity: isTarget ? 0.95 : 0.35,
    });
    if (isTarget) r.layer.bringToFront();
  });
  if (route.layer) {
    route.layer.openTooltip();
    const bounds = route.layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function renderCards(routes, sorted, cheapest) {
  const container = document.getElementById("route-cards");
  container.innerHTML = "";

  routes.forEach((r) => {
    const isCheapest = r === cheapest;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "route-card" + (isCheapest ? " cheapest" : "");

    const diffHtml = buildDiffHtml(r, sorted, cheapest);

    card.innerHTML = `
      <span class="swatch" style="background:${isCheapest ? CHEAPEST_COLOR : r.color}"></span>
      <span class="route-main">
        <span class="route-name">${r.label}${isCheapest ? " ★最安" : ""}</span>
        <span class="route-detail">${r.km.toFixed(1)} km ／ ${formatDuration(r.minutes)}</span>
      </span>
      <span class="route-cost">
        <span class="yen">${formatYen(r.cost)}</span>
        ${diffHtml}
      </span>`;
    card.addEventListener("click", () => highlightRoute(r));
    container.appendChild(card);
  });

  const suggestion = document.getElementById("suggestion");
  suggestion.textContent = routes.length === 1
    ? `ルートは1本だけ見つかりました。ガソリン代は約${formatYen(cheapest.cost)}です。`
    : `おすすめは${cheapest.label}です（ガソリン代 約${formatYen(cheapest.cost)}）。`;
  resultSection.hidden = false;
}

// 最安ルートには「2番目より○円安い」、それ以外には「最安より○円高い」を表示する
function buildDiffHtml(route, sorted, cheapest) {
  if (sorted.length < 2) return "";
  if (route === cheapest) {
    const diff = Math.round(sorted[1].cost - route.cost);
    if (diff <= 0) return "";
    return `<span class="route-diff positive">2番目より${diff.toLocaleString("ja-JP")}円安い</span>`;
  }
  const diff = Math.round(route.cost - cheapest.cost);
  if (diff <= 0) return "";
  return `<span class="route-diff negative">最安より${diff.toLocaleString("ja-JP")}円高い</span>`;
}

// ---- 表示まわりの小さな関数 ----

function formatYen(value) {
  return `${Math.round(value).toLocaleString("ja-JP")}円`;
}

function formatDuration(minutes) {
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`;
}

// 画面上部の目立つ帯：エラーの表示に使う
function showBanner(text) {
  bannerEl.textContent = text;
  bannerEl.hidden = false;
}

function hideBanner() {
  bannerEl.hidden = true;
}

// フォーム直下の控えめな案内：エラーではない補足情報に使う
function showHint(text) {
  hintEl.textContent = text;
  hintEl.hidden = false;
}

function hideHint() {
  hintEl.hidden = true;
}

// 地図の上のスピナー：処理中の段階を示す
function showLoading(text) {
  mapOverlayText.textContent = text;
  mapOverlay.hidden = false;
}

function hideLoading() {
  mapOverlay.hidden = true;
}

function setBusy(busy) {
  calcButton.disabled = busy;
  calcButton.textContent = busy ? "処理中…" : "計算";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class UserError extends Error {}

class ServiceError extends Error {
  constructor(serviceName) {
    super(`${serviceName}サービスが混雑しているか、一時的に使えません。少し待ってからもう一度お試しください。`);
  }
}

function handleError(err) {
  const text = err instanceof UserError || err instanceof ServiceError
    ? err.message
    : "通信に失敗しました。インターネット接続を確認して、もう一度お試しください。";
  hideLoading();
  showBanner(text);
  setBusy(false);
}
