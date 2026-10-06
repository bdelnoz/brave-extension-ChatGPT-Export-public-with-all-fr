# Sécurité — ChatGPT Export by NoXoZ.be v7.0.0

> Projet indépendant. Non affilié à OpenAI, non approuvé, non sponsorisé et sans lien officiel avec OpenAI.
> Auteur : Bruno DELNOZ / @NoXoZ.be

ChatGPT Export est une extension de navigateur entièrement locale.

## Modèle de sécurité

- Aucun backend NoXoZ.be pour les exports.
- Aucun SDK d’analyse.
- Aucun endpoint de télémétrie.
- Les exports sont générés localement sous forme de fichiers Markdown/ZIP.
- Le regroupement de fichiers peut accéder aux ressources ChatGPT/OpenAI éligibles associées à la session active du navigateur.
- L’export de tous les chats est traité séquentiellement et divisé en lots ZIP afin de limiter la taille maximale de l’archive conservée en mémoire.

## Validation des téléchargements

L’exporteur **rejette** les pages génériques de visionneuse HTML ChatGPT lorsqu’un véritable fichier non-HTML est attendu.

Cela empêche qu’une page de visionneuse soit enregistrée à tort comme un fichier Markdown, ZIP, PDF, image ou autre fichier généré.

## Données sensibles

Les chats exportés et les fichiers inclus peuvent contenir des informations confidentielles. Les archives ZIP générées doivent être stockées et partagées avec prudence.

## Signaler un problème de sécurité

Toute vulnérabilité doit être signalée directement à l’auteur :

**Bruno DELNOZ** — bruno.delnoz@protonmail.com
