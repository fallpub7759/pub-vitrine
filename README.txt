PUB — Service publicitaire orienté WhatsApp

Déploiement : mettre tous les fichiers du dossier à la racine du site.
Le bouton principal utilise WhatsApp +221 78 370 07 17.
La création de campagnes se fait sur WhatsApp.

--- IMPORTANT avant de déployer ---
Ce projet doit être déployé via GitHub (Netlify → Import an existing
project → Deploy with GitHub), PAS en glissant un zip directement sur
Netlify. Un dépôt (drop) direct n'exécute jamais "npm install", et
sans ça la dépendance @netlify/blobs manque et la fonction plante au
démarrage (sessions de conversation impossibles à conserver entre deux
messages). Si le site est déjà connecté à GitHub, il suffit de pousser
les nouveaux fichiers et Netlify réinstalle automatiquement.

--- Variables d'environnement à définir sur Netlify ---
(Site settings → Environment variables, puis "Retry deploy" après tout
ajout/modif pour qu'elles soient prises en compte)

# WhatsApp Cloud API — obligatoire pour que le bot réponde
WHATSAPP_VERIFY_TOKEN=<au choix, ex: pub_verify_token>
WHATSAPP_ACCESS_TOKEN=<jeton Meta WhatsApp Cloud API — privilégier un
                        jeton permanent généré via "Étape 1 : générez
                        un token" plutôt que le jeton temporaire 24h>
WHATSAPP_PHONE_NUMBER_ID=<Phone Number ID, visible dans Démarrage rapide>
WHATSAPP_GRAPH_API_VERSION=v23.0

# OpenAI — obligatoire pour l'analyse de photo et la génération des pubs
OPENAI_API_KEY=<clé OpenAI>
OPENAI_MODEL=gpt-5.6-luna (ou autre modèle disponible)

# Meta Marketing API (Facebook + Instagram) — compte pub PUB, aucune
# Page client à connecter (voir note d'architecture dans _lib/meta.mjs)
META_ACCESS_TOKEN=<jeton System User permanent — Business Settings >
                   Utilisateurs système, scopes ads_management/
                   ads_read/pages_read_engagement/pages_manage_ads>
META_AD_ACCOUNT_ID=act_XXXXXXXXXXXXX
META_PAGE_ID=<ID de la Page Facebook PUB>
META_GRAPH_API_VERSION=v23.0

# TikTok Marketing API — compte pub PUB (voir prérequis dans _lib/tiktok.mjs)
TIKTOK_ACCESS_TOKEN=<jeton généré sur business-api.tiktok.com>
TIKTOK_ADVERTISER_ID=<Advertiser ID du compte pub PUB>
TIKTOK_IDENTITY_ID=<identité TikTok au nom de laquelle la pub est diffusée>

# Snapchat Marketing API — compte pub PUB (voir prérequis dans _lib/snap.mjs)
SNAP_ACCESS_TOKEN=<jeton initial>
SNAP_REFRESH_TOKEN=<pour renouvellement auto — recommandé>
SNAP_CLIENT_ID=<App OAuth2 Snap>
SNAP_CLIENT_SECRET=<App OAuth2 Snap>
SNAP_AD_ACCOUNT_ID=<compte pub Snap PUB>
SNAP_PUBLIC_PROFILE_ID=<profil Snapchat public de PUB>

Tant que les variables d'une plateforme (Meta / TikTok / Snap) ne sont
pas toutes définies pour elle, le paiement pour cette plateforme reste
automatiquement simulé — rien ne casse si une seule des trois est prête.

--- État réel du webhook (netlify/functions/whatsapp-webhook.mjs) ---
RÉEL : réception/envoi de messages WhatsApp, analyse de photo et
génération de la publicité par IA (OpenAI, avec accroche travaillée
séparément du corps du texte), sessions persistées, parcours complet
(produit / page Facebook / compte Instagram / Snapchat / TikTok),
modification de la publicité en langage naturel, création réelle de
campagne sur Meta/TikTok/Snap dès que leurs variables sont définies.

SIMULÉ pour l'instant : le paiement lui-même (Wave/Orange Money) reste
manuel — le client envoie l'argent, vous confirmez vous-même dans la
conversation. Voir plus bas pour la marche à suivre en attendant les
papiers d'entreprise nécessaires à l'intégration officielle.

⚠️ Sécurité : toute campagne créée sur Meta, TikTok ou Snap démarre en
PAUSED (ou l'équivalent DISABLE/PAUSED selon la plateforme). Rien ne se
diffuse et rien n'est débité tant qu'elle n'est pas activée manuellement
(fonction activateCampaign dans chaque module _lib/) — le temps de
vérifier une première fois dans l'outil de gestion de la plateforme que
tout est correct.

Aucun de ces trois modules (_lib/meta.mjs, _lib/tiktok.mjs, _lib/snap.mjs)
n'a pu être testé contre les API réelles dans cet environnement de
développement (pas d'accès réseau ici). Teste chaque plateforme avec un
budget minimal avant de monter en budget, et attends-toi à devoir
ajuster certains noms de champs — les API publicitaires changent
régulièrement leurs spécifications exactes.

--- Ce qui N'EST PAS encore construit (à ne pas supposer fait) ---
- Connexion réelle de la Page/du compte d'un CLIENT (OAuth) : toutes les
  campagnes tournent sur les comptes pub appartenant à PUB, pas sur ceux
  des clients. Construire le vrai compte-par-client est un chantier
  séparé (flux Facebook Login for Business + stockage sécurisé des
  jetons par client) — pas commencé.
- Paiement automatisé (API Wave/Orange Money) : volontairement laissé
  manuel en attendant les documents d'entreprise.
- Ciblage géographique fin (au-delà du pays Sénégal) sur les trois
  plateformes — actuellement ciblage pays uniquement.
