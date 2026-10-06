# Installation — ChatGPT Export by NoXoZ.be v7.0.0

> Projet indépendant. Non affilié à OpenAI, non approuvé, non sponsorisé et sans lien officiel avec OpenAI.
> Auteur : Bruno DELNOZ / @NoXoZ.be

## Brave

1. Extrayez l’archive ZIP.
2. Ouvrez `brave://extensions/`.
3. Activez le **Mode développeur**.
4. Cliquez sur **Charger l’extension non empaquetée**.
5. Sélectionnez le dossier extrait contenant `manifest.json`.
6. Ouvrez ou rechargez ChatGPT.

## Chrome / Chromium

Utilisez `chrome://extensions/` et suivez la même procédure **Charger l’extension non empaquetée**.

## Export de tous les chats — recommandations

Pour les exports volumineux, utilisez :

- **Nombre de chats à exporter par ZIP** (mode Maxi), ou
- **`#inZip`** (mode Mini)

Une valeur telle que `5` limite chaque ZIP d’un Projet complet ou d’un export de tous les chats à 5 chats, ce qui réduit le pic d’utilisation de la mémoire. Chaque lot est finalisé avant le démarrage du suivant.

> L’export de tous les chats utilise toujours le mode **COMPLET** ; les contrôles DÉBUT/FIN ne s’appliquent pas.

## Fichiers d’exécution

```text
manifest.json
background.js
content-export.js
donate-mini.js
export-style.css
icons/
```

## Dépannage rapide

| Symptôme | Vérification |
|---|---|
| L’extension n’apparaît pas | Vérifiez que le Mode développeur est activé |
| Rien n’est exporté | Rechargez la page ChatGPT après l’installation |
| Export incomplet sur un compte volumineux | Réduisez `#inZip` pour diminuer la taille des lots |
| Un fichier attendu est absent | Consultez `SECURITY.md` — validation des téléchargements |
