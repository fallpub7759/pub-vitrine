// ---------------------------------------------------------------------------
// PUB — Intégration TikTok Marketing API.
//
// ⚠️ IMPORTANT : comme pour Meta, ce module n'a pas pu être testé contre
// l'API TikTok réelle dans cet environnement (pas d'accès réseau ici). La
// structure suit la documentation TikTok Business API (v1.3), mais certains
// noms de champs évoluent régulièrement chez TikTok — vérifie sur
// business-api.tiktok.com/portal/docs au moment de brancher, et teste avec
// le budget minimum (50 $/jour, seuil imposé par TikTok) avant de monter en
// budget.
//
// Prérequis côté TikTok (aucun code, juste des étapes sur leur site) :
// 1. Créer un compte sur business-api.tiktok.com (TikTok for Business).
// 2. Créer une "App" (Développeur), obtenir App ID + Secret.
// 3. Lier cette App à ton compte publicitaire TikTok (Advertiser ID).
// 4. Générer un access token scopé à ton propre compte pub (pas de review
//    nécessaire tant que tu gères uniquement ton propre compte).
//
// Sécurité : toute campagne/ad group/annonce créée par ce module démarre en
// operation_status DISABLE (l'équivalent TikTok de "PAUSED"). Rien ne se
// diffuse tant que tu ne l'actives pas manuellement.
// ---------------------------------------------------------------------------

const API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';
const ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const ADVERTISER_ID = process.env.TIKTOK_ADVERTISER_ID;
const IDENTITY_ID = process.env.TIKTOK_IDENTITY_ID; // identité (profil TikTok) au nom de laquelle la pub est diffusée

export function isTikTokConfigured() {
  return Boolean(ACCESS_TOKEN && ADVERTISER_ID && IDENTITY_ID);
}

async function tiktokFetch(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Access-Token': ACCESS_TOKEN },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data.code && data.code !== 0)) {
    throw new Error(data?.message || `TikTok API HTTP ${r.status}`);
  }
  return data.data;
}

/* --------------------------- MAPPING OBJECTIF ------------------------------ */

function mapObjective(objective) {
  switch (objective) {
    case 'messages': return { objective_type: 'ENGAGEMENT', optimization_goal: 'CONVERSATION' };
    case 'commandes': return { objective_type: 'PRODUCT_SALES', optimization_goal: 'CONVERT' };
    case 'site': return { objective_type: 'TRAFFIC', optimization_goal: 'CLICK' };
    case 'appels': return { objective_type: 'ENGAGEMENT', optimization_goal: 'CONVERSATION' };
    case 'notoriete':
    case 'visibilite': return { objective_type: 'REACH', optimization_goal: 'REACH' };
    default: return { objective_type: 'ENGAGEMENT', optimization_goal: 'CONVERSATION' };
  }
}

// TikTok exprime les budgets dans l'unité entière du compte (pas de x100),
// mais impose un minimum de 50 $/jour (~30 000 FCFA/jour) — plancher fixe
// de la plateforme, indépendant de la devise du compte.
const TIKTOK_MIN_DAILY_BUDGET_USD_EQUIVALENT = 50;

/* ------------------------------ IMAGE ------------------------------------- */

async function uploadImage(buffer, mimeType) {
  const form = new FormData();
  form.append('advertiser_id', ADVERTISER_ID);
  form.append('upload_type', 'UPLOAD_BY_FILE');
  form.append('image_file', new Blob([buffer], { type: mimeType }), 'photo.jpg');
  const r = await fetch(`${API_BASE}/file/image/ad/upload/`, {
    method: 'POST',
    headers: { 'Access-Token': ACCESS_TOKEN },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data.code && data.code !== 0)) throw new Error(data?.message || "Échec de l'envoi de l'image à TikTok.");
  return data.data.image_id;
}

/* ------------------------------ CAMPAGNE ----------------------------------- */

export async function createFullCampaign({ product, adText, imageBuffer, imageMimeType, objective, jours, prixTotal, dailyBudgetFcfa }) {
  if (!isTikTokConfigured()) throw new Error('TIKTOK_ACCESS_TOKEN / TIKTOK_ADVERTISER_ID / TIKTOK_IDENTITY_ID manquants.');
  if (dailyBudgetFcfa < TIKTOK_MIN_DAILY_BUDGET_USD_EQUIVALENT * 590) {
    // 590 FCFA/$ est une estimation — vérifie le taux réel avant de bloquer un vrai client sur ce seuil.
    throw new Error(`Budget quotidien trop bas pour TikTok (minimum plateforme ≈ 50 $/jour, soit ~30 000 FCFA/jour).`);
  }

  const map = mapObjective(objective);

  // 1. Campagne (désactivée par sécurité)
  const campaign = await tiktokFetch('/campaign/create/', {
    advertiser_id: ADVERTISER_ID,
    campaign_name: `PUB — ${product}`.slice(0, 100),
    objective_type: map.objective_type,
    budget_mode: 'BUDGET_MODE_INFINITE', // le budget réel est porté par l'ad group, pas la campagne
    operation_status: 'DISABLE',
  });

  // 2. Ad Group (ciblage + budget + calendrier)
  const startTime = new Date(Date.now() + 5 * 60 * 1000);
  const endTime = new Date(Date.now() + jours * 24 * 60 * 60 * 1000);
  const adgroup = await tiktokFetch('/adgroup/create/', {
    advertiser_id: ADVERTISER_ID,
    campaign_id: campaign.campaign_id,
    adgroup_name: `PUB — ${product} — audience`.slice(0, 100),
    placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
    location_ids: ['5866'], // Sénégal — code de localisation TikTok, à reconfirmer dans leur outil de ciblage
    budget_mode: 'BUDGET_MODE_DAY',
    budget: dailyBudgetFcfa,
    schedule_type: 'SCHEDULE_START_END',
    schedule_start_time: startTime.toISOString().slice(0, 19),
    schedule_end_time: endTime.toISOString().slice(0, 19),
    optimization_goal: map.optimization_goal,
    billing_event: 'CPM',
    operation_status: 'DISABLE',
  });

  // 3. Image + création publicitaire
  const imageId = await uploadImage(imageBuffer, imageMimeType);
  const ad = await tiktokFetch('/ad/create/', {
    advertiser_id: ADVERTISER_ID,
    adgroup_id: adgroup.adgroup_id,
    creatives: [{
      ad_name: `PUB — ${product}`.slice(0, 100),
      ad_text: adText.slice(0, 100),
      identity_id: IDENTITY_ID,
      identity_type: 'CUSTOMIZED_USER',
      image_ids: [imageId],
      call_to_action: 'CONTACT_US',
    }],
    operation_status: 'DISABLE',
  });

  return { campaignId: campaign.campaign_id, adGroupId: adgroup.adgroup_id, adId: ad.ad_ids?.[0], status: 'DISABLE' };
}

/* --------------------------- ACTIVATION MANUELLE --------------------------- */

export async function activateCampaign(campaignId) {
  if (!isTikTokConfigured()) throw new Error('TikTok non configuré.');
  return tiktokFetch('/campaign/update/status/', {
    advertiser_id: ADVERTISER_ID, campaign_ids: [campaignId], operation_status: 'ENABLE',
  });
}

export async function pauseCampaign(campaignId) {
  if (!isTikTokConfigured()) throw new Error('TikTok non configuré.');
  return tiktokFetch('/campaign/update/status/', {
    advertiser_id: ADVERTISER_ID, campaign_ids: [campaignId], operation_status: 'DISABLE',
  });
}
