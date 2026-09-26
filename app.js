// ガソリン代ルート比較アプリ（MVP）
// 地名検索：Nominatim、ルート検索：OSRM、地図表示：Leaflet

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const NOMINATIM_INTERVAL_MS = 1100; // Nominatim の利用ルール（1秒に1回まで）を守るための間隔
const ROUTE_COLORS = ["#1f6feb", "#8250df", "#2da44e"];
const CHEAPEST_COLOR = "#e36209";

const form = document.getElementById("input-form");
const calcButton = document.getElementById("calc-button");
const messageEl = document.getElementById("message");
const candidatesSection = document.getElementById("candidates");
const resultSection = document.getElementById("result");

// 地図の初期表示（日本全体）
const map = L.map("map").setView([36.5, 138], 5);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);

// 今回の計算条件と、選ばれた地点
let current = null;

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = readInput();
  if (!input) return;

  current = { ...input, originPlace: null, destinationPlace: null };
  candidatesSection.hidden = true;
  resultSection.hidden = true;
  routeLayer.clearLayers();
  setBusy(true);
  showMessage("地名を検索しています…");

  try {
    const originList = await geocode(input.origin);
    await wait(NOMINATIM_INTERVAL_MS);
    const destinationList = await geocode(input.destination);

    if (originList.length === 0) throw new UserError(`出発地「${input.origin}」が見つかりませんでした。`);
    if (destinationList.length === 0) throw new UserError(`目的地「${input.destination}」が見つかりませんでした。`);

    if (originList.length === 1) current.originPlace = originList[0];
    if (destinationList.length === 1) current.destinationPlace = destinationList[0];

    if (current.originPlace && current.destinationPlace) {
      await calculate();
    } else {
      showCandidates(originList, destinationList);
      showMessage("候補が複数あります。下の一覧から選んでください。");
      setBusy(false);
    }
  } catch (err) {
    handleError(err);
  }
});

// 入力チェック。問題なければ入力値を返す
function readInput() {
  const origin = document.getElementById("origin").value.trim();
  const destination = document.getElementById("destination").value.trim();
  const efficiency = parseFloat(document.getElementById("efficiency").value);
  const price = parseFloat(document.getElementById("price").value);

  const errors = [];
  if (!origin) errors.push("出発地を入力してください。");
  if (!destination) errors.push("目的地を入力してください。");
  if (!(efficiency > 0)) errors.push("燃費は0より大きい数値を入力してください。");
  if (!(price > 0)) errors.push("単価は0より大きい数値を入力してください。");

  if (errors.length > 0) {
    showMessage(errors.join(" "), true);
    return null;
  }
  return { origin, destination, efficiency, price };
}

// 地名 → 緯度経度の候補一覧
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

// 候補が複数ある地点について、選択用の一覧を表示する
function showCandidates(originList, destinationList) {
  renderCandidateGroup("origin-candidates", "出発地", originList, "originPlace");
  renderCandidateGroup("destination-candidates", "目的地", destinationList, "destinationPlace");
  candidatesSection.hidden = false;
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

// ルートを取得してガソリン代を計算し、地図と比較表に表示する
async function calculate() {
  showMessage("ルートを検索しています…");
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
  const cheapest = routes.reduce((a, b) => (b.cost < a.cost ? b : a));

  drawRoutes(routes, cheapest, o, d);
  renderTable(routes, cheapest);
  hideMessage();
  setBusy(false);
}

function drawRoutes(routes, cheapest, o, d) {
  routeLayer.clearLayers();
  // 最安ルートを最後に描いて一番上に表示する
  const ordered = routes.filter((r) => r !== cheapest).concat(cheapest);
  ordered.forEach((r) => {
    const isCheapest = r === cheapest;
    L.geoJSON(r.geometry, {
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

function renderTable(routes, cheapest) {
  const tbody = document.getElementById("result-body");
  tbody.innerHTML = "";
  routes.forEach((r) => {
    const tr = document.createElement("tr");
    const isCheapest = r === cheapest;
    if (isCheapest) tr.className = "cheapest";
    const color = isCheapest ? CHEAPEST_COLOR : r.color;
    tr.innerHTML = `
      <td><span class="swatch" style="background:${color}"></span>${r.label}${isCheapest ? " ★最安" : ""}</td>
      <td>${r.km.toFixed(1)} km</td>
      <td>${formatDuration(r.minutes)}</td>
      <td>${formatYen(r.cost)}</td>`;
    tbody.appendChild(tr);
  });

  const suggestion = document.getElementById("suggestion");
  suggestion.textContent = routes.length === 1
    ? `ルートは1本だけ見つかりました。ガソリン代は約${formatYen(cheapest.cost)}です。`
    : `おすすめは${cheapest.label}です（ガソリン代 約${formatYen(cheapest.cost)}）。`;
  resultSection.hidden = false;
}

// ---- 表示まわりの小さな関数 ----

function formatYen(value) {
  return `${Math.round(value).toLocaleString("ja-JP")}円`;
}

function formatDuration(minutes) {
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`;
}

function showMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.classList.toggle("error", isError);
  messageEl.hidden = false;
}

function hideMessage() {
  messageEl.hidden = true;
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
  showMessage(text, true);
  setBusy(false);
}
