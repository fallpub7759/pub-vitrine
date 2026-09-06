// ---------------------------------------------------------------------------
// PUB — Intégration Snapchat Marketing API.
//
// ⚠️ IMPORTANT : comme pour Meta et TikTok, ce module n'a pas pu être testé
// contre l'API Snapchat réelle dans cet environnement (pas d'accès réseau
// ici). Structure basée sur la documentation Snap Marketing API (v1) — à
// vérifier sur marketingapi.snapchat.com/docs au moment de brancher. Snap a
// l'avantage d'un budget minimum bien plus bas que TikTok (5 $/jour
// techniquement, ~30-50 $/jour recommandé pour de vrais résultats).
//
// Prérequis côté Snap (aucun code, juste des étapes sur leur site) :
// 1. business.snapchat.com → créer un Business Manager.
// 2. ads.snapchat.com → créer un compte publicitaire, y attacher un moyen
//    de paiement (carte internationale).
// 3. Sur marketingapi.snapchat.com → créer une App OAuth2, obtenir Client ID
//    + Secret, générer un access token + refresh token pour ton propre
//    compte pub (pas de review nécessaire pour gérer ton propre compte).
//
// Sécurité : Snap impose un champ "status" explicite sur chaque niveau
// (campagne, ad squad, annonce) — tout est créé en status PAUSED ici. Rien
// ne se diffuse tant que ce n'est pas activé manuellement.
// ---------------------------------------------------------------------------

const API_BASE = 'https://adsapi.snapchat.com/v1';
let cachedAccessToken = process.env.SNAP_ACCESS_TOKEN; // jeton initial ; se rafraîchit via refresh token si fourni
const REFRESH_TOKEN = process.env.SNAP_REFRESH_TOKEN;
const CLIENT_ID = process.env.SNAP_CLIENT_ID;
const CLIENT_SECRET = process.env.SNAP_CLIENT_SECRET;
const AD_ACCOUNT_ID = process.env.SNAP_AD_ACCOUNT_ID;
const PROFILE_ID = process.env.SNAP_PUBLIC_PROFILE_ID; // profil Snapchat au nom duquel la pub est diffusée

export function isSnapConfigured() {
  return Boolean((cachedAccessToken || REFRESH_TOKEN) && AD_ACCOUNT_ID && PROFILE_ID);
}

async function refreshAccessTokenIfNeeded() {
  if (cachedAccessToken || !REFRESH_TOKEN || !CLIENT_ID || !CLIENT_SECRET) return;
  const r = await fetch('https://accounts.snapchat.com/login/oauth2/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error_description || 'Échec du rafraîchissement du jeton Snap.');
  cachedAccessToken = data.access_token;
}

async function snapFetch(path, options = {}) {
  await refreshAccessTokenIfNeeded();
  const r = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${cachedAccessToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.debug_message || data?.request_status || `Snap API HTTP ${r.status}`);
  return data;
}

/* --------------------------- MAPPING OBJECTIF ------------------------------ */

function mapObjective(objective) {
  switch (objective) {
    case 'messages': return { optimization_goal: 'ENGAGEMENT' };
    case 'commandes': return { optimization_goal: 'PIXEL_PURCHASE' };
    case 'site': return { optimization_goal: 'SWIPES' };
    case 'appels': return { optimization_goal: 'ENGAGEMENT' };
    case 'notoriete':
    case 'visibilite': return { optimization_goal: 'IMPRESSIONS' };
    default: return { optimization_goal: 'SWIPES' };
  }
}

// Snap facture en micro-dollars/micro-devise (valeur x 1 000 000) dans ses
// API — convention différente de Meta/TikTok, à bien respecter.
const toMicroUnits = (amount) => Math.round(amount * 1_000_000);

/* ------------------------------ IMAGE ------------------------------------- */

async function uploadMedia(buffer, mimeType) {
  const created = await snapFetch(`/adaccounts/${AD_ACCOUNT_ID}/media`, {
    method: 'POST',
    body: JSON.stringify({ media: [{ name: 'pub-creative', type: 'IMAGE', ad_account_id: AD_ACCOUNT_ID }] }),
  });
  const mediaId = created.media?.[0]?.media?.id;
  if (!mediaId) throw new Error("Échec de la création du média Snap.");

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), 'photo.jpg');
  await refreshAccessTokenIfNeeded();
  const r = await fetch(`${API_BASE}/media/${mediaId}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cachedAccessToken}` },
    body: form,
  });
  if (!r.ok) throw new Error("Échec de l'envoi de l'image à Snap.");
  return mediaId;
}

/* ------------------------------ CAMPAGNE ----------------------------------- */

export async function createFullCampaign({ product, adText, imageBuffer, imageMimeType, objective, jours, prixTotal }) {
  if (!isSnapConfigured()) throw new Error('SNAP_ACCESS_TOKEN (ou refresh token) / SNAP_AD_ACCOUNT_ID / SNAP_PUBLIC_PROFILE_ID manquants.');

  const map = mapObjective(objective);
  const dailyBudget = Math.max(5, Math.round(prixTotal / jours / 590)); // conversion FCFA -> $ approximative

  // 1. Campagne (PAUSED)
  const startTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const endTime = new Date(Date.now() + jours * 24 * 60 * 60 * 1000).toISOString();
  const campaignRes = await snapFetch(`/adaccounts/${AD_ACCOUNT_ID}/campaigns`, {
    method: 'POST',
    body: JSON.stringify({ campaigns: [{
      name: `PUB — ${product}`.slice(0, 100),
      ad_account_id: AD_ACCOUNT_ID,
      status: 'PAUSED',
      start_time: startTime,
      end_time: endTime,
    }] }),
  });
  const campaignId = campaignRes.campaigns?.[0]?.campaign?.id;

  // 2. Ad Squad (ciblage + budget)
  const squadRes = await snapFetch('/adsquads', {
    method: 'POST',
    body: JSON.stringify({ adsquads: [{
      name: `PUB — ${product} — audience`.slice(0, 100),
      campaign_id: campaignId,
      type: 'SNAP_ADS',
      status: 'PAUSED',
      targeting: { geos: [{ country_code: 'sn' }] },
      daily_budget_micro: toMicroUnits(dailyBudget),
      start_time: startTime,
      end_time: endTime,
      billing_event: 'IMPRESSION',
      optimization_goal: map.optimization_goal,
      bid_strategy: 'AUTO_BID',
    }] }),
  });
  const adSquadId = squadRes.adsquads?.[0]?.adsquad?.id;

  // 3. Image + création publicitaire
  const mediaId = await uploadMedia(imageBuffer, imageMimeType);
  const creativeRes = await snapFetch(`/adaccounts/${AD_ACCOUNT_ID}/creatives`, {
    method: 'POST',
    body: JSON.stringify({ creatives: [{
      name: `PUB — ${product} — création`.slice(0, 100),
      ad_account_id: AD_ACCOUNT_ID,
      type: 'SNAP_AD',
      top_snap_media_id: mediaId,
      headline: adText.slice(0, 34), // Snap limite le headline à 34 caractères
      call_to_action: 'MESSAGE',
    }] }),
  });
  const creativeId = creativeRes.creatives?.[0]?.creative?.id;

  // 4. Publicité finale (PAUSED)
  const adRes = await snapFetch('/ads', {
    method: 'POST',
    body: JSON.stringify({ ads: [{
      name: `PUB — ${product}`.slice(0, 100),
      ad_squad_id: adSquadId,
      creative_id: creativeId,
      status: 'PAUSED',
    }] }),
  });

  return { campaignId, adSquadId, adId: adRes.ads?.[0]?.ad?.id, status: 'PAUSED' };
}

/* --------------------------- ACTIVATION MANUELLE --------------------------- */

export async function activateCampaign(campaignId) {
  if (!isSnapConfigured()) throw new Error('Snap non configuré.');
  return snapFetch(`/campaigns/${campaignId}`, { method: 'PUT', body: JSON.stringify({ campaigns: [{ id: campaignId, status: 'ACTIVE' }] }) });
}

export async function pauseCampaign(campaignId) {
  if (!isSnapConfigured()) throw new Error('Snap non configuré.');
  return snapFetch(`/campaigns/${campaignId}`, { method: 'PUT', body: JSON.stringify({ campaigns: [{ id: campaignId, status: 'PAUSED' }] }) });
}
