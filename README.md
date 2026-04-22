# Agilos RFP Automation

Outil interne qui scrape automatiquement le portail des marchés publics luxembourgeois ([pmp.b2g.etat.lu](https://pmp.b2g.etat.lu)), analyse les marchés IT pertinents pour Agilos via Claude, et génère des réponses à appels d'offres.

## Architecture

```
GitHub Pages (frontend)          Supabase
        │                             │
        ├─ Supabase Realtime ◄────────┤ markets table (live updates)
        │                             │
        └─ fetch ────────────► Edge Functions (Deno)
                                      │
                                      ├─ scan-portal
                                      │    Scrape pmp.b2g.etat.lu
                                      │    Recherche: "informatique", "données",
                                      │    "Business Intelligence", "ERP", etc.
                                      │    → insère les nouveaux marchés en DB
                                      │
                                      └─ process-market
                                           Scrape la page de détail du marché
                                           → Claude analyse la pertinence (0-100)
                                           → Claude génère un RFP si pertinent
```

## Déploiement — pas à pas

### 1. Créer un projet Supabase

1. Aller sur [supabase.com](https://supabase.com) → **New project**
2. Dans **SQL Editor**, exécuter tout le contenu de [`supabase/schema.sql`](supabase/schema.sql)

### 2. Déployer les Edge Functions

```bash
# Installer Supabase CLI
npm install -g supabase

# Authentification
supabase login

# Lier au projet (project-ref = l'ID dans l'URL Supabase)
supabase link --project-ref YOUR_PROJECT_REF

# Déployer les deux fonctions
supabase functions deploy scan-portal
supabase functions deploy process-market
```

### 3. Configurer les secrets Edge Functions

Dans **Supabase Dashboard → Edge Functions → Manage secrets** :

| Secret | Valeur |
|--------|--------|
| `ANTHROPIC_API_KEY` | Votre clé API Anthropic (sk-ant-…) |

> `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont injectés automatiquement.

### 4. Configurer le frontend

Éditer [`js/config.js`](js/config.js) avec les valeurs trouvées dans  
**Supabase Dashboard → Project Settings → API** :

```js
const SUPABASE_URL  = "https://xxxxx.supabase.co";
const SUPABASE_ANON = "eyJ...";   // anon/public key (safe to expose)
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
```

### 5. Déployer sur GitHub Pages

1. Pusher le repo sur GitHub (privé recommandé)
2. **Settings → Pages → Source** : branche `main`, dossier `/ (root)`
3. URL : `https://YOUR_ORG.github.io/rfp-automation/`

---

## Utilisation

1. Ouvrir l'URL GitHub Pages
2. Cliquer **Scanner le portail**
3. L'agent cherche sur `pmp.b2g.etat.lu` avec ~10 mots-clés IT (informatique, données, BI, ERP, IA, numérique…)
4. Les nouveaux marchés sont insérés en base
5. Pour chaque marché, Claude analyse la pertinence et génère un RFP si pertinent
6. Le dashboard se met à jour en **temps réel** (Supabase Realtime)
7. Cliquer sur une card pour voir le détail complet
8. Sur les cards pertinentes → **RFP** pour lire ou télécharger

## Structure des fichiers

```
├── index.html                  # SPA principale (GitHub Pages)
├── css/style.css
├── js/
│   ├── config.js               # ⚠️ À configurer avec vos credentials Supabase
│   └── app.js                  # Logique principale
├── supabase/
│   ├── schema.sql              # Schéma DB (tables markets + portal_scans)
│   └── functions/
│       ├── scan-portal/
│       │   └── index.ts        # Scraping du portail PMP
│       └── process-market/
│           └── index.ts        # Analyse Claude + génération RFP
└── local_dev/                  # Alternative Flask (développement local)
```
