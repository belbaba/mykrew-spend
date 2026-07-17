# Requirements Document — MyKrew Spend

## Introduction

Application web progressive (PWA) de gestion de notes de frais pour les équipes. L'employé déclare ses dépenses professionnelles avec justificatif photo, le responsable approuve ou refuse. À l'approbation, un email est envoyé au responsable avec la photo et les détails. Le responsable peut aussi déclarer ses propres dépenses pour les garder en mémoire et les exporter pour la comptabilité.

## Glossary

- **Spend** : L'application PWA de gestion des notes de frais
- **Responsable** : Utilisateur qui approuve/refuse les notes et gère l'équipe
- **Employé** : Utilisateur qui déclare ses dépenses
- **Note de frais (Expense)** : Une dépense professionnelle déclarée par un utilisateur
- **Justificatif** : Photo ou scan du ticket/facture associé à la dépense

## Requirements

### Exigence 1 : Authentification
Même système que Leave/Plan (email/password, rôles manager/employee, session 30 jours).

### Exigence 2 : Déclaration d'une note de frais
- L'utilisateur (employé ou responsable) crée une dépense avec :
  - Montant TTC (obligatoire)
  - Montant HT (optionnel, calculé automatiquement si TVA renseignée)
  - Taux de TVA (optionnel : 0%, 5.5%, 10%, 20%)
  - Date de la dépense (obligatoire)
  - Lieu / commerce (obligatoire)
  - Catégorie (obligatoire) : Repas, Transport, Hébergement, Fournitures, Téléphone/Internet, Formation, Autre
  - Justification / description (obligatoire)
  - Projet (optionnel, texte libre)
  - Photo du justificatif (obligatoire pour les employés, optionnel pour le responsable)
- La photo peut être prise directement depuis la caméra de l'appareil ou choisie depuis la galerie
- La note est créée avec le statut "en attente" (employé) ou "auto-approuvée" (responsable pour lui-même)

### Exigence 3 : Approbation / Refus par le responsable
- Le responsable voit la liste des notes en attente d'approbation
- Il peut voir la photo du justificatif en plein écran
- Il peut approuver ou refuser la note (avec motif de refus obligatoire)
- À l'approbation, un email est envoyé au responsable avec :
  - La photo du justificatif en pièce jointe
  - Toutes les informations de la note (montant, date, catégorie, lieu, justification)
- L'employé reçoit une notification email de la décision

### Exigence 4 : Statut de remboursement
- Une note approuvée peut être marquée "remboursée" par le responsable
- Date de remboursement enregistrée
- Distinction claire entre approuvé (validé) et remboursé (argent rendu)

### Exigence 5 : Historique et filtres
- L'employé voit toutes ses notes avec filtres par statut, catégorie, mois
- Le responsable voit toutes les notes de l'équipe
- Tri par date, montant, statut
- Recherche par description ou lieu

### Exigence 6 : Export mensuel PDF/CSV
- Le responsable peut exporter un récapitulatif mensuel :
  - PDF : mise en forme propre pour le comptable, avec total par catégorie
  - CSV : pour import dans un logiciel comptable
- Filtrable par employé, catégorie, période
- Inclut les colonnes : date, employé, catégorie, lieu, description, HT, TVA, TTC, statut

### Exigence 7 : Plafonds par catégorie (optionnel)
- Le responsable peut définir des plafonds mensuels par catégorie
- Alerte visuelle quand un employé dépasse le plafond
- Ne bloque pas la soumission (avertissement seulement)

### Exigence 8 : Gestion des employés
- Ajouter/supprimer des employés (Cloud Function)
- Mêmes mécanismes que Leave/Plan

### Exigence 9 : Stockage photos temporaire
- Photos stockées dans Firebase Storage (dossier expenses/)
- Rotation automatique : suppression des photos 30 jours après l'approbation
- Cloud Function quotidienne de nettoyage

### Exigence 10 : Notifications email
- Email au responsable quand un employé soumet une note
- Email à l'employé quand sa note est approuvée/refusée
- Email au responsable avec photo en PJ quand une note est approuvée (récap)

### Exigence 11 : Dashboard responsable
- Résumé mensuel : total dépensé, nombre de notes, par catégorie
- Vue graphique (barres par catégorie)
- Comparaison mois précédent

### Exigence 12 : Architecture
- Même stack que Leave/Plan (Firebase, React, TypeScript, Tailwind)
- Design dark mode avec thème violet/purple (#7c3aed)
- PWA installable
- Temps réel (Firestore onSnapshot)
- Hébergement Firebase (0€ pour ~50 utilisateurs)
- Capture photo native via input file accept="image/*" capture="environment"
