// Olee Ducks — Valorisation du cheptel (lecture seule pour Firestore).
import { getActiveDuckCounts } from "./inventaire.js";
import { openModal, toast } from "./utils.js";

const KEY = "oleeducks_prix_vente_categories_v1";
const CATEGORIES = [
  ["caneton", "Canetons"],
  ["reproducteur_male", "Reproducteurs mâles"],
  ["reproducteur_femelle", "Reproductrices femelles"],
  ["canard", "Canards"],
  ["canardeau", "Canardeaux"],
  ["canne", "Cannes"]
];

let prices = {};
try { prices = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) { prices = {}; }

const money = n => `${Math.round(Number(n) || 0).toLocaleString("fr-FR")} FCFA`;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function render() {
  const counts = getActiveDuckCounts();
  const rows = CATEGORIES.map(([key, label]) => {
    const qty = Number(counts[key] || 0);
    const price = Number(prices[key] || 0);
    return `<div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
      <div class="row-main" style="min-width:150px"><span class="row-title">${label}</span><span class="row-sub">${qty} sujet(s) actif(s)</span></div>
      <input class="input" data-price="${key}" type="number" min="0" step="50" value="${price || ""}" placeholder="Prix unitaire" style="width:145px" aria-label="Prix de vente unitaire ${esc(label)}">
      <strong style="min-width:120px;text-align:right" id="total-${key}">${money(qty * price)}</strong>
    </div>`;
  }).join("");
  openModal("Évaluation du cheptel", `<p class="subtle">Saisissez votre prix de vente unitaire par catégorie. Les quantités proviennent uniquement des sujets actifs de l'inventaire. Les prix sont enregistrés sur cet appareil et aucune donnée Firestore n'est modifiée.</p>
    <div class="card" id="valorisationRows">${rows}</div>
    <div class="balance-banner" style="margin-top:14px"><div class="kpi-label">Valeur totale estimée du cheptel</div><div class="amount" id="valorisationTotal">${money(0)}</div><div class="subtle" style="color:inherit;opacity:.8">Valeur théorique si tous les sujets étaient vendus aux prix indiqués.</div></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button class="btn secondary" id="resetValorisation">Réinitialiser</button><button class="btn primary" id="saveValorisation">Enregistrer les prix</button></div>`, { onMount: () => {
      const update = () => {
        let total = 0;
        CATEGORIES.forEach(([key]) => {
          const input = document.querySelector(`[data-price="${key}"]`);
          const qty = Number(counts[key] || 0);
          const value = Math.max(0, Number(input?.value || 0));
          total += qty * value;
          const target = document.getElementById(`total-${key}`);
          if (target) target.textContent = money(qty * value);
        });
        const el = document.getElementById("valorisationTotal");
        if (el) el.textContent = money(total);
      };
      document.querySelectorAll("[data-price]").forEach(el => el.addEventListener("input", update));
      document.getElementById("saveValorisation")?.addEventListener("click", () => {
        CATEGORIES.forEach(([key]) => { prices[key] = Math.max(0, Number(document.querySelector(`[data-price="${key}"]`)?.value || 0)); });
        localStorage.setItem(KEY, JSON.stringify(prices));
        toast("Prix de vente enregistrés sur cet appareil.");
        update();
      });
      document.getElementById("resetValorisation")?.addEventListener("click", () => {
        CATEGORIES.forEach(([key]) => { prices[key] = 0; const el = document.querySelector(`[data-price="${key}"]`); if (el) el.value = ""; });
        update();
      });
      update();
    }});
}

export function initValorisation() {
  document.getElementById("openValorisationBtn")?.addEventListener("click", render);
}
