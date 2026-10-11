// =====================================================================
// UTILITAIRES PARTAGÉS
// =====================================================================
// Ce module fournit toutes les fonctions communes (formatage, toasts,
// modales, masquage des montants, compteurs animés…).
//
// CHANGEMENT (rôles) :
// - getUserName() lit désormais le nom depuis le profil Firestore
//   courant (voir auth.js) au lieu du localStorage.
// - setUserName(), ensureUserProfile() et promptChangeUserName() sont
//   supprimées : l'identité est maintenant fixée par le compte email.
// =====================================================================

export function formatFCFA(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " FCFA";
}

// Variante pour les PDF (jsPDF) : toLocaleString("fr-FR") insère une
// espace fine insécable (U+202F) comme séparateur de milliers. Les
// polices standard de jsPDF (Helvetica, encodage WinAnsi) ne savent pas
// afficher ce caractère et produisent un texte corrompu.
export function formatFCFAPdf(n) {
  return formatFCFA(n).replace(/[\u202F\u00A0]/g, " ");
}

export function formatDate(d) {
  if (!d) return "—";
  const date = d.toDate ? d.toDate() : new Date(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(d) {
  if (!d) return "—";
  const date = d.toDate ? d.toDate() : new Date(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }) +
    " à " + date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function daysBetween(a, b) {
  const d1 = a.toDate ? a.toDate() : new Date(a);
  const d2 = b.toDate ? b.toDate() : new Date(b);
  return Math.round((d2 - d1) / 86400000);
}

export function todayInputValue() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Toast (notification éphémère en bas de l'écran)
// ---------------------------------------------------------------------
let toastTimer = null;
export function toast(msg) {
  let el = document.getElementById("toastEl");
  if (!el) {
    el = document.createElement("div");
    el.id = "toastEl";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = "none"; }, 2400);
}

// ---------------------------------------------------------------------
// Modale (bottom-sheet)
// ---------------------------------------------------------------------
export function openModal(title, bodyHtml, { onMount, dismissible = true } = {}) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal">
        <div class="modal-header">
          <h3>${title}</h3>
          ${dismissible ? `<button class="modal-close" id="modalCloseBtn">✕</button>` : `<span></span>`}
        </div>
        <div id="modalBody">${bodyHtml}</div>
      </div>
    </div>`;
  const backdrop = document.getElementById("modalBackdrop");
  if (dismissible) {
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
    document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
  }
  if (onMount) onMount(document.getElementById("modalBody"));
}

export function closeModal() {
  document.getElementById("modalRoot").innerHTML = "";
}

// ---------------------------------------------------------------------
// Identité utilisateur — branchée sur le profil Firestore (auth.js)
// ---------------------------------------------------------------------
// Cette fonction est appelée par de nombreux modules métier pour
// tracer "qui a fait quoi" (voir nids.js, inventaire.js, stocks.js…).
// Elle lit maintenant le nom depuis le profil Firestore chargé par
// auth.js, avec repli sur l'email si le nom n'est pas renseigné.
//
// Import dynamique pour éviter une dépendance circulaire : auth.js
// n'importe pas utils.js, donc cet import est sans danger.
// ---------------------------------------------------------------------
export function getUserName() {
  try {
    // Accès au profil via le module auth (import dynamique synchrone
    // impossible, donc on lit directement dans window, mis à jour par
    // app.js après chaque connexion).
    const profil = window.__oleeducks_profil_courant;
    if (profil) return profil.nom || profil.email || null;
    // Repli historique : si jamais le profil n'est pas encore chargé,
    // on cherche une ancienne valeur dans localStorage (transition).
    return localStorage.getItem("oleeducks_user_name") || null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------
// Masquage des montants (icône œil)
// ---------------------------------------------------------------------
const BALANCE_HIDDEN_KEY = "oleeducks_balance_hidden";

export function isBalanceHidden() {
  return localStorage.getItem(BALANCE_HIDDEN_KEY) === "1";
}

function maskText(text) {
  return String(text).replace(/[0-9]/g, "•");
}

export function setMaskableText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.real = text;
  el.textContent = isBalanceHidden() ? maskText(text) : text;
}

export function refreshMaskedAmounts() {
  const hidden = isBalanceHidden();
  document.querySelectorAll("[data-real]").forEach(el => {
    el.textContent = hidden ? maskText(el.dataset.real) : el.dataset.real;
  });
}

export function initEyeToggle(buttonId) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  const applyIcon = () => {
    btn.innerHTML = isBalanceHidden()
      ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.5 5.4A10.4 10.4 0 0112 5c6 0 10 7 10 7a17.3 17.3 0 01-3.2 4.1M6.6 6.6C4 8.3 2 11 2 11s4 7 10 7c1.2 0 2.4-.2 3.4-.6"/></svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
  };
  applyIcon();
  btn.addEventListener("click", () => {
    localStorage.setItem(BALANCE_HIDDEN_KEY, isBalanceHidden() ? "0" : "1");
    applyIcon();
    refreshMaskedAmounts();
  });
}

// ---------------------------------------------------------------------
// Compteurs animés
// ---------------------------------------------------------------------
export function animateCountUp(id, target, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const suffix = opts.suffix || "";
  const duration = opts.duration || 700;
  const prev = Number(el.dataset.countTarget);
  el.dataset.countTarget = String(target);
  if (prev === target) { el.textContent = target + suffix; return; }
  const start = isNaN(prev) ? 0 : prev;
  const startTime = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = Math.round(start + (target - start) * eased);
    el.textContent = current + suffix;
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = target + suffix;
  }
  requestAnimationFrame(tick);
}

export function animateBalanceCountUp(id, targetNumber) {
  const el = document.getElementById(id);
  if (!el) return;
  const realText = formatFCFA(targetNumber);
  el.dataset.real = realText;

  if (isBalanceHidden()) {
    el.textContent = maskText(realText);
    el.dataset.countTarget = String(targetNumber);
    return;
  }

  const prev = Number(el.dataset.countTarget);
  el.dataset.countTarget = String(targetNumber);
  if (prev === targetNumber) { el.textContent = realText; return; }

  if (!isNaN(prev)) {
    const wrap = el.parentElement;
    if (wrap) {
      wrap.style.position = wrap.style.position || "relative";
      const badge = document.createElement("span");
      badge.className = "balance-flash" + (targetNumber < prev ? " neg" : "");
      badge.textContent = targetNumber >= prev ? "▲" : "▼";
      wrap.appendChild(badge);
      requestAnimationFrame(() => badge.classList.add("play"));
      setTimeout(() => badge.remove(), 1400);
    }
  }

  const start = isNaN(prev) ? 0 : prev;
  const duration = 700;
  const startTime = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = Math.round(start + (targetNumber - start) * eased);
    el.textContent = formatFCFA(current);
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = realText;
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------
// Suppression avec délai d'annulation (undo toast)
// ---------------------------------------------------------------------
const idsEnSuppression = new Set();

export function estEnAttenteSuppression(id) {
  return idsEnSuppression.has(id);
}

export function confirmerSuppression(id, libelle, executerSuppression, rerender) {
  if (idsEnSuppression.has(id)) return;
  idsEnSuppression.add(id);
  if (rerender) rerender();

  const bar = document.createElement("div");
  bar.className = "undo-toast";
  bar.innerHTML = `<span>${escapeHtml(libelle)} supprimé(e)</span><button class="undo-btn">Annuler</button>`;
  document.body.appendChild(bar);
  requestAnimationFrame(() => bar.classList.add("show"));

  const retirerBar = () => {
    bar.classList.remove("show");
    setTimeout(() => bar.remove(), 250);
  };

  const timeoutId = setTimeout(async () => {
    idsEnSuppression.delete(id);
    retirerBar();
    try {
      await executerSuppression();
    } catch (e) {
      toast("Erreur lors de la suppression : " + e.message);
      if (rerender) rerender();
    }
  }, 5000);

  bar.querySelector(".undo-btn").addEventListener("click", () => {
    clearTimeout(timeoutId);
    idsEnSuppression.delete(id);
    retirerBar();
    if (rerender) rerender();
    toast("Suppression annulée");
  });
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
