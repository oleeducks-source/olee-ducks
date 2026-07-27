// =====================================================================
// UTILITAIRES PARTAGÉS
// =====================================================================

export function formatFCFA(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " FCFA";
}

// Variante pour les PDF (jsPDF) : toLocaleString("fr-FR") insère une
// espace fine insécable (U+202F) comme séparateur de milliers. Les
// polices standard de jsPDF (Helvetica, encodage WinAnsi) ne savent pas
// afficher ce caractère et produisent un texte corrompu ("&2&9 /&0&0&0&
// &F&C&F&A" au lieu de "29 000 FCFA"). On utilise ici une espace normale.
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
// Profil utilisateur local : associe un prénom à chaque action (ajout,
// modification) pour savoir qui a fait quoi, à quel moment. Stocké
// uniquement sur l'appareil (pas de compte à créer).
// ---------------------------------------------------------------------
const USER_KEY = "oleeducks_user_name";

export function getUserName() {
  return localStorage.getItem(USER_KEY) || null;
}

export function setUserName(name) {
  localStorage.setItem(USER_KEY, name);
  const chip = document.getElementById("userChipLabel");
  if (chip) chip.textContent = name;
}

export function ensureUserProfile() {
  return new Promise((resolve) => {
    const existing = getUserName();
    if (existing) { resolve(existing); return; }
    openModal("Bienvenue 👋", `
      <p class="subtle">Indiquez votre prénom : il sera associé à vos ajouts et modifications, pour que toute l'équipe sache qui a fait quoi et évite les doublons.</p>
      <div class="spacer-s"></div>
      <div class="field"><label>Votre prénom</label><input type="text" id="fUserName" placeholder="ex : Aïcha"></div>
      <button class="btn yolk" id="fUserNameSave">Continuer</button>
    `, {
      dismissible: false,
      onMount: (body) => {
        const input = document.getElementById("fUserName");
        input.focus();
        const save = () => {
          const val = input.value.trim();
          if (!val) { input.focus(); return; }
          setUserName(val);
          closeModal();
          resolve(val);
        };
        document.getElementById("fUserNameSave").addEventListener("click", save);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
      }
    });
  });
}

export function promptChangeUserName() {
  const current = getUserName() || "";
  openModal("Changer de prénom", `
    <div class="field"><label>Votre prénom</label><input type="text" id="fUserNameEdit" value="${escapeHtml(current)}"></div>
    <button class="btn yolk" id="fUserNameEditSave">Enregistrer</button>
  `, {
    onMount: () => {
      const input = document.getElementById("fUserNameEdit");
      input.focus();
      document.getElementById("fUserNameEditSave").addEventListener("click", () => {
        const val = input.value.trim();
        if (!val) { input.focus(); return; }
        setUserName(val);
        toast("Prénom mis à jour ✓");
        closeModal();
      });
    }
  });
}

// ---------------------------------------------------------------------
// Masquage des montants (icône œil) — préférence purement locale à
// l'appareil, stockée en localStorage. Ne modifie jamais les données ;
// seuls les éléments marqués avec un attribut data-real (le texte réel à
// afficher) sont concernés.
// ---------------------------------------------------------------------
const BALANCE_HIDDEN_KEY = "oleeducks_balance_hidden";

export function isBalanceHidden() {
  return localStorage.getItem(BALANCE_HIDDEN_KEY) === "1";
}

function maskText(text) {
  return String(text).replace(/[0-9]/g, "•");
}

// Affiche `text` dans l'élément #id, masqué (chiffres remplacés par des
// points) si l'utilisateur a choisi de cacher les montants. Le texte
// réel est conservé dans data-real pour pouvoir re-basculer sans
// recalculer quoi que ce soit.
export function setMaskableText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.real = text;
  el.textContent = isBalanceHidden() ? maskText(text) : text;
}

// Réapplique le masquage/l'affichage sur tous les éléments marqués
// data-real de la page (utile après un changement de page ou un
// nouveau rendu Firestore).
export function refreshMaskedAmounts() {
  const hidden = isBalanceHidden();
  document.querySelectorAll("[data-real]").forEach(el => {
    el.textContent = hidden ? maskText(el.dataset.real) : el.dataset.real;
  });
}

// Branche un bouton "œil" (id fourni) qui bascule l'affichage/masquage
// de TOUS les montants marqués data-real sur la page, et persiste ce
// choix pour les prochaines ouvertures de l'app.
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
