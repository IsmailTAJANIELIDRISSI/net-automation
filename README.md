# net-automation

J’ai build l’exe de l’application.
Implémente maintenant le système de mise à jour automatique pour la version installée (pas git pull):

- vérifier les nouvelles versions au démarrage
- télécharger la mise à jour
- installer au prochain redémarrage (ou me proposer le mode silencieux)
- garder mes données locales utilisateur intactes
- me donner les fichiers/config à créer + les commandes de build/release.
  Contrainte de distribution: [GitHub Releases OU serveur/folder interne].
