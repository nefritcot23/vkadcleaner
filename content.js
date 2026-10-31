(() => {
  "use strict";
  if (window.__vkAdCleanerLoaded) return;
  window.__vkAdCleanerLoaded = true;

  const DEFAULTS = { enabled: true, domains: ["ozon.ru"], learningEnabled: true, showTrainingControls: true, samples: [] };
  const HIDDEN = "vkac-hidden-post", PLACEHOLDER = "vkac-placeholder", TOOLBAR = "vkac-trainbar";
  // VK's current feed exposes one stable card root per publication.
  // Do not use nested content containers, feed wrappers or data-post-id:
  // those can match several levels of the same post or the whole feed.
  const POST_SELECTOR = '[data-testid="post"]';
  let settings = { ...DEFAULTS }, timer = null;
  const hidden = new Map();
  const norm = value => String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#:\s"'<>()[\]{}]+/)[0].replace(/[.,;!?]+$/, "");
  const uniq = arr => [...new Set(arr.filter(Boolean))];

  function hostFrom(value) {
    const found = [];
    let raw = String(value || "").trim();
    for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(raw.replace(/\+/g, "%20")); if (d === raw) break; raw = d; } catch (_) { break; } }
    const candidates = raw.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?(?:\/[^\s"'<>]*)?/ig) || [];
    for (const c of candidates) {
      try {
        const u = new URL(c.startsWith("http") ? c : "https://" + c); found.push(u.hostname.toLowerCase());
        for (const [k, v] of u.searchParams) if (/^(to|url|target|redirect|redirect_url|r)$/i.test(k)) found.push(...hostFrom(v));
      } catch (_) {}
    }
    try { const u = new URL(raw.startsWith("http") ? raw : "https://" + raw); for (const [k, v] of u.searchParams) if (/^(to|url|target|redirect|redirect_url|r)$/i.test(k)) found.push(...hostFrom(v)); } catch (_) {}
    return uniq(found);
  }
  function matches(host) {
    const h = norm(host);
    return settings.domains.some(v => { const d = norm(v); return d && (h === d || h.endsWith("." + d)); });
  }
  function isVkShort(value) { return /(?:^|[/:.])vk\.cc(?:[/:?#]|$)/i.test(String(value || "")); }
  function features(card) {
    const copy = card.cloneNode(true);
    copy.querySelectorAll("." + TOOLBAR + ", .vkac-toast").forEach(el => el.remove());
    const text = (copy.innerText || copy.textContent || "").toLowerCase().slice(0, 7000);
    const els = [copy, ...copy.querySelectorAll("a, [href], [data-url], [data-href], [data-link], [data-testid], button")];
    const urls = [], classes = [], testids = [];
    for (const el of els) {
      for (const attr of ["href", "data-url", "data-href", "data-link", "data-target", "data-external-url"]) {
        const v = el.getAttribute && el.getAttribute(attr); if (v) urls.push(v);
      }
      if (el.className && typeof el.className === "string") classes.push(...el.className.split(/\s+/).filter(x => x.length > 2).slice(0, 5));
      const tid = el.getAttribute && el.getAttribute("data-testid"); if (tid) testids.push(tid);
    }
    const hosts = uniq(urls.flatMap(hostFrom));
    const tokens = uniq((text.match(/[a-zа-яё0-9]{3,}/gi) || []).filter(t => !/^\d+$/.test(t))).slice(0, 160);
    const cta = /купить|заказать|перейти на|оформить|промокод|скидк|по ссылке|реклама|реклам|партн[её]рск|товар дня|цена|в наличии/.test(text);
    const vkcc = urls.some(isVkShort) || /vk\.cc\//i.test(text);
    const external = hosts.filter(h => !/(^|\.)vk\.(com|ru|me)$/.test(h));
    const structure = uniq([...classes, ...testids]).slice(0, 80);
    return { tokens, hosts, external, structure, flags: { cta, vkcc, video: !!card.querySelector("video"), images: card.querySelectorAll("img").length > 0, button: !!card.querySelector("button") } };
  }
  function similarity(a, b) {
    const jaccard = (x, y) => { const A = new Set(x || []), B = new Set(y || []); if (!A.size && !B.size) return 0; let n = 0; for (const v of A) if (B.has(v)) n++; return n / (A.size + B.size - n || 1); };
    let score = jaccard(a.tokens, b.tokens) * .24 + jaccard(a.hosts, b.hosts) * .34 + jaccard(a.structure, b.structure) * .12;
    if ((a.external || []).some(h => (b.external || []).includes(h))) score += .22;
    for (const k of ["cta", "vkcc", "video", "images", "button"]) if (a.flags?.[k] && b.flags?.[k]) score += k === "vkcc" ? .12 : .025;
    return Math.min(1, score);
  }
  function predict(f) {
    const samples = settings.samples || [];
    const ads = samples.filter(s => s.label === 1), clean = samples.filter(s => s.label === 0);
    if (!settings.learningEnabled || ads.length < 2 || clean.length < 2) return null;
    const bestAd = Math.max(0, ...ads.map(s => similarity(f, s.features)));
    const bestClean = Math.max(0, ...clean.map(s => similarity(f, s.features)));
    // Conservative: hide only when a close positive example exists and beats negatives clearly.
    if (bestAd >= .76 && bestAd - bestClean >= .18) return { label: 1, confidence: bestAd, bestClean };
    return null;
  }
  function storeSample(card, label) {
    const sample = { label, features: features(card), at: Date.now() };
    const samples = [...(settings.samples || []), sample].slice(-500);
    settings.samples = samples;
    chrome.storage.local.set({ samples }, () => {
      if (chrome.runtime.lastError) console.warn("[VK Ad Cleaner]", chrome.runtime.lastError.message);
      showToast(card, label ? "Пример рекламы сохранён" : "Пример обычного поста сохранён");
    });
  }
  function showToast(card, message) {
    const el = document.createElement("div"); el.className = "vkac-toast"; el.textContent = message;
    card.append(el); setTimeout(() => el.remove(), 2200);
  }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]); }
  function replaceCard(card, reason) {
    if (!card || card.classList.contains(HIDDEN) || card.dataset.vkacProcessed === "1") return;
    const id = "vkac-" + Math.random().toString(36).slice(2);
    const note = document.createElement("div"); note.className = PLACEHOLDER; note.dataset.vkacId = id;
    note.innerHTML = `<div class="vkac-check">✓</div><div class="vkac-copy"><strong>Реклама скрыта</strong><span>${escapeHtml(reason || "Определено по вашим примерам")}</span><small>Решение принято локально в вашем браузере.</small></div><button type="button">Показать пост</button>`;
    note.querySelector("button").addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      // Respect the user's manual override for this exact DOM card.
      // MutationObserver will rescan the feed, but must not hide it again.
      card.dataset.vkacUserRevealed = "1";
      card.classList.remove(HIDDEN);
      card.dataset.vkacProcessed = "0";
      note.remove();
      hidden.delete(id);
    });
    card.before(note); card.classList.add(HIDDEN); card.dataset.vkacProcessed = "1"; hidden.set(id, { card, note });
  }
  function addTrainingBar(card) {
    if (card.querySelector(":scope > ." + TOOLBAR) || card.dataset.vkacProcessed === "1" || card.dataset.vkacTrained === "1") return;
    const bar = document.createElement("div"); bar.className = TOOLBAR;
    const label = document.createElement("span"); label.textContent = "Помоги фильтру:";
    const ad = document.createElement("button"); ad.type = "button"; ad.textContent = "Это реклама"; ad.className = "vkac-ad";
    const clean = document.createElement("button"); clean.type = "button"; clean.textContent = "Обычный пост"; clean.className = "vkac-clean";
    ad.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); storeSample(card, 1); replaceCard(card, "Отмечено вами как реклама"); });
    clean.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); storeSample(card, 0); card.dataset.vkacTrained = "1"; bar.remove(); });
    bar.append(label, ad, clean); card.append(bar);
  }
  function detectLegacy(card) {
    const f = features(card); const matched = f.hosts.filter(matches);
    if (matched.length) return matched;
    // Do not infer the destination from vk.cc alone; require explicit brand wording.
    const text = (card.innerText || "").toLowerCase();
    if (f.flags.vkcc) for (const d of settings.domains) {
      const brand = norm(d).split(".")[0];
      if (brand && new RegExp("(?:перейти\\s+на|на\\s+сайт|купить\\s+на)\\s+" + brand.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&"), "i").test(text)) matched.push(d);
    }
    return uniq(matched);
  }
  function getCard(root) {
    return root.matches?.(POST_SELECTOR) ? root : root.closest?.(POST_SELECTOR) || null;
  }
  function scan() {
    timer = null; if (!settings.enabled) return;
    // Only train on actual post roots. Never attach controls to the feed,
    // navigation, sidebars, nested post-content containers or arbitrary links.
    const candidates = document.querySelectorAll(POST_SELECTOR);
    for (const card of candidates) {
      if (!card.isConnected || card.closest("." + PLACEHOLDER) || card.classList.contains(HIDDEN) || card.dataset.vkacUserRevealed === "1") continue;
      if (settings.showTrainingControls) addTrainingBar(card); else card.querySelectorAll(":scope > ." + TOOLBAR).forEach(el => el.remove());
      const f = features(card), learned = predict(f);
      if (learned) { replaceCard(card, `Похоже на отмеченную рекламу (${Math.round(learned.confidence * 100)}%)`); continue; }
      const legacy = detectLegacy(card); if (legacy.length) replaceCard(card, `Найдена ссылка: ${legacy.join(", ")}`);
    }
  }
  function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(scan, 300); }
  function apply(next) {
    settings = { enabled: next.enabled !== false, domains: Array.isArray(next.domains) ? next.domains.map(norm).filter(Boolean) : DEFAULTS.domains,
      learningEnabled: next.learningEnabled !== false, showTrainingControls: next.showTrainingControls !== false, samples: Array.isArray(next.samples) ? next.samples : [] };
    if (!settings.enabled) { for (const item of hidden.values()) { item.card.classList.remove(HIDDEN); item.card.dataset.vkacProcessed = "0"; item.note.remove(); } hidden.clear(); }
    else schedule();
  }
  chrome.storage.local.get(DEFAULTS, value => { if (!chrome.runtime.lastError) apply(value); });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local") chrome.storage.local.get(DEFAULTS, apply); });
  const observer = new MutationObserver(ms => { if (ms.some(m => m.addedNodes.length || m.type === "characterData" || m.type === "attributes")) schedule(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "data-url", "data-href", "data-link", "data-target", "title"] });
  let last = location.href; setInterval(() => { if (location.href !== last) { last = location.href; schedule(); } }, 1000);
})();
