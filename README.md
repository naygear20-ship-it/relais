# Relais : messages programmés pour groupes WhatsApp

Tableau de bord web : QR code, liste des groupes, message et horaire par groupe, envoi immédiat, journal.

## Essai local (sans WhatsApp)
    npm install && WA_MOCK=1 DATA_DIR=./data node server.js     # http://localhost:3000

## Déploiement sur Sealos (App Launchpad)
1. Construire et pousser l'image : `docker build -t TON_USER/relais . && docker push TON_USER/relais`
2. App Launchpad > Nouvelle application > image `TON_USER/relais`
3. Port 3000, accès public activé (domaine HTTPS)
4. Variable d'environnement `ADMIN_PASSWORD=un_mot_de_passe_solide` (obligatoire, sinon le QR est public)
5. Stockage : volume monté sur `/data` (garde la session WhatsApp et les programmations)
6. Une seule instance, 1 Go de mémoire minimum (Chromium)
7. Ouvrir l'URL (identifiant libre, mot de passe = ADMIN_PASSWORD), scanner le QR une seule fois

## Notes
- Fuseau : TZ=Africa/Abidjan (modifiable dans le Dockerfile)
- Automatiser WhatsApp Web va contre les conditions de WhatsApp : évite les rythmes trop rapides et ton numéro principal.
