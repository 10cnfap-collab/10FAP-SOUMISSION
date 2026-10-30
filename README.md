# Plateforme des résumés — 10ème Congrès National de la FAP

22 – 23 décembre 2026 · Centre International de Conférences (CIC), Alger

Hébergement **100 % Vercel + GitHub** : site statique, API serverless (`/api`), base de données Upstash Redis branchée depuis Vercel, e-mails par SMTP ou Resend. Pas de Google Sheets.

```
fap10-resumes/
├── index.html        Site complet (soumission, suivi, contact, administration)
├── config.js         "/api" = production · "" = mode démo
├── api/index.js      API : enregistrement, décisions, e-mails, messagerie
├── favicon.png, logo-email.png
├── package.json, vercel.json
└── .env.example      Liste des variables d'environnement
```

## 1. Mettre le code sur GitHub
1. Créez un dépôt sur github.com (par ex. `fap10-resumes`, privé de préférence).
2. **Add file › Upload files**, puis glissez **le contenu** du dossier `fap10-resumes` (pas le dossier lui-même) et faites un **Commit**.

En ligne de commande :
```bash
cd fap10-resumes
git init && git add . && git commit -m "Plateforme résumés 10ème Congrès FAP"
git branch -M main
git remote add origin https://github.com/VOTRE-COMPTE/fap10-resumes.git
git push -u origin main
```

## 2. Importer dans Vercel
vercel.com › **Add New › Project** › choisissez le dépôt GitHub.
Réglages : Framework Preset **Other**, Build Command vide, Output Directory vide. Cliquez sur **Deploy**.

## 3. Ajouter la base de données (2 clics)
Projet Vercel › **Storage › Create Database › Upstash for Redis (Marketplace)** › plan **Free** › **Connect to project**.
Les variables `KV_REST_API_URL` et `KV_REST_API_TOKEN` sont ajoutées automatiquement.

## 4. Variables d'environnement
Projet › **Settings › Environment Variables** (voir `.env.example`) :

| Variable | Rôle |
|---|---|
| `ADMIN_PASSWORD` | Mot de passe de l'espace Administration (obligatoire) |
| `SESSION_SECRET` | Longue chaîne aléatoire pour sécuriser les sessions |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` | Compte e-mail d'envoi |
| `MAIL_FROM` | Expéditeur affiché, ex. `Comité scientifique – 10ème Congrès FAP <congres.fap@gmail.com>` |
| `MAIL_REPLY_TO` | Adresse de réponse (facultatif) |

**Avec Gmail** : activez la validation en 2 étapes sur le compte, puis créez un **mot de passe d'application** (Compte Google › Sécurité › Mots de passe des applications). Ensuite : `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_PASS=` ce mot de passe à 16 caractères. Limite : environ 500 e-mails par jour.

**Alternative Resend** (resend.com, domaine vérifié) : `RESEND_API_KEY` + `MAIL_FROM`. Cette option remplace SMTP.

Après avoir ajouté les variables : **Deployments › ⋯ › Redeploy**.

## 5. Vérifier
- `https://votre-projet.vercel.app/api` doit afficher `{"ok":true,"db":true,"mail":true,"admin":true}`.
- Dans l'onglet **Administration**, connectez-vous puis renseignez dans **Paramètres** le thème général, la date limite, les thématiques et le statut des soumissions. Relisez les **Modèles d'e-mails**.
- Faites une soumission test avec votre propre e-mail et vérifiez l'accusé de réception.

Domaine personnalisé (ex. `resumes.fap.dz`) : Settings › Domains.
Chaque `git push` sur `main` redéploie automatiquement le site.

## Données
- Stockées dans Upstash Redis, consultables dans Vercel › Storage.
- Export : bouton **Exporter (Excel)** dans l'Administration. Il produit un fichier CSV avec tous les résumés, qui s'ouvre directement dans Excel.
- Sécurité : sessions admin signées valables 8 h, limitation des tentatives (soumissions, connexion, contact).
