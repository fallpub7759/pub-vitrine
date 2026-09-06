// ---------------------------------------------------------------------------
// PUB — Webhook WhatsApp Cloud API (branchement réel du parcours conçu dans
// workflow-whatsapp.html : produit / page / compte, canaux Facebook+Instagram,
// Snapchat, TikTok).
//
// RÉEL ici : réception/envoi de messages WhatsApp, analyse de photo et
// génération de la publicité par IA (OpenAI), sessions persistées.
// SIMULÉ (comme dans la démo du site) : connexion de Page/compte, paiement,
// diffusion effective sur les régies publicitaires. À brancher plateforme
// par plateforme quand les accès (Meta Ads, TikTok Ads, Snap Ads) seront prêts.
// ---------------------------------------------------------------------------

import { getStore } from '@netlify/blobs';
import { isMetaConfigured, createFullCampaign as createMetaCampaign } from './_lib/meta.mjs';
import { isTikTokConfigured, createFullCampaign as createTikTokCampaign } from './_lib/tiktok.mjs';
import { isSnapConfigured, createFullCampaign as createSnapCampaign } from './_lib/snap.mjs';

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';

const PLANS = [
  { id: 'plan_0', label: '🚀 Starter', jours: 3, prix: 2900 },
  { id: 'plan_1', label: '🔥 Essentiel', jours: 5, prix: 4500 },
  { id: 'plan_2', label: '⭐ Performance', jours: 7, prix: 6500 },
  { id: 'plan_3', label: '📈 Croissance', jours: 15, prix: 12990 },
  { id: 'plan_4', label: '🏆 Business', jours: 30, prix: 24990 },
];

const OBJECTIFS_PRODUCT = [
  { id: 'obj_commandes', title: '🛒 Commandes' },
  { id: 'obj_messages', title: '💬 Messages' },
  { id: 'obj_site', title: '🌐 Visites site' },
  { id: 'obj_appels', title: '📞 Appels' },
  { id: 'obj_notoriete', title: '👥 Abonnés / notoriété' },
  { id: 'obj_auto', title: '🎯 PUB choisit' },
];

const OBJECTIFS_PAGE = [
  { id: 'obj_notoriete', title: '👥 Gagner des abonnés' },
  { id: 'obj_visibilite', title: '👀 Augmenter la visibilité' },
  { id: 'obj_commandes', title: '🛒 Promouvoir une offre' },
];

const OBJECTIFS_ACCOUNT = [
  { id: 'obj_notoriete', title: '👥 Gagner des abonnés' },
  { id: 'obj_visibilite', title: '👀 Augmenter la visibilité' },
];

const OBJ_LABELS = {
  commandes: 'Commandes', messages: 'Messages', site: 'Visites site', appels: 'Appels',
  notoriete: 'Abonnés / notoriété', visibilite: 'Visibilité', auto: 'PUB choisit',
};

const fcfa = (n) => `${Number(n).toLocaleString('fr-FR').replace(/,/g, ' ')} FCFA`;
const channelLabel = (c) => (c === 'meta' ? 'Facebook + Instagram' : c === 'snap' ? 'Snapchat' : 'TikTok');

/* ------------------------------- SESSIONS -------------------------------- */

const sessionStore = () => getStore({ name: 'pub-whatsapp-sessions', consistency: 'strong' });

async function getSession(waId) {
  const raw = await sessionStore().get(waId, { type: 'json' });
  return raw || newSession();
}
async function saveSession(waId, session) {
  await sessionStore().setJSON(waId, session);
}
function newSession() {
  return {
    step: 'menu', kind: null, channel: null, accountConnected: false,
    mediaId: null, product: null, price: null, objective: null,
    phone: null, site: null, zone: null, planId: null, ad: null, launchedAt: null,
  };
}

/* ---------------------------- OPENAI HELPERS ------------------------------ */

async function openAIResponse(input, maxOutputTokens = 500) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY n'est pas configurée sur Netlify.");
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const r = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input, max_output_tokens: maxOutputTokens }),
      signal: controller.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error?.message || `OpenAI API HTTP ${r.status}`);
    const outputText =
      data.output_text ||
      data.output?.flatMap((x) => x.content || []).filter((x) => x.type === 'output_text').map((x) => x.text).join('') ||
      '';
    if (!outputText) throw new Error("OpenAI n'a renvoyé aucun texte.");
    return outputText;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonText(text) {
  try { return JSON.parse(text.trim()); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Réponse IA invalide.');
    return JSON.parse(m[0]);
  }
}

async function analyzeProductImage(imageDataUrl) {
  const input = [{
    role: 'user',
    content: [
      { type: 'input_text', text: [
        'Analyse cette photo de produit pour une publicité au Sénégal.',
        'Réponds UNIQUEMENT avec un JSON valide contenant: product, price (nombre FCFA estimé ou vide).',
        "N'invente pas un prix si aucun indice n'est visible — laisse price vide.",
      ].join('\n') },
      { type: 'input_image', image_url: imageDataUrl },
    ],
  }];
  const parsed = parseJsonText(await openAIResponse(input, 250));
  return {
    product: String(parsed.product || 'Produit').trim(),
    price: parsed.price ? Number(String(parsed.price).replace(/[^\d]/g, '')) || 0 : 0,
  };
}

async function generateAdCopy({ product, price, channel }) {
  const tagsHint = channel === 'snap' ? 'Snapchat' : channel === 'tiktok' ? 'TikTok' : 'Facebook et Instagram';
  const input = [{
    role: 'user',
    content: [{ type: 'input_text', text: [
      'Tu es un rédacteur publicitaire expérimenté pour PUB au Sénégal.',
      `La publicité est adaptée à ${tagsHint}.`,
      '',
      'RÈGLE LA PLUS IMPORTANTE : le champ "hook" doit arrêter le défilement.',
      '- 4 à 8 mots maximum.',
      '- Concret et spécifique (prix, lieu, délai, résultat) — jamais vague ni générique.',
      '- Crée une tension, une question, une surprise ou un bénéfice ressenti — pas une simple description du produit.',
      '- INTERDIT de commencer par "Découvrez", "Nous vous présentons", "Offre spéciale" ou toute formule générique similaire.',
      '',
      'Le champ "body" (1 à 2 phrases courtes) développe le bénéfice concret et inclut le prix si disponible — sans blabla, sans adjectifs vides ("magnifique", "incroyable").',
      "N'invente aucune promotion, réduction, garantie ou caractéristique absente des données fournies.",
      '',
      'Réponds UNIQUEMENT avec un JSON valide : { "hook": "...", "body": "...", "hashtags": "#Tag1 #Tag2 #Tag3" }.',
      `Produit: ${product}`,
      `Prix: ${price || 'non précisé'}`,
    ].join('\n') }],
  }];
  const parsed = parseJsonText(await openAIResponse(input, 300));
  return {
    hook: String(parsed.hook || '').trim(),
    body: String(parsed.body || '').trim(),
    hashtags: String(parsed.hashtags || '').trim(),
  };
}

async function editAdCopy({ instruction, current, product, price, channel }) {
  const tagsHint = channel === 'snap' ? 'Snapchat' : channel === 'tiktok' ? 'TikTok' : 'Facebook et Instagram';
  const input = [{
    role: 'user',
    content: [{ type: 'input_text', text: [
      'Tu es PUB, le rédacteur publicitaire.',
      `Modifie cette publicité (${tagsHint}) selon la demande du client, en conservant les mêmes règles de qualité :`,
      'hook court (4-8 mots), concret, sans formule générique ; body sans blabla ; rien d\'inventé.',
      'Réponds UNIQUEMENT avec un JSON valide : { "hook": "...", "body": "...", "hashtags": "#Tag1 #Tag2 #Tag3" }.',
      `Publicité actuelle: ${JSON.stringify(current || {})}`,
      `Demande du client: ${instruction}`,
      `Produit: ${product}`,
      `Prix: ${price || 'non précisé'}`,
    ].join('\n') }],
  }];
  const parsed = parseJsonText(await openAIResponse(input, 300));
  return {
    hook: String(parsed.hook || current?.hook || '').trim(),
    body: String(parsed.body || current?.body || '').trim(),
    hashtags: String(parsed.hashtags || current?.hashtags || '').trim(),
  };
}

/* --------------------------- WHATSAPP CLOUD API ---------------------------- */

async function waFetch(path, options = {}) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) throw new Error('Variables WhatsApp manquantes.');
  const r = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, ...(options.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `WhatsApp API HTTP ${r.status}`);
  return data;
}

const sendMessage = (body) => waFetch(`${PHONE_NUMBER_ID}/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
});

const sendText = (to, text) => sendMessage({ to, type: 'text', text: { body: text } });

const sendButtons = (to, bodyText, buttons) => sendMessage({
  to, type: 'interactive',
  interactive: {
    type: 'button', body: { text: bodyText },
    action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
  },
});

const sendList = (to, bodyText, buttonLabel, rows) => sendMessage({
  to, type: 'interactive',
  interactive: {
    type: 'list', body: { text: bodyText },
    action: { button: buttonLabel.slice(0, 20), sections: [{ title: 'Choisissez', rows: rows.slice(0, 10).map((r) => ({ id: r.id, title: r.title.slice(0, 24) })) }] },
  },
});

const sendImageByMediaId = (to, mediaId, caption) => sendMessage({ to, type: 'image', image: { id: mediaId, caption } });

async function downloadMedia(mediaId) {
  const meta = await waFetch(mediaId);
  const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!r.ok) throw new Error(`Téléchargement média échoué (HTTP ${r.status}).`);
  return { buffer: Buffer.from(await r.arrayBuffer()), mimeType: meta.mime_type || 'image/jpeg' };
}

async function uploadMedia(buffer, mimeType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), 'photo.jpg');
  const data = await waFetch(`${PHONE_NUMBER_ID}/media`, { method: 'POST', body: form });
  return data.id;
}

/* -------------------------------- MENUS ------------------------------------ */

async function sendMainMenu(to) {
  await sendText(to, "Bonjour 👋\nQu'est-ce que vous souhaitez booster ?");
  await sendList(to, 'Choisissez ce que vous voulez booster', 'Choisir', [
    { id: 'kind_product', title: '📦 Un produit / une offre' },
    { id: 'kind_facebook', title: '📄 Une page Facebook' },
    { id: 'kind_instagram', title: '📸 Un compte Instagram' },
    { id: 'kind_snap', title: '👻 Un compte Snapchat' },
    { id: 'kind_tiktok', title: '🎵 Un compte TikTok' },
  ]);
}

async function sendObjectiveMenu(to, session) {
  const rows = session.kind === 'product' ? OBJECTIFS_PRODUCT : session.kind === 'facebook' ? OBJECTIFS_PAGE : OBJECTIFS_ACCOUNT;
  await sendList(to, 'Quel résultat recherchez-vous ?', "Choisir l'objectif", rows);
}

async function sendZoneMenu(to) {
  await sendList(to, 'Quelle zone voulez-vous cibler ?', 'Choisir la zone', [
    { id: 'zone_senegal', title: '🇸🇳 Tout le Sénégal' },
    { id: 'zone_dakar', title: '📍 Dakar' },
    { id: 'zone_thies', title: '📍 Thiès' },
    { id: 'zone_custom', title: '📍 Plusieurs zones (écrire)' },
  ]);
}

async function sendDurationMenu(to) {
  await sendList(to, 'Quelle durée ?', 'Choisir la durée', PLANS.map((p) => ({ id: p.id, title: `${p.label} ${p.jours}j — ${fcfa(p.prix)}` })));
}

async function sendForecastAndRecap(to, session) {
  await sendText(to, [
    '🎯 *Ciblage*',
    `Zone : ${session.zone || 'Audience adaptée au compte'}`,
    `Objectif : ${OBJ_LABELS[session.objective] || session.objective}`,
    `Canal : ${channelLabel(session.channel)}`,
    '',
    "Audience : sélection automatique selon l'objectif, le contenu, la zone et le canal.",
    '',
    '📊 *Prévisions*',
    'Portée : 4 000 – 8 000',
    'Résultats potentiels : 15 – 45',
    'Coût / résultat : 145 – 430 FCFA',
    '_Prévision indicative, non garantie._',
  ].join('\n'));
  await sendButtons(to, 'On continue ?', [{ id: 'continue_recap', title: 'Continuer' }]);
}

async function sendRecap(to, session) {
  const plan = PLANS.find((p) => p.id === session.planId);
  await sendText(to, [
    '✅ *Campagne prête*',
    session.product || 'Campagne',
    `Canal : ${channelLabel(session.channel)}`,
    `Objectif : ${OBJ_LABELS[session.objective] || session.objective}`,
    session.zone ? `Zone : ${session.zone}` : null,
    `Durée : ${plan.jours} jours`,
    `*Total : ${fcfa(plan.prix)}*`,
  ].filter(Boolean).join('\n'));
  await sendButtons(to, 'Choisissez votre moyen de paiement', [
    { id: 'pay_wave', title: 'Wave' },
    { id: 'pay_om', title: 'Orange Money' },
  ]);
}

/* -------------------------------- FLOW ------------------------------------ */

async function afterKindStart(waId, session, kind) {
  session.kind = kind;
  await saveSession(waId, session);

  if (kind === 'product') {
    session.step = 'await_channel';
    await saveSession(waId, session);
    await sendButtons(waId, "Avant d'envoyer la photo, choisissez où diffuser la publicité.", [
      { id: 'channel_meta', title: 'Facebook + Insta' },
      { id: 'channel_snap', title: 'Snapchat' },
      { id: 'channel_tiktok', title: 'TikTok' },
    ]);
  } else if (kind === 'facebook') {
    session.channel = 'meta';
    session.step = 'await_page_connect';
    await saveSession(waId, session);
    await sendButtons(waId, 'Connectez votre Page Facebook pour commencer.', [
      { id: 'connect_page_yes', title: 'Connecter ma Page' },
      { id: 'connect_page_no', title: "Je n'en ai pas" },
    ]);
  } else {
    session.channel = kind === 'instagram' ? 'meta' : kind === 'snap' ? 'snap' : 'tiktok';
    session.step = 'await_account_connect';
    await saveSession(waId, session);
    const label = kind === 'instagram' ? 'Instagram' : kind === 'snap' ? 'Snapchat' : 'TikTok';
    await sendButtons(waId, `Connectez votre compte ${label} pour continuer.`, [{ id: 'account_connect', title: 'Continuer' }]);
  }
}

async function handleIncomingImage(waId, session, mediaId) {
  if (session.step !== 'await_media') { await sendText(waId, 'Tapez "menu" pour recommencer si besoin.'); return; }
  await sendText(waId, '🔎 Analyse de votre photo en cours…');
  try {
    const { buffer, mimeType } = await downloadMedia(mediaId);
    session.mediaId = await uploadMedia(buffer, mimeType);

    if (session.kind === 'product') {
      // Seul le kind "produit" a besoin de l'IA pour identifier quoi vendre et à quel prix.
      const base64 = `data:${mimeType};base64,${buffer.toString('base64')}`;
      const analysis = await analyzeProductImage(base64);
      session.product = analysis.product;
      session.price = analysis.price || null;
    }
    // Pour page/compte, session.product est déjà un libellé fixé à l'étape de connexion
    // (ex: "Page Facebook") — on ne le remplace pas par une analyse IA hasardeuse
    // d'un logo ou d'une capture d'écran.

    await saveSession(waId, session);

    const ad = await generateAdCopy({ product: session.product, price: session.price, channel: session.channel });
    session.ad = ad;
    await saveSession(waId, session);

    await sendImageByMediaId(
      waId, session.mediaId,
      [`*${ad.hook}*`, ad.body, session.price ? fcfa(session.price) : null, '', ad.hashtags, `_Format adapté à ${channelLabel(session.channel)}_`].filter(Boolean).join('\n')
    );
    await sendButtons(waId, 'Cette publicité vous convient ?', [{ id: 'creative_ok', title: 'Oui, continuer' }]);
    await sendText(waId, '_Ou décrivez une modification, ex: "Mets le prix en évidence".');
    session.step = 'await_creative_feedback';
    await saveSession(waId, session);
    return;
  } catch (e) {
    await sendText(waId, `⚠️ Analyse impossible : ${e.message}`);
  }
}

async function afterObjective(waId, session, objId) {
  session.objective = objId.replace('obj_', '');
  if (['messages', 'appels'].includes(session.objective)) {
    session.step = 'await_phone';
    await saveSession(waId, session);
    await sendText(waId, session.objective === 'messages' ? 'Quel numéro WhatsApp recevra les messages ?' : 'Quel numéro les clients doivent-ils appeler ?');
    return;
  }
  if (session.objective === 'site') {
    session.step = 'await_site';
    await saveSession(waId, session);
    await sendText(waId, "Quelle est l'adresse du site ?");
    return;
  }
  if (session.kind === 'product' || session.kind === 'facebook') {
    session.step = 'await_zone';
    await saveSession(waId, session);
    await sendZoneMenu(waId);
    return;
  }
  session.step = 'await_duration';
  await saveSession(waId, session);
  await sendDurationMenu(waId);
}

async function handleInteractive(waId, session, id) {
  if (id.startsWith('kind_')) { await afterKindStart(waId, session, id.replace('kind_', '')); return; }

  if (id.startsWith('channel_')) {
    session.channel = id.replace('channel_', '');
    await saveSession(waId, session);
    if (session.channel === 'meta') {
      session.step = 'await_page_question';
      await saveSession(waId, session);
      await sendButtons(waId, 'Vous avez une Page Facebook ?', [{ id: 'meta_page_yes', title: 'Oui, je la connecte' }, { id: 'meta_page_no', title: "Non, je n'en ai pas" }]);
    } else {
      session.step = 'await_media';
      await saveSession(waId, session);
      await sendText(waId, 'Envoyez maintenant la photo de votre produit.');
    }
    return;
  }

  if (id === 'meta_page_yes' || id === 'meta_page_no') {
    session.accountConnected = id === 'meta_page_yes';
    session.product = 'Page Facebook';
    session.step = 'await_media';
    await saveSession(waId, session);
    await sendText(waId, (id === 'meta_page_yes' ? 'Page Facebook connectée ✅\n' : '') + 'Envoyez maintenant la photo de votre produit.');
    return;
  }

  if (id === 'connect_page_yes' || id === 'connect_page_no') {
    session.accountConnected = id === 'connect_page_yes';
    session.product = 'Page Facebook';
    session.step = 'await_media';
    await saveSession(waId, session);
    await sendText(waId, (id === 'connect_page_yes' ? 'Page Facebook connectée ✅\n' : '') + 'Envoyez un visuel qui représente votre Page (logo, photo de couverture ou capture d\'écran) pour créer la publicité.');
    return;
  }

  if (id === 'account_connect') {
    session.accountConnected = true;
    session.product = session.kind === 'instagram' ? 'Compte Instagram' : session.kind === 'snap' ? 'Compte Snapchat' : 'Compte TikTok';
    session.step = 'await_media';
    await saveSession(waId, session);
    await sendText(waId, "C'est bon ✅\nEnvoyez un visuel qui représente votre compte (logo, capture d'écran de votre profil) pour créer la publicité.");
    return;
  }

  if (id === 'creative_ok') {
    if (session.kind === 'product' && !session.price) {
      session.step = 'await_price';
      await saveSession(waId, session);
      await sendButtons(waId, 'Quel est le prix ? Vous pouvez aussi continuer sans prix.', [{ id: 'no_price', title: 'Sans prix' }]);
    } else {
      session.step = 'await_objective';
      await saveSession(waId, session);
      await sendObjectiveMenu(waId, session);
    }
    return;
  }

  if (id === 'no_price') {
    session.price = 0;
    session.step = 'await_objective';
    await saveSession(waId, session);
    await sendObjectiveMenu(waId, session);
    return;
  }

  if (id.startsWith('obj_')) { await afterObjective(waId, session, id); return; }

  if (id.startsWith('zone_')) {
    if (id === 'zone_custom') {
      session.step = 'await_zone_text';
      await saveSession(waId, session);
      await sendText(waId, 'Indiquez les zones, par exemple : Dakar, Thiès.');
      return;
    }
    session.zone = id === 'zone_senegal' ? 'Sénégal' : id === 'zone_dakar' ? 'Dakar' : 'Thiès';
    session.step = 'await_duration';
    await saveSession(waId, session);
    await sendDurationMenu(waId);
    return;
  }

  if (id.startsWith('plan_')) {
    session.planId = id;
    session.step = 'forecast';
    await saveSession(waId, session);
    await sendForecastAndRecap(waId, session);
    return;
  }

  if (id === 'continue_recap') {
    session.step = 'recap';
    await saveSession(waId, session);
    await sendRecap(waId, session);
    return;
  }

  if (id === 'pay_wave' || id === 'pay_om') {
    const plan = PLANS.find((p) => p.id === session.planId);
    const methodLabel = id === 'pay_wave' ? 'Wave' : 'Orange Money';
    const configured = { meta: isMetaConfigured(), tiktok: isTikTokConfigured(), snap: isSnapConfigured() }[session.channel];

    await sendText(waId, `⏳ Paiement de ${fcfa(plan.prix)} via ${methodLabel}${configured ? '' : ' (mode démo)'}…`);

    session.step = 'launched';
    session.launchedAt = new Date().toISOString();
    await saveSession(waId, session);

    if (configured && session.mediaId) {
      try {
        const { buffer, mimeType } = await downloadMedia(session.mediaId);
        const adText = session.ad ? `${session.ad.hook}\n${session.ad.body}` : session.product;
        const commonArgs = {
          product: session.product, price: session.price, adText, hashtags: session.ad?.hashtags || '',
          imageBuffer: buffer, imageMimeType: mimeType,
          objective: session.objective, zone: session.zone, jours: plan.jours, prixTotal: plan.prix,
          dailyBudgetFcfa: Math.round(plan.prix / plan.jours),
          whatsappNumber: PHONE_NUMBER_ID,
        };

        const result = session.channel === 'meta' ? await createMetaCampaign(commonArgs)
          : session.channel === 'tiktok' ? await createTikTokCampaign(commonArgs)
          : await createSnapCampaign(commonArgs);

        session.campaignId = result.campaignId;
        session.adPlatform = session.channel;
        await saveSession(waId, session);
        await sendText(waId, `✅ Paiement confirmé.\n\n🎯 Campagne créée sur ${channelLabel(session.channel)} (en pause pour vérification finale avant diffusion).\n\nElle sera activée sous peu. Tapez "suivi" pour les performances une fois active.`);
      } catch (e) {
        console.error(`Erreur création campagne ${session.channel}:`, e);
        await sendText(waId, `✅ Paiement confirmé.\n⚠️ La création automatique sur ${channelLabel(session.channel)} a rencontré un problème (${e.message}) — notre équipe s'en occupe manuellement.`);
      }
      return;
    }

    await sendText(waId, `✅ Paiement confirmé (démo).\n\n🎉 Campagne lancée — jour 1/${plan.jours}.\n\nTapez "suivi" à tout moment pour voir les performances.`);
    return;
  }
}

async function handleText(waId, session, text) {
  const t = text.trim().toLowerCase();

  if (['menu', 'recommencer', 'nouvelle campagne'].includes(t)) {
    session = newSession();
    await saveSession(waId, session);
    await sendMainMenu(waId);
    return;
  }

  if (t === 'suivi' && session.step === 'launched') {
    const plan = PLANS.find((p) => p.id === session.planId);
    await sendText(waId, ['📈 *Suivi*', 'Portée : 4 820', 'Résultats : 37', 'Coût / résultat : 103 FCFA', `Budget consommé : 2 850 / ${fcfa(plan.prix)}`].join('\n'));
    return;
  }

  switch (session.step) {
    case 'menu':
    case undefined:
      session.step = 'menu';
      await saveSession(waId, session);
      await sendMainMenu(waId);
      return;

    case 'await_creative_feedback':
      await sendText(waId, '✏️ Modification en cours…');
      try {
        session.ad = await editAdCopy({
          instruction: text, current: session.ad, product: session.product, price: session.price, channel: session.channel,
        });
        await saveSession(waId, session);
        await sendImageByMediaId(
          waId, session.mediaId,
          [`*${session.ad.hook}*`, session.ad.body, session.price ? fcfa(session.price) : null, '', session.ad.hashtags, `_Format adapté à ${channelLabel(session.channel)}_`].filter(Boolean).join('\n')
        );
        await sendButtons(waId, 'Et maintenant ?', [{ id: 'creative_ok', title: 'Oui, continuer' }]);
      } catch (e) {
        await sendText(waId, `⚠️ Modification impossible : ${e.message}`);
      }
      return;

    case 'await_price': {
      const price = Number(t.replace(/[^\d]/g, ''));
      if (t.includes('sans prix') || !price) { await sendText(waId, 'Tapez le montant, ou "sans prix" pour continuer sans prix.'); return; }
      session.price = price;
      session.step = 'await_objective';
      await saveSession(waId, session);
      await sendText(waId, `${fcfa(price)} ✅`);
      await sendObjectiveMenu(waId, session);
      return;
    }

    case 'await_phone':
      session.phone = text.trim();
      await saveSession(waId, session);
      if (session.kind === 'product' || session.kind === 'facebook') { session.step = 'await_zone'; await saveSession(waId, session); await sendZoneMenu(waId); }
      else { session.step = 'await_duration'; await saveSession(waId, session); await sendDurationMenu(waId); }
      return;

    case 'await_site':
      session.site = text.trim();
      await saveSession(waId, session);
      if (session.kind === 'product' || session.kind === 'facebook') { session.step = 'await_zone'; await saveSession(waId, session); await sendZoneMenu(waId); }
      else { session.step = 'await_duration'; await saveSession(waId, session); await sendDurationMenu(waId); }
      return;

    case 'await_zone_text':
      session.zone = text.split(',').map((x) => x.trim()).filter(Boolean).join(' + ');
      session.step = 'await_duration';
      await saveSession(waId, session);
      await sendDurationMenu(waId);
      return;

    case 'await_media':
      await sendText(waId, 'Envoyez la photo de votre produit pour continuer.');
      return;

    default:
      await sendText(waId, 'Tapez "menu" pour recommencer.');
  }
}

/* -------------------------------- HANDLER ---------------------------------- */

export default async (req) => {
  console.log(`Requête reçue: ${req.method} ${req.url}`);
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return new Response(challenge || '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const body = await req.json();
    console.log('Webhook reçu:', JSON.stringify(body));
    const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) {
      console.log('Aucun message dans ce payload (probablement un statut de livraison/lecture) — normal.');
      return Response.json({ received: true });
    }

    if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
      console.error('Missing WhatsApp environment variables');
      return Response.json({ received: true });
    }

    const waId = message.from;
    const session = await getSession(waId);

    if (message.type === 'image') {
      await handleIncomingImage(waId, session, message.image.id);
    } else if (message.type === 'interactive') {
      const reply = message.interactive.button_reply || message.interactive.list_reply;
      if (reply) await handleInteractive(waId, session, reply.id);
    } else if (message.type === 'text') {
      await handleText(waId, session, message.text?.body || '');
    } else {
      await sendText(waId, 'Envoyez "menu" pour commencer.');
    }
  } catch (error) {
    console.error('Webhook error:', error);
  }

  return Response.json({ received: true });
};

export const config = {
  path: '/.netlify/functions/whatsapp-webhook',
};
