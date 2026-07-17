# MyKrew Spend — Gestion de notes de frais

Application PWA de gestion des notes de frais pour les équipes. L'employé déclare ses dépenses avec photo du justificatif, le responsable approuve ou refuse, et reçoit un email avec la photo et les détails une fois approuvé.

## Stack technique

- **Frontend** : React 19 + TypeScript + Tailwind CSS 4 + Vite
- **Backend** : Firebase (Firestore, Auth, Cloud Functions, Storage)
- **Région** : europe-west1
- **PWA** : installable sur mobile, capture photo intégrée
- **Emails** : Resend

## Couleur thème

Violet/Purple (#7c3aed) — distinct de Leave (teal) et Plan (bleu)

## Fonctionnalités

### Employé
- Déclarer une note de frais (montant, date, lieu, catégorie, justification, projet optionnel)
- Prendre une photo du justificatif (caméra ou galerie)
- Voir l'historique de ses notes (en attente, approuvées, refusées, remboursées)
- TVA optionnelle (HT / TVA / TTC)

### Responsable
- Voir les notes de frais en attente d'approbation
- Approuver ou refuser (avec motif)
- Se déclarer ses propres notes de frais (pour mémoire)
- Marquer une note comme "remboursée"
- Export mensuel PDF/CSV pour le comptable
- Email avec photo + détails à l'approbation

### Catégories de dépenses
- 🍽️ Repas
- 🚗 Transport
- 🏨 Hébergement
- 📦 Fournitures
- 📱 Téléphone / Internet
- 🎓 Formation
- 📋 Autre

### Stockage photos
- Stockage temporaire Firebase Storage (30 jours après approbation)
- Photo envoyée par email au responsable à l'approbation
- Rotation automatique (Cloud Function quotidienne)

## Déploiement

```bash
# Build
cd app && npm run build

# Deploy
firebase deploy --project mykrew-spend-<slug>
```

## Structure Firestore

```
/users/{uid}           - Profil utilisateur (role, email, nom...)
/expenses/{expenseId}  - Notes de frais
/activityLogs/{logId}  - Logs d'activité
/emailStats/{monthKey} - Compteur emails
```
