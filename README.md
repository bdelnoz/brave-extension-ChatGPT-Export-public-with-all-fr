<div align="center">

# ChatGPT Export — par NoXoZ.be

**v7.0.0** · Extension indépendante Brave / Chromium

[![Version](https://img.shields.io/badge/version-7.0.0-blue)]()
[![Licence](https://img.shields.io/badge/licence-NoXoZ%20Personal%20v1.0-lightgrey)]()
[![Plateforme](https://img.shields.io/badge/plateforme-Brave%20%7C%20Chrome%20%7C%20Chromium-informational)]()
[![Télémétrie](https://img.shields.io/badge/télémétrie-aucune-success)]()

</div>

> **Projet indépendant.** Non affilié à OpenAI, non approuvé, non sponsorisé et sans lien officiel avec OpenAI.
> Auteur : **Bruno DELNOZ** / **@NoXoZ.be**

---

## Présentation

Extension de navigateur permettant d’exporter des conversations ChatGPT, des Projets ChatGPT complets ou l’ensemble des chats d’un compte dans des archives ZIP Markdown structurées.

**v7.0.0** est la base de la version majeure construite à partir du code validé **v6.1.4 p24**, en conservant la correction p24 du flux officiel des sources de projet ainsi que le comportement d’export existant.

## Fonctionnalités

| Domaine | Détail |
|---|---|
| Export du chat courant | Génère un ZIP structuré pour la conversation active |
| Export de projet | Exporte un Projet ChatGPT complet dans un seul ZIP |
| Export de tous les chats du compte | Exporte **chaque** chat du compte en mode Complet |
| Découpage en lots | `#inZip` divise les gros exports en plusieurs ZIP |
| Mode Complet uniquement pour tous les chats | Les options Début/Fin ne s’appliquent pas à l’export de tous les chats |
| Fichiers Markdown lisibles | Un fichier `.md` par chat |
| Structure par chat | Un dossier dédié par chat, avec `Upload/` et `Download/` |
| Index automatiques | `INDEX.md` généré pour chaque lot Projet / Tous les chats |
| Inventaire des fichiers | Répertorie les fichiers envoyés et les fichiers proposés au téléchargement |
| Récupération des envois | Copie facultative des fichiers envoyés par l’utilisateur |
| Récupération des téléchargements | Copie facultative des fichiers proposés par l’assistant |
| Plusieurs interfaces | Modes **Mini**, **Maxi** et **Développeur** |
| Soutien du projet | Bouton de don facultatif, ouvre Stripe uniquement après un clic |
| 100 % local | Aucun backend NoXoZ.be, aucune télémétrie, aucune analyse |

## Interface

### Mode Maxi

| Contrôle | Rôle |
|---|---|
| `Nombre de messages à exporter` | Nombre de messages utilisé par les modes DÉBUT et FIN |
| `Nombre de chats à exporter par ZIP` | Nombre maximal de chats par ZIP (Tous les chats / Projet complet) |
| `Exporter le projet complet` | Exporte le Projet complet |
| `Exporter les fichiers envoyés` | Inclut les fichiers envoyés |
| `Exporter les fichiers téléchargés` | Inclut les fichiers proposés au téléchargement |
| `Exporter le chat complet` | Exporte intégralement le chat courant |
| `Exporter depuis le début` | Exporte depuis le début, limité par le nombre de messages |
| `Exporter depuis la fin` | Exporte depuis la fin, limité par le nombre de messages |
| `Exporter tous les chats complets` | Exporte tous les chats du compte |
| `Démarrer l’export` | Lance l’export |
| `Cliquez pour soutenir ce projet` | Ouvre la page de don Stripe |

### Mode Mini

| Contrôle | Équivalent Maxi |
|---|---|
| `#MSG` | Nombre de messages (DÉBUT / FIN) |
| `#inZip` | Chats par ZIP |
| `COMPLET` / `DÉBUT` / `FIN` | Modes d’export du chat courant |
| `PROJET` | Export du Projet complet |
| `TOUS` | Export de tous les chats |
| `FICHIERS ENVOYÉS` / `FICHIERS TÉLÉCH.` | Récupération des fichiers |
| `Démarrer l’export` | Lance l’export |
| `Soutenir ce projet` | Ouvre la page de don Stripe |

> Bleu = activé/sélectionné · Gris = désactivé/non sélectionné.

## Nombre de messages et découpage des chats en lots

- `Nombre de messages à exporter` / `#MSG` s’appliquent **uniquement** aux modes DÉBUT et FIN. Ils ne limitent ni le Chat complet, ni le Projet complet, ni l’export de tous les chats.
- `Nombre de chats à exporter par ZIP` / `#inZip` s’appliquent à **l’export de tous les chats** et au **Projet complet**. Ils déterminent la taille des lots afin d’éviter de traiter un export volumineux dans un seul ZIP géant.

## Export de tous les chats

L’export de tous les chats exporte chaque chat détecté du compte, exclusivement en mode **COMPLET** (les options Début/Fin ne sont pas utilisées).

Les chats sont traités séquentiellement ; chaque lot ZIP est finalisé avant de passer au suivant, ce qui réduit le pic d’utilisation de la mémoire et le risque de plantage du navigateur sur les comptes contenant de nombreux chats.

**Exemple** : 1 247 chats avec `#inZip = 50` → 25 fichiers ZIP.

Chaque lot est utilisable indépendamment et contient son propre `INDEX.md`. Les dossiers `Upload/` et `Download/` restent associés au bon chat.

### Nom du compte dans les noms de fichiers ZIP

Lorsque le nom du compte est disponible dans la session ChatGPT active, il est inclus dans les noms de fichiers d’un export de tous les chats. Un nom de repli sûr est utilisé si le nom du compte ne peut pas être déterminé.

```text
Export ALL Full Chat - AccountName__export_YYYY-MM-DD-HH-MM-SS__part-001-of-025.zip
```

> Les préfixes techniques des noms de fichiers et les dossiers `Upload/` / `Download/` restent inchangés afin de préserver la compatibilité avec la v7.0.0.

## Structure d’export

**Export du Chat complet**

```text
ChatName__export_YYYY-MM-DD-HH-MM-SS.zip
└── ChatName__export_YYYY-MM-DD-HH-MM-SS/
    ├── ChatName__export_YYYY-MM-DD-HH-MM-SS.md
    ├── Upload/
    └── Download/
```

**Export de tous les chats**

```text
Export ALL Full Chat - AccountName__export_...__part-001-of-025.zip
├── INDEX.md
├── Chat 001/
│   ├── Chat 001__export_....md
│   ├── Upload/
│   └── Download/
├── Chat 002/
│   ├── Chat 002__export_....md
│   ├── Upload/
│   └── Download/
└── ...
```

**Export d’un Projet complet**

```text
Full Project - ProjectName__export_YYYY-MM-DD-HH-MM-SS.zip
├── INDEX.md
├── Project - ProjectName - Chat01__export_.../
│   ├── Project - ProjectName - Chat01__export_....md
│   ├── Upload/
│   └── Download/
└── Project - ProjectName - Chat02__export_.../
    ├── Project - ProjectName - Chat02__export_....md
    ├── Upload/
    └── Download/
```

## Découpage en lots — exemple

`Nombre de chats à exporter par ZIP` / `#inZip` s’applique à **Exporter le projet complet** et **Exporter tous les chats complets**.

| Chats dans le Projet | `#inZip` | Résultat |
|---|---|---|
| 12 | 5 | 3 ZIP : 5 + 5 + 2 chats |
| 5 | 5 | 1 ZIP : 5 chats |
| 13 | 5 | 3 ZIP : 5 + 5 + 3 chats |

Chaque lot est finalisé avant le démarrage du suivant.

## Documentation associée

| Document | Contenu |
|---|---|
| [`INSTALL.md`](INSTALL.md) | Installation pour Brave / Chrome / Chromium |
| [`PRIVACY.md`](PRIVACY.md) | Données traitées, destination des exports |
| [`SECURITY.md`](SECURITY.md) | Modèle de sécurité, validation des téléchargements |
| [`DONATE.md`](DONATE.md) | Soutien volontaire du projet |
| [`LICENSE`](LICENSE) | NoXoZ Personal License v1.0 |
| `ChatGPT-Export_v7.0.0_Product_Guide.pdf` | Guide produit complet (lots, exemples, historique des versions) |

---

<div align="center">

© 2026 Bruno DELNOZ / NoXoZ.be — Tous droits réservés.

</div>
