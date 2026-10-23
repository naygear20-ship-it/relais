# Relais : messages programmés pour groupes WhatsApp

Tableau de bord web : QR code WhatsApp, création de compte intégrée, liste des groupes, programmation des messages, envoi immédiat et journal. La capture affiche le navigateur Chromium qui exécute WhatsApp Web, pas le tableau de bord. Elle inclut des commandes clavier virtuelles pour interagir avec les fenêtres qui bloquent WhatsApp Web.

## Essai local (sans WhatsApp)
    npm install && ADMIN_PASSWORD=un_code_aleatoire_de_20_caracteres_minimum WA_MOCK=1 DATA_DIR=./data node server.js     # http://localhost:3000

## Déploiement sur Sealos (App Launchpad)
1. Construire et pousser l'image : `docker build -t TON_USER/relais . && docker push TON_USER/relais`
2. App Launchpad > Nouvelle application > image `TON_USER/relais`
3. Port 3000, accès public activé (domaine HTTPS)
4. Configure `ADMIN_PASSWORD` avec un code de vérification aléatoire d'au moins 20 caractères. Il ne sert qu'à autoriser la création initiale du compte dans la page; ne le réutilise pas comme mot de passe du compte.
5. Stockage persistant : volume monté sur `/data` (session WhatsApp, programmations et compte)
6. Une seule instance, 1 Go de mémoire minimum (Chromium)
7. Ouvrir l'URL, scanner le QR WhatsApp, puis créer le compte dans le formulaire intégré avec le code de vérification. Aux visites suivantes, se connecter avec le nom d'utilisateur et le mot de passe créés.

## Notes
- Fuseau : TZ=Africa/Abidjan (modifiable dans le Dockerfile)
- Le mot de passe du compte est haché avec scrypt et les sessions utilisent un cookie HttpOnly. Le compte est conservé dans `/data/account.json`; les sessions expirent à l'arrêt du serveur et il faudra se reconnecter. Il n'existe pas de récupération de mot de passe : conserve-le dans un gestionnaire de mots de passe.
- Dans la capture agrandie, « Clavier virtuel » envoie les touches autorisées ou jusqu'à 500 caractères directement à la page WhatsApp Web; l'image peut être actualisée après chaque action. La touche Entrée demande une confirmation, car elle peut envoyer le message actif.
- Après la connexion WhatsApp, Relais recherche pendant environ 60 secondes la fenêtre « What's new on WhatsApp Web ». Il clique automatiquement sur son bouton « Continue », puis relance le chargement des groupes.
- Après la connexion, les groupes sont synchronisés automatiquement avec de nouvelles tentatives si WhatsApp Web n'a pas encore chargé les discussions. Le journal et l'état de l'interface signalent les erreurs; le bouton « Actualiser » déclenche une nouvelle tentative immédiate.
- Automatiser WhatsApp Web va contre les conditions de WhatsApp : évite les rythmes trop rapides et ton numéro principal.
