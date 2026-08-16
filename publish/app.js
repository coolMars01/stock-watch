"use strict";

const STORAGE_KEYS = {
  rows: "stockwatch.rows.v1",
  logs: "stockwatch.logs.v1",
  trades: "stockwatch.trades.v1",
  plans: "stockwatch.plans.v1",
  refresh: "stockwatch.refresh.v1",
};
const REFRESH_OPTIONS = [
  { value: "manual", label: "手动", minutes: null },
  { value: "10", label: "每10分钟", minutes: 10 },
  { value: "30", label: "每30分钟", minutes: 30 },
  { value: "60", label: "每小时", minutes: 60 },
  { value: "240", label: "每4小时", minutes: 240 },
];
const DEFAULT_REFRESH_VALUE = "60";
const TENCNT_QUOTE = "https://qt.gtimg.cn/q=";
const CURRENCY_BY_MARKET = { sh: "CNY", sz: "CNY", bj: "CNY", hk: "HKD", us: "USD" };
const DATA_KEYS = ["rows", "logs", "trades", "plans"];

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};

const state = {
  rows: store.get(STORAGE_KEYS.rows, []),
  logs: store.get(STORAGE_KEYS.logs, []),
  trades: store.get(STORAGE_KEYS.trades, []),
  plans: store.get(STORAGE_KEYS.plans, []),
  quotes: new Map(),
  refreshing: false,
  refreshValue: store.get(STORAGE_KEYS.refresh, DEFAULT_REFRESH_VALUE),
  nextRefreshAt: null,
  refreshTimer: null,
};

let serverMode = false;
let syncTimer = null;

const $ = (id) => document.getElementById(id);
const quoteLink = (code) => "https://gu.qq.com/" + code;

function normalizeCode(input) {
  let s = String(input || "").trim().toUpperCase();
  if (!s) return null;
  const prefixed = s.match(/^(SH|SZ|BJ|HK|US)([A-Z0-9.-]+)$/);
  if (prefixed) return prefixed[1].toLowerCase() + prefixed[2];
  if (/^\d{5}$/.test(s)) return "hk" + s;
  if (/^\d{6}$/.test(s)) {
    const head = s[0];
    if (head === "6" || head === "5" || head === "9") return "sh" + s; // 沪A/沪基金/沪B
    if (head === "0" || head === "2" || head === "3") return "sz" + s; // 深A/深基金/深B/创业板
    if (head === "4" || head === "8") return "bj" + s; // 北交所
    return null;
  }
  if (/^[A-Z][A-Z0-9.-]{0,10}$/.test(s)) return "us" + s;
  return null;
}

function fmt(n, digits = 2) {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtSigned(n, digits = 2) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + fmt(n, digits);
}

function normalizeTime(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (/^\d{14}$/.test(s)) {
    return `${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
  }
  return s.replace(/-/g, "/");
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

function setUpdateTime(text) {
  $("update-time").textContent = text;
}

function stockName(code) {
  const q = state.quotes.get(code);
  return q && q.ok ? q.name : "";
}

// ---------- 行情 ----------

function parseTencentParts(code, parts) {
  const market = code.slice(0, 2);
  const num = (i) => (i < parts.length ? Number(parts[i]) : NaN);
  const toF = (i) => {
    const n = num(i);
    return isFinite(n) ? n : null;
  };
  return {
    code,
    market,
    ok: true,
    name: parts[1] || "",
    price: toF(3),
    prevClose: toF(4),
    open: toF(5),
    high: toF(33),
    low: toF(34),
    change: toF(31),
    changePct: toF(32),
    time: parts[30] || "",
    currency: CURRENCY_BY_MARKET[market] || "CNY",
    quoteUrl: quoteLink(code),
  };
}

async function fetchQuotesViaServer(codes) {
  const res = await fetch("/api/quote?codes=" + encodeURIComponent(codes.join(",")), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("proxy " + res.status);
  return res.json();
}

async function fetchQuotesDirect(codes) {
  const res = await fetch(TENCNT_QUOTE + codes.join(","), { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("gbk").decode(buf);
  const found = new Map();
  for (const line of text.split(";")) {
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const varName = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"')) value = value.slice(1, -1);
    found.set(varName, value);
  }
  const quotes = codes.map((code) => {
    const raw = found.get("v_" + code);
    if (raw == null) return { code, ok: false, error: "未找到该代码，请检查代码是否正确" };
    const parts = raw.split("~");
    if (parts.length < 35 || !parts[1].trim()) return { code, ok: false, error: "行情解析失败" };
    return parseTencentParts(code, parts);
  });
  return { ok: true, quotes };
}

function allQuoteCodes() {
  const set = new Set(state.rows.map((r) => r.code));
  for (const t of state.trades) set.add(t.code);
  for (const p of state.plans) if (p.code) set.add(p.code);
  return [...set].filter((c) => /^(sh|sz|bj|hk|us)/.test(c));
}

async function refreshQuotes({ silent = false } = {}) {
  const codes = allQuoteCodes();
  if (!codes.length) {
    setUpdateTime("无自选股");
    return;
  }
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    let data;
    try {
      data = await fetchQuotesDirect(codes);
    } catch (directErr) {
      if (!serverMode) throw directErr;
      data = await fetchQuotesViaServer(codes); // 直连失败时退回本机代理
    }
    if (data && data.ok && Array.isArray(data.quotes)) {
      for (const q of data.quotes) state.quotes.set(q.code, q);
      updateAllRows();
      renderPortfolio();
      setUpdateTime("更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    } else if (!silent) {
      toast("行情获取失败：" + (data && data.error ? data.error : "未知错误"));
    }
  } catch {
    if (!silent) toast("行情获取失败，请检查网络后重试");
  } finally {
    state.refreshing = false;
  }
}

// ---------- 数据 ----------

async function detectServerMode() {
  try {
    const res = await fetch("/api/data", { cache: "no-store" });
    serverMode = res.ok;
  } catch {
    serverMode = false;
  }
}

function normalizeData(data) {
  const out = {};
  for (const key of DATA_KEYS) {
    out[key] = data && Array.isArray(data[key]) ? data[key] : [];
  }
  return out;
}

async function loadData() {
  if (!serverMode) return;
  try {
    const res = await fetch("/api/data", { cache: "no-store" });
    if (!res.ok) return;
    const data = normalizeData(await res.json());
    const hadLocal = DATA_KEYS.some((k) => state[k].length > 0);
    const serverEmpty = DATA_KEYS.every((k) => data[k].length === 0);
    if (serverEmpty && hadLocal) {
      persistData(); // 服务端为空但本地有数据：保留本地并同步上去
    } else {
      for (const key of DATA_KEYS) state[key] = data[key];
    }
  } catch {
    /* 保持本地数据 */
  }
}

function persistData() {
  for (const key of DATA_KEYS) store.set(STORAGE_KEYS[key], state[key]);
  renderSyncStatus();
  if (!serverMode) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const payload = {};
      for (const key of DATA_KEYS) payload[key] = state[key];
      await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      /* 下次变更时自动重试 */
    }
  }, 300);
}

function renderSyncStatus() {
  $("sync-status").textContent = serverMode
    ? "数据存在本机服务，多设备共享"
    : "数据保存在当前浏览器";
}

// ---------- 标签页 ----------

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.hidden = p.id !== "panel-" + name;
  });
  if (name === "watch") refreshQuotes({ silent: true });
  if (name === "ledger") {
    renderTrades();
    renderPortfolio();
  }
  if (name === "plan") renderPlans();
  if (name === "review") renderLogs();
}

// ---------- 盯盘 ----------

function updateRowState(tr, row) {
  const q = state.quotes.get(row.code);
  const priceEl = tr.querySelector("[data-price]");
  const chgEl = tr.querySelector("[data-chg]");
  const nameEl = tr.querySelector("[data-name]");
  const currencyEl = tr.querySelector("[data-currency]");
  const gapEl = tr.querySelector("[data-gap]");
  const pillEl = tr.querySelector("[data-pill]");
  const market = row.code.slice(0, 2);

  if (q && q.ok) {
    nameEl.textContent = q.name;
    priceEl.textContent = fmt(q.price, market === "hk" ? 3 : 2);
    currencyEl.textContent = q.currency && q.currency !== "CNY" ? q.currency : "";
    if (q.changePct != null) {
      const sign = q.changePct > 0 ? "+" : "";
      chgEl.textContent = `${sign}${q.changePct.toFixed(2)}%`;
      chgEl.className = "chg " + (q.changePct > 0 ? "up" : q.changePct < 0 ? "down" : "flat");
      chgEl.title = `涨跌 ${q.change >= 0 ? "+" : ""}${fmt(q.change)}`;
    } else {
      chgEl.textContent = "—";
      chgEl.className = "chg flat";
    }
    tr.title = `行情时间 ${normalizeTime(q.time)}`;
  } else {
    nameEl.textContent = q && q.error ? `⚠ ${q.error}` : "…";
    priceEl.textContent = "—";
    chgEl.textContent = "";
    chgEl.className = "chg flat";
    currencyEl.textContent = "";
    tr.title = "";
  }

  if (row.expected != null && q && q.ok && q.price != null) {
    const gap = ((q.price - row.expected) / row.expected) * 100;
    gapEl.textContent = `距预期 ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}%`;
    if (gap >= 0) {
      pillEl.textContent = "已达标";
      pillEl.className = "pill ok";
    } else if (gap >= -3) {
      pillEl.textContent = "接近";
      pillEl.className = "pill near";
    } else {
      pillEl.textContent = "未到";
      pillEl.className = "pill far";
    }
  } else {
    gapEl.textContent = row.expected == null ? "" : "等待行情…";
    pillEl.textContent = "";
    pillEl.className = "pill";
  }
}

function buildRow(row) {
  const tr = document.createElement("tr");
  tr.dataset.id = row.id;

  const tdStock = document.createElement("td");
  tdStock.className = "cell-stock";
  const a = document.createElement("a");
  a.className = "code";
  a.href = quoteLink(row.code);
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = row.code;
  const name = document.createElement("span");
  name.className = "name";
  name.dataset.name = "name";
  name.textContent = "…";
  tdStock.append(a, name);
  tr.appendChild(tdStock);

  const tdPrice = document.createElement("td");
  tdPrice.className = "cell-price";
  const price = document.createElement("span");
  price.className = "price";
  price.dataset.price = "price";
  price.textContent = "—";
  const chg = document.createElement("span");
  chg.className = "chg";
  chg.dataset.chg = "chg";
  const currency = document.createElement("span");
  currency.className = "currency";
  currency.dataset.currency = "currency";
  tdPrice.append(price, chg, currency);
  tr.appendChild(tdPrice);

  const tdExpect = document.createElement("td");
  tdExpect.className = "cell-expect";
  const expectInput = document.createElement("input");
  expectInput.type = "number";
  expectInput.step = "0.001";
  expectInput.className = "expect-input";
  expectInput.placeholder = "目标价";
  expectInput.value = row.expected ?? "";
  expectInput.addEventListener("change", () => {
    row.expected = expectInput.value === "" ? null : Number(expectInput.value);
    persistData();
    updateRowState(tr, row);
  });
  const gap = document.createElement("span");
  gap.className = "gap";
  gap.dataset.gap = "gap";
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.dataset.pill = "pill";
  tdExpect.append(expectInput, gap, pill);
  tr.appendChild(tdExpect);

  const tdNotes = document.createElement("td");
  tdNotes.className = "cell-notes";
  const notesInput = document.createElement("input");
  notesInput.className = "notes-input";
  notesInput.placeholder = "经验 / 备注";
  notesInput.value = row.notes || "";
  notesInput.addEventListener("change", () => {
    row.notes = notesInput.value.trim();
    persistData();
  });
  tdNotes.appendChild(notesInput);
  tr.appendChild(tdNotes);

  const tdActions = document.createElement("td");
  tdActions.className = "cell-actions";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "del-btn";
  del.textContent = "删除";
  del.addEventListener("click", () => {
    if (confirm(`确定删除 ${row.code} 吗？`)) {
      state.rows = state.rows.filter((r) => r.id !== row.id);
      persistData();
      render();
      updateSummary();
    }
  });
  tdActions.appendChild(del);
  tr.appendChild(tdActions);

  updateRowState(tr, row);
  return tr;
}

function render() {
  const body = $("quote-body");
  body.innerHTML = "";
  for (const row of state.rows) {
    body.appendChild(buildRow(row));
  }
  $("empty-tip").style.display = state.rows.length ? "none" : "";
  updateSummary();
}

function updateAllRows() {
  for (const tr of document.querySelectorAll("#quote-body tr")) {
    const row = state.rows.find((r) => r.id === tr.dataset.id);
    if (row) updateRowState(tr, row);
  }
  updateSummary();
}

function updateSummary() {
  let up = 0;
  let down = 0;
  for (const row of state.rows) {
    const q = state.quotes.get(row.code);
    if (q && q.ok && q.changePct != null) {
      if (q.changePct > 0) up++;
      else if (q.changePct < 0) down++;
    }
  }
  $("summary").textContent = `共 ${state.rows.length} 只 · 上涨 ${up} · 下跌 ${down}`;
}

// ---------- 记账 ----------

function computePositions() {
  const acc = new Map();
  for (const t of state.trades) {
    let a = acc.get(t.code);
    if (!a) {
      a = { qty: 0, cost: 0, realized: 0 };
      acc.set(t.code, a);
    }
    const qty = Number(t.qty) || 0;
    const price = Number(t.price) || 0;
    if (t.side === "buy") {
      a.qty += qty;
      a.cost += price * qty;
    } else {
      const avg = a.qty > 0 ? a.cost / a.qty : price;
      const sold = Math.min(qty, a.qty);
      a.realized += (price - avg) * sold;
      a.cost -= avg * sold;
      a.qty -= sold;
    }
  }
  const list = [];
  let totalRealized = 0;
  for (const [code, a] of acc) {
    totalRealized += a.realized;
    if (a.qty > 0) {
      list.push({ code, qty: a.qty, avgCost: a.cost / a.qty, realized: a.realized });
    }
  }
  return { list, totalRealized };
}

function renderPortfolio() {
  const { list, totalRealized } = computePositions();
  const body = $("position-body");
  body.innerHTML = "";
  let totalValue = 0;
  let totalFloat = 0;
  let totalCost = 0;

  for (const pos of list) {
    const q = state.quotes.get(pos.code);
    const price = q && q.ok ? q.price : null;
    const value = price != null ? price * pos.qty : null;
    const float = price != null ? (price - pos.avgCost) * pos.qty : null;
    const floatPct = price != null ? ((price - pos.avgCost) / pos.avgCost) * 100 : null;
    if (value != null) totalValue += value;
    if (float != null) totalFloat += float;
    totalCost += pos.avgCost * pos.qty;

    const tr = document.createElement("tr");
    const tdCode = document.createElement("td");
    tdCode.className = "cell-stock";
    const a = document.createElement("a");
    a.className = "code";
    a.href = quoteLink(pos.code);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = pos.code;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = stockName(pos.code) || "…";
    tdCode.append(a, name);
    tr.appendChild(tdCode);

    const qty = document.createElement("td");
    qty.className = "num";
    qty.textContent = fmt(pos.qty, Number.isInteger(pos.qty) ? 0 : 2);
    tr.appendChild(qty);

    const cost = document.createElement("td");
    cost.className = "num";
    cost.textContent = fmt(pos.avgCost, pos.code.slice(0, 2) === "hk" ? 3 : 2);
    tr.appendChild(cost);

    const cur = document.createElement("td");
    cur.className = "num";
    cur.textContent = price != null ? fmt(price, pos.code.slice(0, 2) === "hk" ? 3 : 2) : "—";
    tr.appendChild(cur);

    const mv = document.createElement("td");
    mv.className = "num";
    mv.textContent = value != null ? fmt(value) : "—";
    tr.appendChild(mv);

    const pl = document.createElement("td");
    pl.className = "num " + (float > 0 ? "up" : float < 0 ? "down" : "flat");
    pl.textContent = float != null ? `${fmtSigned(float)} (${fmtSigned(floatPct, 2)}%)` : "—";
    tr.appendChild(pl);

    body.appendChild(tr);
  }

  $("position-empty").style.display = list.length ? "none" : "";
  const costBase = totalCost || 1;
  const floatPct = (totalFloat / costBase) * 100;
  const summary = list.length
    ? `持仓 ${list.length} 只 · 市值 ${fmt(totalValue)} · 浮动盈亏 ${fmtSigned(totalFloat)}（${fmtSigned(floatPct)}%） · 已实现 ${fmtSigned(totalRealized)}`
    : "还没有持仓，先记一笔买入吧。";
  $("portfolio-summary").textContent = summary;
}

function renderTrades() {
  const body = $("trade-body");
  body.innerHTML = "";
  const reversed = [...state.trades].reverse();
  for (const t of reversed) {
    const tr = document.createElement("tr");
    const tdDate = document.createElement("td");
    tdDate.textContent = t.date || "";
    tr.appendChild(tdDate);

    const tdCode = document.createElement("td");
    const a = document.createElement("a");
    a.className = "code";
    a.href = quoteLink(t.code);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = t.code;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = stockName(t.code) || "…";
    tdCode.append(a, name);
    tr.appendChild(tdCode);

    const tdSide = document.createElement("td");
    const side = document.createElement("span");
    side.className = "pill " + (t.side === "buy" ? "ok" : "far");
    side.textContent = t.side === "buy" ? "买入" : "卖出";
    tdSide.appendChild(side);
    tr.appendChild(tdSide);

    const tdPrice = document.createElement("td");
    tdPrice.className = "num";
    tdPrice.textContent = fmt(t.price, t.code.slice(0, 2) === "hk" ? 3 : 2);
    tr.appendChild(tdPrice);

    const tdQty = document.createElement("td");
    tdQty.className = "num";
    tdQty.textContent = fmt(t.qty, Number.isInteger(t.qty) ? 0 : 2);
    tr.appendChild(tdQty);

    const tdNote = document.createElement("td");
    tdNote.textContent = t.note || "";
    tr.appendChild(tdNote);

    const tdDel = document.createElement("td");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del-btn";
    del.textContent = "删除";
    del.addEventListener("click", () => {
      if (confirm("删除这笔交易？")) {
        state.trades = state.trades.filter((x) => x.id !== t.id);
        persistData();
        renderTrades();
        renderPortfolio();
      }
    });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);

    body.appendChild(tr);
  }
  $("trade-empty").style.display = state.trades.length ? "none" : "";
}

function exportTradesCsv() {
  const { list } = computePositions();
  const lines = [
    ["持仓", "代码", "名称", "持仓数量", "成本均价", "现价", "市值", "浮动盈亏", "浮动盈亏%"],
  ];
  for (const pos of list) {
    const q = state.quotes.get(pos.code);
    const price = q && q.ok ? q.price : null;
    const value = price != null ? price * pos.qty : "";
    const float = price != null ? (price - pos.avgCost) * pos.qty : "";
    const floatPct = price != null ? ((price - pos.avgCost) / pos.avgCost) * 100 : "";
    lines.push([
      "",
      pos.code,
      stockName(pos.code),
      pos.qty,
      pos.avgCost,
      price ?? "",
      value,
      float,
      floatPct,
    ]);
  }
  lines.push([]);
  lines.push(["交易记录", "日期", "代码", "名称", "方向", "价格", "数量", "备注"]);
  for (const t of state.trades) {
    lines.push([
      "",
      t.date,
      t.code,
      stockName(t.code),
      t.side === "buy" ? "买入" : "卖出",
      t.price,
      t.qty,
      t.note || "",
    ]);
  }
  downloadCsv(lines, "记账");
}

function downloadCsv(lines, prefix) {
  const csv =
    "\ufeff" +
    lines
      .map((line) =>
        line
          .map((v) => {
            const s = String(v ?? "");
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
          })
          .join(",")
      )
      .join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `${prefix}_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

// ---------- 计划 ----------

function renderPlans() {
  const list = $("plan-list");
  list.innerHTML = "";
  if (!state.plans.length) {
    const li = document.createElement("li");
    li.className = "log-empty";
    li.textContent = "还没有计划，写下下一步操作吧。";
    list.appendChild(li);
    return;
  }
  for (const p of state.plans) {
    const li = document.createElement("li");
    li.className = "log-item plan-item" + (p.done ? " done" : "");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "plan-check";
    check.checked = !!p.done;
    check.addEventListener("change", () => {
      p.done = check.checked;
      persistData();
      renderPlans();
    });
    const text = document.createElement("span");
    text.textContent = p.text;
    const code = document.createElement("span");
    if (p.code) {
      code.className = "pill far";
      code.textContent = p.code;
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del-btn";
    del.textContent = "删除";
    del.addEventListener("click", () => {
      if (confirm("删除这条计划？")) {
        state.plans = state.plans.filter((x) => x.id !== p.id);
        persistData();
        renderPlans();
      }
    });
    li.append(check, text, code, del);
    list.appendChild(li);
  }
}

// ---------- 复盘 ----------

function renderLogs() {
  const list = $("log-list");
  list.innerHTML = "";
  if (!state.logs.length) {
    const li = document.createElement("li");
    li.className = "log-empty";
    li.textContent = "还没有记录，写一条经验或复盘吧。";
    list.appendChild(li);
    return;
  }
  for (const log of state.logs) {
    const li = document.createElement("li");
    li.className = "log-item";
    const time = document.createElement("time");
    time.textContent = new Date(log.time).toLocaleString("zh-CN", { hour12: false });
    const text = document.createElement("span");
    text.textContent = log.text;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del-btn";
    del.textContent = "删除";
    del.addEventListener("click", () => {
      if (confirm("删除这条记录？")) {
        state.logs = state.logs.filter((l) => l.id !== log.id);
        persistData();
        renderLogs();
      }
    });
    li.append(time, text, del);
    list.appendChild(li);
  }
}

// ---------- 刷新间隔 ----------

function refreshSettings() {
  const opt =
    REFRESH_OPTIONS.find((o) => o.value === state.refreshValue) || REFRESH_OPTIONS[0];
  return { label: opt.label, ms: opt.minutes ? opt.minutes * 60 * 1000 : null };
}

function renderRefreshInfo() {
  const { label, ms } = refreshSettings();
  const el = $("refresh-info");
  if (!ms) {
    el.textContent = "手动刷新";
    return;
  }
  const next = new Date(state.nextRefreshAt || Date.now() + ms);
  const time = next.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  el.textContent = `${label}自动刷新 · 下次 ${time}`;
}

function applyRefreshInterval({ refreshNow = false } = {}) {
  store.set(STORAGE_KEYS.refresh, state.refreshValue);
  const { ms } = refreshSettings();
  state.nextRefreshAt = ms ? Date.now() + ms : null;
  renderRefreshInfo();
  if (refreshNow && ms) refreshQuotes({ silent: true });
}

function startRefreshTimer() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    const { ms } = refreshSettings();
    if (ms && Date.now() >= state.nextRefreshAt) {
      state.nextRefreshAt = Date.now() + ms;
      refreshQuotes({ silent: true });
    }
    renderRefreshInfo();
  }, 30000);
}

// ---------- 导出 / 复制 ----------

function exportCsv() {
  const header = ["代码", "名称", "现价", "涨跌幅%", "我的预期", "距预期%", "经验/备注"];
  const lines = [header];
  for (const row of state.rows) {
    const q = state.quotes.get(row.code);
    const gap =
      row.expected != null && q && q.ok && q.price != null
        ? (((q.price - row.expected) / row.expected) * 100).toFixed(2)
        : "";
    lines.push([
      row.code,
      q && q.ok ? q.name : "",
      q && q.ok ? q.price : "",
      q && q.ok && q.changePct != null ? q.changePct : "",
      row.expected ?? "",
      gap,
      row.notes || "",
    ]);
  }
  downloadCsv(lines, "盯盘");
}

function copyText(text) {
  const done = () => toast("已复制");
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch {
      toast("复制失败，请手动输入");
    }
    ta.remove();
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, fallback);
  } else {
    fallback();
  }
}

async function loadAccessInfo() {
  if (!serverMode) return;
  try {
    const res = await fetch("/api/ip", { cache: "no-store" });
    const data = await res.json();
    const lan = (data.urls || []).find((u) => !u.includes("127.0.0.1"));
    if (!lan) return;
    $("access-card").hidden = false;
    $("lan-url").textContent = lan;
    const qrImg = $("qr-img");
    qrImg.src =
      "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(lan);
    qrImg.onerror = () => {
      qrImg.style.display = "none";
    };
    $("copy-url").onclick = () => copyText(lan);
  } catch {
    /* 忽略 */
  }
}

// ---------- 初始化 ----------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

async function init() {
  // 标签页
  $("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (btn) switchTab(btn.dataset.tab);
  });

  // 盯盘
  $("add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = normalizeCode($("new-code").value);
    if (!code) {
      toast("代码格式不对，示例：600519 / 000001 / AAPL / 00700");
      return;
    }
    if (state.rows.some((r) => r.code === code)) {
      toast("该股票已在列表中");
      return;
    }
    const expectedRaw = $("new-expected").value.trim();
    const expected = expectedRaw === "" ? null : Number(expectedRaw);
    const notes = $("new-notes").value.trim();
    state.rows.push({ id: newId(), code, expected, notes });
    persistData();
    $("new-code").value = "";
    $("new-expected").value = "";
    $("new-notes").value = "";
    render();
    refreshQuotes({ silent: true });
  });

  $("refresh-btn").addEventListener("click", () => {
    refreshQuotes();
  });

  $("export-btn").addEventListener("click", exportCsv);

  const select = $("refresh-interval");
  select.value = REFRESH_OPTIONS.some((o) => o.value === state.refreshValue)
    ? state.refreshValue
    : DEFAULT_REFRESH_VALUE;
  select.addEventListener("change", (e) => {
    state.refreshValue = e.target.value;
    applyRefreshInterval({ refreshNow: true });
  });

  // 记账
  $("trade-date").value = todayStr();
  $("trade-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = normalizeCode($("trade-code").value);
    if (!code) {
      toast("代码格式不对，示例：600519 / AAPL");
      return;
    }
    const price = Number($("trade-price").value);
    const qty = Number($("trade-qty").value);
    if (!(price > 0) || !(qty > 0)) {
      toast("请填写有效的价格和数量");
      return;
    }
    state.trades.push({
      id: newId(),
      date: $("trade-date").value || todayStr(),
      code,
      side: $("trade-side").value,
      price,
      qty,
      note: $("trade-note").value.trim(),
    });
    persistData();
    $("trade-code").value = "";
    $("trade-price").value = "";
    $("trade-qty").value = "";
    $("trade-note").value = "";
    renderTrades();
    renderPortfolio();
    refreshQuotes({ silent: true });
  });
  $("export-trades-btn").addEventListener("click", exportTradesCsv);

  // 计划
  $("plan-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("plan-text").value.trim();
    if (!text) return;
    const codeInput = $("plan-code").value.trim();
    const code = codeInput ? normalizeCode(codeInput) : "";
    if (codeInput && !code) {
      toast("关联代码格式不对");
      return;
    }
    state.plans.push({ id: newId(), text, code: code || "", done: false });
    persistData();
    $("plan-text").value = "";
    $("plan-code").value = "";
    renderPlans();
    if (code) refreshQuotes({ silent: true });
  });

  // 复盘
  $("log-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("log-text").value.trim();
    if (!text) return;
    state.logs.unshift({ id: newId(), time: new Date().toISOString(), text });
    persistData();
    $("log-text").value = "";
    renderLogs();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshQuotes({ silent: true });
  });

  await detectServerMode();
  await loadData();
  render();
  renderLogs();
  renderPlans();
  renderTrades();
  renderPortfolio();
  refreshQuotes({ silent: true });
  applyRefreshInterval();
  startRefreshTimer();
  loadAccessInfo();
  renderSyncStatus();
}

init();
