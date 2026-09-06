// ---------------------------------------------------------------------------
// PUB — Intégration Meta Marketing API (compte pub unique appartenant à PUB).
//
// Note sur le choix d'architecture : un compte pub par CLIENT (chaque
// commerçant connecte sa propre Page/compte pub) demanderait l'Advanced
// Access de Meta — App Review + Business Verification (1-6 semaines,
// hors de notre contrôle). Ce module utilise donc le compte pub de PUB
// pour toutes les campagnes, ce qui fonctionne dès aujourd'hui sans
// attendre cette validation. Le jour où le vrai compte-par-client est
// nécessaire, il faudra ajouter un flux OAuth (Facebook Login for
// Business) + stockage des jetons par client — ce n'est PAS encore fait
// ici, à construire comme chantier séparé si besoin.
//
// ⚠️ IMPORTANT : ce fichier n'a pas pu être testé contre l'API Meta réelle
// dans cet environnement (pas d'accès réseau ici). La structure suit la
// documentation officielle Marketing API v23, mais les combinaisons exactes
// objective / optimization_goal / promoted_object sont strictes chez Meta et
// peuvent nécessiter un ajustement à la première vraie campagne. Teste avec
// un budget minimal (Starter, 2 900 FCFA) et regarde les erreurs retournées
// par l'API avant de brancher des budgets plus importants.
//
// Sécurité : chaque campagne créée par ce module démarre en status PAUSED.
// Rien ne se diffuse et rien n'est débité tant qu'elle n'est pas activée
// manuellement (voir activateCampaign ci-dessous).
// ---------------------------------------------------------------------------

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || 'v23.0';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID; // format: act_XXXXXXXXXXXXX
const PAGE_ID = process.env.META_PAGE_ID;

// Devises "zero-decimal" (pas de centimes) selon la norme ISO 4217 /
// documentation Meta — XOF (FCFA) en fait partie : les montants s'expriment
// dans l'unité entière, pas x100.
const ZERO_DECIMAL_CURRENCIES = new Set(['XOF', 'XAF', 'JPY', 'KRW', 'VND', 'CLP']);

export function isMetaConfigured() {
  return Boolean(ACCESS_TOKEN && AD_ACCOUNT_ID && PAGE_ID);
}

async function metaFetch(path, options = {}) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`;
  const r = await fetch(url, { ...options, headers: { ...(options.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.error_user_msg || data?.error?.message || `Meta API HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

function withToken(params) {
  return new URLSearchParams({ ...params, access_token: ACCESS_TOKEN });
}

/* ------------------------------ IMAGE ------------------------------------- */

async function uploadAdImage(buffer, mimeType) {
  const form = new FormData();
  form.append('access_token', ACCESS_TOKEN);
  form.append('bytes', buffer.toString('base64'));
  const data = await metaFetch(`${AD_ACCOUNT_ID}/adimages`, { method: 'POST', body: form });
  const first = Object.values(data.images || {})[0];
  if (!first) throw new Error("Échec de l'envoi de l'image à Meta.");
  return { hash: first.hash };
}

/* --------------------------- MAPPING OBJECTIF ------------------------------ */

function mapObjective(objective) {
  switch (objective) {
    case 'messages': return { objective: 'OUTCOME_ENGAGEMENT', optimization_goal: 'CONVERSATIONS', destination: 'whatsapp' };
    case 'commandes': return { objective: 'OUTCOME_SALES', optimization_goal: 'OFFSITE_CONVERSIONS', destination: 'whatsapp' };
    case 'site': return { objective: 'OUTCOME_TRAFFIC', optimization_goal: 'LANDING_PAGE_VIEWS', destination: 'website' };
    case 'appels': return { objective: 'OUTCOME_ENGAGEMENT', optimization_goal: 'CONVERSATIONS', destination: 'call' };
    case 'notoriete':
    case 'visibilite': return { objective: 'OUTCOME_AWARENESS', optimization_goal: 'REACH', destination: 'none' };
    default: return { objective: 'OUTCOME_ENGAGEMENT', optimization_goal: 'CONVERSATIONS', destination: 'whatsapp' };
  }
}

function budgetToMinorUnits(amountFcfa, currency = 'XOF') {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? Math.round(amountFcfa) : Math.round(amountFcfa * 100);
}

function zoneToGeoLocations() {
  return { countries: ['SN'] };
}

/* ------------------------------ CAMPAGNE ----------------------------------- */

export async function createFullCampaign({ product, adText, hashtags, imageBuffer, imageMimeType, objective, jours, prixTotal, whatsappNumber }) {
  if (!isMetaConfigured()) throw new Error('META_ACCESS_TOKEN / META_AD_ACCOUNT_ID / META_PAGE_ID manquants.');

  const map = mapObjective(objective);
  const dailyBudget = budgetToMinorUnits(Math.max(1, Math.round(prixTotal / jours)));

  const campaign = await metaFetch(`${AD_ACCOUNT_ID}/campaigns?${withToken({
    name: `PUB — ${product}`.slice(0, 100),
    objective: map.objective,
    status: 'PAUSED',
    special_ad_categories: JSON.stringify([]),
  })}`, { method: 'POST' });

  const startTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const endTime = new Date(Date.now() + jours * 24 * 60 * 60 * 1000).toISOString();

  const adsetParams = {
    name: `PUB — ${product} — audience`.slice(0, 100),
    campaign_id: campaign.id,
    daily_budget: String(dailyBudget),
    billing_event: 'IMPRESSIONS',
    optimization_goal: map.optimization_goal,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    start_time: startTime,
    end_time: endTime,
    status: 'PAUSED',
    targeting: JSON.stringify({ geo_locations: zoneToGeoLocations(), age_min: 18 }),
  };
  if (map.destination === 'whatsapp') {
    adsetParams.promoted_object = JSON.stringify({ page_id: PAGE_ID });
  }
  const adset = await metaFetch(`${AD_ACCOUNT_ID}/adsets?${withToken(adsetParams)}`, { method: 'POST' });

  const { hash } = await uploadAdImage(imageBuffer, imageMimeType);
  const linkData = {
    message: `${adText}${hashtags ? `\n\n${hashtags}` : ''}`,
    image_hash: hash,
    link: map.destination === 'whatsapp' && whatsappNumber ? `https://wa.me/${whatsappNumber.replace(/[^\d]/g, '')}` : 'https://www.facebook.com/',
    call_to_action: {
      type: map.destination === 'whatsapp' ? 'WHATSAPP_MESSAGE' : map.destination === 'call' ? 'CALL_NOW' : 'LEARN_MORE',
    },
  };
  const creative = await metaFetch(`${AD_ACCOUNT_ID}/adcreatives?${withToken({
    name: `PUB — ${product} — création`.slice(0, 100),
    object_story_spec: JSON.stringify({ page_id: PAGE_ID, link_data: linkData }),
  })}`, { method: 'POST' });

  const ad = await metaFetch(`${AD_ACCOUNT_ID}/ads?${withToken({
    name: `PUB — ${product}`.slice(0, 100),
    adset_id: adset.id,
    creative: JSON.stringify({ creative_id: creative.id }),
    status: 'PAUSED',
  })}`, { method: 'POST' });

  return { campaignId: campaign.id, adSetId: adset.id, adId: ad.id, status: 'PAUSED' };
}

/* --------------------------- ACTIVATION MANUELLE --------------------------- */

export async function activateCampaign(campaignId) {
  if (!isMetaConfigured()) throw new Error('Meta non configuré.');
  return metaFetch(`${campaignId}?${withToken({ status: 'ACTIVE' })}`, { method: 'POST' });
}

export async function pauseCampaign(campaignId) {
  if (!isMetaConfigured()) throw new Error('Meta non configuré.');
  return metaFetch(`${campaignId}?${withToken({ status: 'PAUSED' })}`, { method: 'POST' });
}
