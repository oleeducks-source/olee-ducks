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
