# Confidentialité — ChatGPT Export by NoXoZ.be v7.0.0

> Projet indépendant. Non affilié à OpenAI, non approuvé, non sponsorisé et sans lien officiel avec OpenAI.
> Auteur : Bruno DELNOZ / @NoXoZ.be

L’extension traite le contenu ChatGPT **localement, dans le navigateur**, uniquement à des fins d’export.

## Données traitées

Selon les options activées, l’extension peut traiter :

- le texte rendu des conversations ;
- les titres des chats et des projets ;
- les informations de compte/session utilisées, lorsqu’elles sont disponibles, pour nommer les ZIP d’export de tous les chats ;
- les noms et les octets récupérables des fichiers envoyés ;
- les noms et les octets récupérables des fichiers proposés par l’Assistant ;
- les listes de chats et les métadonnées de messages nécessaires pour construire les lots et les index de l’export de tous les chats.

## Destination des données

Les exports sont écrits dans des fichiers locaux enregistrés/téléchargés par l’utilisateur. Les exports de tous les chats et de Projet complet sont divisés en lots ZIP séquentiels selon **Nombre de chats à exporter par ZIP** / `#inZip`.

**L’extension n’envoie pas intentionnellement le contenu des conversations exportées** vers un service distinct d’analyse, de publicité, de télémétrie ou de stockage de NoXoZ.be.

## Ce que l’extension ne fait pas

- Aucun backend NoXoZ.be pour les exports.
- Aucune collecte de données d’analyse.
- Aucune télémétrie.
- Aucune revente ni aucun partage de données avec des tiers.

## Responsabilité de l’utilisateur

Les chats exportés et les fichiers inclus peuvent contenir des informations confidentielles. Il appartient à l’utilisateur de sécuriser le stockage et le partage des archives générées (voir également `SECURITY.md`).
