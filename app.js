/* =========================================================
   ■ カテゴリの定義（表示順とタブ名）
   実際のニュースデータは news.json にあらかじめ用意されており、
   このページはそれを読み込んで表示するだけです（中継サービス不要）。
   ニュースの取得・英語タイトルの翻訳は、GitHubの自動機能が
   約3時間ごとにサーバー側で行っています（build_news.py）。
   ========================================================= */
const CATEGORIES = [
  { id: "all",   name: "すべて" },
  { id: "overseas", name: "海外記事" },
  { id: "japan", name: "日本のクラフトジン" },
  { id: "newdistillery", name: "新蒸留所/オープン" },
  { id: "event", name: "イベント・限定品" },
];

let newsData = null;        // 読み込んだ news.json をまるごと保持
let currentCategory = "all";

const feedEl = document.getElementById("feed");
const statusEl = document.getElementById("status");
const countNumEl = document.getElementById("countNum");
const updatedAtEl = document.getElementById("updatedAt");
const pickupEl = document.getElementById("pickup");

/* =========================================================
   ■ 新着バッジ用：前回このページを見た時刻を localStorage に保存
   それより新しい記事に「NEW」バッジを付けます。
   （file:// やプライベートモードでも落ちないよう try-catch で保護）
   ========================================================= */
const LAST_VIEW_KEY = "ginNews_lastViewedAt";
// 今回の判定に使う「前回閲覧時刻」（このページを開いた時点で一度だけ読み込む）
let lastViewedAt = readLastViewedAt();

function readLastViewedAt() {
  try {
    const v = localStorage.getItem(LAST_VIEW_KEY);
    if (!v) return null;
    const t = new Date(v).getTime();
    return isNaN(t) ? null : t;
  } catch (e) {
    return null; // localStorage が使えない環境では新着判定を無効化
  }
}

function saveLastViewedAt() {
  try {
    localStorage.setItem(LAST_VIEW_KEY, new Date().toISOString());
  } catch (e) {
    /* 保存できなくても表示には影響しないので無視します */
  }
}

// 記事が「前回閲覧時刻」より新しいかどうか（新着＝NEW判定）
function isNewArticle(a) {
  if (lastViewedAt === null) return false; // 初回訪問時は全部NEWにしないでおく
  if (!a || !a.date) return false;
  const t = new Date(a.date).getTime();
  if (isNaN(t)) return false;
  return t > lastViewedAt;
}

/* =========================================================
   ■ データの読み込み
   ========================================================= */
async function loadData() {
  feedEl.innerHTML = '<div class="loading"><div class="spinner"></div>ニュースを読み込んでいます…</div>';
  statusEl.textContent = "読み込み中…";
  countNumEl.textContent = "—";
  updatedAtEl.textContent = "読み込み中";

  try {
    // キャッシュ回避のため時刻を付けて毎回最新の news.json を取得
    const res = await fetch("news.json?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("読み込み失敗");
    newsData = await res.json();
  } catch (e) {
    newsData = null;
    feedEl.innerHTML = '<div class="empty">ニュースデータを読み込めませんでした。<br>少し時間をおいて「↻ 最新に更新」を押してみてください。</div>';
    statusEl.textContent = "";
    countNumEl.textContent = "0";
    updatedAtEl.textContent = "読み込み失敗";
    return;
  }
  renderPickup();        // 注目ピックアップ（重要度の高い3件）を先に描画
  updateTabCounts();     // 各タブに件数を表示
  showCategory(currentCategory);
  saveLastViewedAt();    // 描画が終わったら「今見た時刻」を保存（次回のNEW判定用）
}

/* =========================================================
   ■ 今日のまとめ（ピックアップ）
   全カテゴリ横断で最新3件をコンパクトに見せるダイジェスト枠。
   出勤時にここだけ見れば最新が分かるようにしています。
   記事が3件未満ならある分だけ表示します。
   ========================================================= */
function renderPickup() {
  const all = articlesFor("all");
  if (all.length === 0) {
    pickupEl.hidden = true;
    pickupEl.innerHTML = "";
    return;
  }
  // 近似重複をまとめ、「最近(3週間以内)」の重要ニュースを優先して上位3件（注目）
  const RECENT_MS = 21 * 86400000;
  const nowT = Date.now();
  const pool = clusterArticles(all);
  const recent = pool.filter((a) => a.date && (nowT - new Date(a.date).getTime()) <= RECENT_MS);
  const base = recent.length >= 3 ? recent : pool; // 最近の記事が少なければ全体から
  const top = base
    .sort((x, y) => (importanceScore(y) - importanceScore(x)) || (y.date || "").localeCompare(x.date || ""))
    .slice(0, 3);

  const items = top.map((a) => {
    const dateStr = a.date ? formatDate(a.date) : "";
    const newBadge = isNewArticle(a) ? '<span class="new-badge">New</span>' : "";
    return `
      <a class="pickup-item" href="${escapeHtml(a.link)}" target="_blank" rel="noopener">
        <p class="pickup-title">${escapeHtml(a.title)}${newBadge}</p>
        <div class="pickup-meta">
          <span class="src">${escapeHtml(a.source || "ニュース")}</span>${dateStr ? " ・ " + dateStr : ""}
        </div>
      </a>`;
  }).join("");

  pickupEl.innerHTML =
    '<div class="pickup-head">注目ピックアップ' +
    '<span class="pickup-note">受賞・新蒸留所・限定など、重要度の高いニュースです。</span>' +
    '</div>' + items;
  pickupEl.hidden = false;
}

/* =========================================================
   ■ カテゴリごとの記事リストを作る
   ========================================================= */
function articlesFor(catId) {
  if (!newsData || !newsData.categories) return [];
  if (catId !== "all") {
    return (newsData.categories[catId] || []).slice();
  }
  // 「すべて」= 全カテゴリを結合し、タイトルで重複を除去して新しい順に
  const merged = [];
  const seen = new Set();
  Object.keys(newsData.categories).forEach((cid) => {
    newsData.categories[cid].forEach((a) => {
      const key = (a.title || "").trim();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(Object.assign({ _cat: cid }, a));
    });
  });
  merged.sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  return merged;
}

// カテゴリIDから表示名を引く
function catName(catId) {
  const c = CATEGORIES.find((c) => c.id === catId);
  return c ? c.name : "";
}

/* =========================================================
   ■ 改善ロジック：情報源の質 / 近似重複まとめ / 重要度 / 日付グループ
   ========================================================= */
// 信頼できるジン・スピリッツ系の有力媒体（小文字で部分一致）。同じ日付なら上位に並べる。
const REPUTABLE_SOURCES = [
  "the spirits business", "spirits business", "drinks international", "the drinks business",
  "difford", "gin magazine", "gin foundry", "master of malt", "decanter", "punch",
  "thedrinksreport", "imbibe", "vinepair", "craft gin club", "forbes", "robb report",
  "saketimes", "サケタイムズ", "dancyu", "voix", "ニュースイッチ", "酒販ニュース", "webマガジン",
];
function sourceTier(source) {
  const s = (source || "").toLowerCase();
  return REPUTABLE_SOURCES.some((r) => s.includes(r)) ? 0 : 1; // 0=有力媒体（上位）
}

// 重要度スコア（注目ピックアップ用）。受賞・新蒸留所・限定・世界一などを高く評価。
function importanceScore(a) {
  let s = 0;
  const cat = a._cat || "";
  if (cat === "award") s += 5;
  if (cat === "newdistillery") s += 4;
  if (cat === "event") s += 2;
  const t = (a.title || "") + " " + (a.originalTitle || "");
  if (/受賞|金賞|最高賞|グランプリ|世界一|日本一|world gin awards|gold|best in|trophy|winner/i.test(t)) s += 4;
  if (/新蒸留所|蒸留所.*(オープン|開業|新設|始動)|opens|grand open/i.test(t)) s += 3;
  if (/限定|数量限定|初の|世界初|国内初|first/i.test(t)) s += 2;
  if (sourceTier(a.source) === 0) s += 1;
  return s;
}

// タイトルを比較用トークンに（英語=3文字以上の単語、日本語=2文字ずつ）
function tokenize(title) {
  const t = String(title).toLowerCase()
    .replace(/[「」『』【】（）()"'’‘“”!！?？・,，.。\-—–~〜:：;\s]+/g, " ").trim();
  const tokens = new Set();
  (t.match(/[a-z0-9]{3,}/g) || []).forEach((w) => tokens.add(w));
  const jp = t.replace(/[a-z0-9 ]+/g, "");
  for (let i = 0; i < jp.length - 1; i++) tokens.add(jp.substr(i, 2));
  return tokens;
}
// 類似度（共有トークン数 / 少ない方のトークン数）
function similarity(ta, tb) {
  if (ta.size === 0 || tb.size === 0) return 0;
  const small = ta.size < tb.size ? ta : tb;
  const big = ta.size < tb.size ? tb : ta;
  let common = 0;
  small.forEach((x) => { if (big.has(x)) common++; });
  return common / small.size;
}
// 近似重複をまとめる（同じ話題を別媒体が報じたもの→1件に集約し「＋他◯媒体」）
function clusterArticles(list) {
  const reps = [], repTokens = [];
  list.forEach((a) => {
    const tk = tokenize(a.title);
    let merged = false;
    for (let i = 0; i < reps.length; i++) {
      if (similarity(tk, repTokens[i]) >= 0.6) {
        reps[i]._also = reps[i]._also || [];
        if (a.source && a.source !== reps[i].source && !reps[i]._also.includes(a.source)) {
          reps[i]._also.push(a.source);
        }
        const better = sourceTier(a.source) < sourceTier(reps[i].source) ||
          (sourceTier(a.source) === sourceTier(reps[i].source) && (a.date || "") > (reps[i].date || ""));
        if (better) {
          const also = reps[i]._also.slice();
          if (reps[i].source && reps[i].source !== a.source && !also.includes(reps[i].source)) also.push(reps[i].source);
          a._also = also.filter((s) => s !== a.source);
          reps[i] = a; repTokens[i] = tk;
        }
        merged = true;
        break;
      }
    }
    if (!merged) { reps.push(a); repTokens.push(tk); }
  });
  return reps;
}
// 情報源の質で並べ替え（同じ日付内では有力媒体→新しい順）
function sortByQuality(list) {
  return list.slice().sort((x, y) => {
    const dx = (x.date || "").slice(0, 10), dy = (y.date || "").slice(0, 10);
    if (dx !== dy) return dy.localeCompare(dx);
    const tx = sourceTier(x.source), ty = sourceTier(y.source);
    if (tx !== ty) return tx - ty;
    return (y.date || "").localeCompare(x.date || "");
  });
}
// 日付グループ名（今日 / 今週 / それ以前）
function dateBucket(iso) {
  if (!iso) return "それ以前";
  if (isNaN(new Date(iso))) return "それ以前";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  const days = Math.floor((today - d) / 86400000);
  if (days <= 0) return "今日";
  if (days <= 7) return "今週";
  return "それ以前";
}

/* =========================================================
   ■ 画面に表示する
   ========================================================= */
function showCategory(catId) {
  currentCategory = catId;
  const articles = articlesFor(catId);
  render(articles);
}

function render(articles) {
  if (!articles || articles.length === 0) {
    feedEl.innerHTML = '<div class="empty">このカテゴリのニュースはまだありません。</div>';
    statusEl.textContent = "";
    countNumEl.textContent = "0";
    return;
  }

  const showCat = currentCategory === "all"; // 「すべて」表示の時だけカテゴリ名を出す
  // 近似重複をまとめ、情報源の質で並べ替え
  const list = sortByQuality(clusterArticles(articles));

  if (showCat) {
    // 「すべて」は 今日 / 今週 / それ以前 でグループ表示
    let html = "", lastBucket = null;
    list.forEach((a) => {
      const b = dateBucket(a.date);
      if (b !== lastBucket) { html += `<div class="date-group-head">${b}</div>`; lastBucket = b; }
      html += articleCardHTML(a, true);
    });
    feedEl.innerHTML = html;
  } else {
    feedEl.innerHTML = list.map((a) => articleCardHTML(a, false)).join("");
  }

  statusEl.textContent = "新しい順に表示中";
  countNumEl.textContent = list.length;
  if (newsData && newsData.updated) {
    updatedAtEl.textContent = "更新 " + formatDate(newsData.updated);
  }
}

// 記事カード1枚のHTML（showCat=trueでカテゴリ名を表示）
function articleCardHTML(a, showCat) {
  const dateStr = a.date ? formatDate(a.date) : "";
  const cat = a._cat || currentCategory;
  const also = (a._also && a._also.length)
    ? `<span class="also-note">＋他${a._also.length}媒体</span>` : "";
  return `
    <a class="article" href="${escapeHtml(a.link)}" target="_blank" rel="noopener">
      ${showCat ? `<span class="cat">${escapeHtml(catName(cat))}</span>` : ""}
      <h3>${escapeHtml(a.title)}${isNewArticle(a) ? '<span class="new-badge">New</span>' : ""}</h3>
      ${a.originalTitle ? `<div class="orig">原題: ${escapeHtml(a.originalTitle)}</div>` : ""}
      <div class="meta">
        <span class="meta-text"><span class="src">${escapeHtml(a.source || "ニュース")}</span>${also}${dateStr ? " ・ " + dateStr : ""}</span>
        <button class="share-btn" type="button" data-link="${escapeHtml(a.link)}" data-title="${escapeHtml(a.title)}" aria-label="この記事を共有">↗ 共有</button>
      </div>
    </a>`;
}

// 日付（ISO文字列）を見やすい形にする
function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1) return "たった今";
  if (diffMin < 60) return `${diffMin}分前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}時間前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 安全のため、文字列をそのまま表示できる形に変換
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* =========================================================
   ■ タブ（カテゴリ切り替えボタン）を作る
   ========================================================= */
const tabsEl = document.getElementById("tabs");
CATEGORIES.forEach((cat, i) => {
  const btn = document.createElement("button");
  btn.className = "tab" + (i === 0 ? " active" : "");
  btn.dataset.cat = cat.id;
  btn.innerHTML = escapeHtml(cat.name) + '<span class="tab-count" data-cat="' + cat.id + '"></span>';
  btn.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    showCategory(cat.id);
  };
  tabsEl.appendChild(btn);
});

// 各タブに件数を表示（データ読み込み後に呼ぶ。近似重複まとめ後の件数）
function updateTabCounts() {
  if (!newsData) return;
  CATEGORIES.forEach((cat) => {
    const span = document.querySelector('.tab-count[data-cat="' + cat.id + '"]');
    if (!span) return;
    const n = clusterArticles(articlesFor(cat.id)).length;
    span.textContent = n ? "(" + n + ")" : "";
  });
}

// 「最新に更新」ボタン（news.jsonを取り直す）
document.getElementById("reloadBtn").onclick = () => loadData();

/* =========================================================
   ■ 記事ごとの共有ボタン
   ボタンを押すと「タイトル＋改行＋URL」をクリップボードにコピーする。
   タイトルは画面に表示しているもの＝海外記事は翻訳済みの日本語、
   日本語記事はそのまま。貼り付ければLINE等にそのまま送れる。
   feedは作り直されるので、親(feed)に1つだけ委譲リスナーを置く。
   ========================================================= */
feedEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".share-btn");
  if (!btn) return;
  e.preventDefault();   // 記事リンクへの遷移を止める
  e.stopPropagation();
  const link = btn.dataset.link || "";
  const title = btn.dataset.title || "";          // 表示中のタイトル（海外は翻訳済み）
  const text = (title ? title + "\n" : "") + link; // タイトル＋改行＋URL
  const ok = await copyText(text);
  const original = btn.textContent;
  btn.textContent = ok ? "コピー✓" : "コピー失敗";
  setTimeout(() => { btn.textContent = original; }, 1500);
});

// クリップボードへコピー（新APIが使えない環境のフォールバック付き）
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 下の方式へ */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

// 最初の読み込み
loadData();
