# Déploiement en production

Mise en ligne de randomizer.games sur un VPS Hetzner Cloud (Ubuntu 24.04), derrière Nginx et HTTPS.

## Avant de commencer : où vit la base ?

Les workflows GitHub Actions (voir [ARCHITECTURE.md](ARCHITECTURE.md)) écrivent **directement dans la base** depuis les serveurs de GitHub, avec le secret `MONGODB_URI`. La base doit donc être joignable depuis Internet.

- **Recommandé : MongoDB Atlas.** Le VPS ne fait tourner que l'application, et les workflows continuent de fonctionner sans changement. Dans Atlas, autoriser l'IP du VPS (*Network Access*). Les workflows, eux, ont besoin d'un accès depuis `0.0.0.0/0`, car les IP de GitHub changent : utiliser un utilisateur dédié avec un mot de passe long.
- **MongoDB sur le VPS** : n'exposez pas le port 27017 publiquement. Dans ce cas, les workflows ne peuvent plus joindre la base, et il faut lancer les scripts de synchronisation par `cron` sur le VPS (mêmes commandes que dans les workflows).

La suite part sur Atlas.

## Dimensionnement

L'application tient sur une petite instance : **2 vCPU, 4 Go de RAM** suffisent largement (gamme CX ou CPX chez Hetzner). Choisir un datacenter européen proche des utilisateurs.

## 1. Préparer le serveur

Connecté en `root` la première fois :

```bash
apt update && apt upgrade -y

# Utilisateur dédié
adduser randomizer
usermod -aG sudo randomizer
rsync --archive --chown=randomizer:randomizer ~/.ssh /home/randomizer

# Pare-feu
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

Puis, en tant que `randomizer` :

```bash
# Node.js LTS (22.x)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx git

# PM2 (gestionnaire de processus)
sudo npm install -g pm2
```

## 2. Installer l'application

```bash
cd ~
git clone https://github.com/queled/randomizer.games.git randomizer-app
cd randomizer-app
npm ci --omit=dev
cp .env.example .env
nano .env
```

### `.env` de production

```bash
NODE_ENV=production
PORT=3000
SITE_URL=https://randomizer.games

# Obligatoire : le serveur refuse de démarrer sans
ADMIN_TOKEN=            # openssl rand -hex 32

MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/randomizer

# Tournois (import depuis l'admin)
CHALLONGE_API_KEY=
CHALLONGE_USERNAME=
STARTGG_API_TOKEN=

# Page streams
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=

# Facultatif : état des workflows dans l'admin
GITHUB_TOKEN=
GITHUB_REPO=queled/randomizer.games
```

```bash
chmod 600 .env
npm run check-security
```

`check-security` vérifie les variables obligatoires et quelques règles du code. Corriger toute erreur avant de continuer.

## 3. Démarrer avec PM2

**Une seule instance** : les sessions admin et les compteurs de rate limiting sont gardés en mémoire. Avec plusieurs processus (`-i max`, mode cluster), une connexion admin ouverte sur l'un ne serait pas reconnue par les autres.

```bash
pm2 start server.js --name randomizer --max-memory-restart 1G
pm2 save
pm2 startup        # puis exécuter la commande qu'il affiche
```

Vérifier : `curl http://localhost:3000/api/health`.

## 4. Nginx

`/etc/nginx/sites-available/randomizer.games` :

```nginx
server {
    listen 80;
    server_name randomizer.games www.randomizer.games;

    client_max_body_size 2M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

Les en-têtes de sécurité (via `helmet`) et la mise en cache des fichiers statiques sont déjà gérés par l'application : inutile de les redéfinir ici. L'application fait confiance au premier proxy (`trust proxy`), ce qui lui permet de voir la vraie IP des visiteurs pour le rate limiting.

```bash
sudo ln -s /etc/nginx/sites-available/randomizer.games /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## 5. DNS et HTTPS

Chez le registrar, deux enregistrements **A** (et **AAAA** pour l'IPv6 fournie par Hetzner) :

| Nom | Valeur |
|-----|--------|
| `@` | IP du VPS |
| `www` | IP du VPS |

Une fois le DNS propagé (`dig randomizer.games`) :

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d randomizer.games -d www.randomizer.games
```

Certbot ajoute la configuration HTTPS et programme le renouvellement automatique. Le cookie de session admin n'est envoyé qu'en HTTPS en production : l'admin ne fonctionne qu'une fois le certificat en place.

## 6. Durcir le serveur

```bash
# SSH par clé uniquement
sudo nano /etc/ssh/sshd_config.d/hardening.conf
#   PasswordAuthentication no
#   PermitRootLogin no
sudo systemctl restart ssh

# Bannissement des tentatives de connexion répétées
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban

# Mises à jour de sécurité automatiques
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

Activer aussi le **pare-feu Hetzner** (console Cloud) avec les seuls ports 22, 80 et 443, et les **backups** du serveur si besoin.

## 7. Sauvegardes

Atlas propose des sauvegardes selon l'offre choisie. En complément, un export quotidien sur le VPS :

```bash
crontab -e
# 0 3 * * * cd ~/randomizer-app && /usr/bin/npm run db:backup >> ~/backup.log 2>&1
```

`db:backup` écrit un export JSON de chaque collection dans `backups/`. Penser à purger les anciens dossiers et à en garder une copie hors du serveur.

## Mettre à jour

```bash
cd ~/randomizer-app
git pull
npm ci --omit=dev
npm run check-security
pm2 restart randomizer
```

## Checklist

- [ ] Base Atlas créée ; IP du VPS autorisée ; utilisateur dédié
- [ ] Secrets GitHub Actions à jour (`MONGODB_URI`, `STARTGG_API_TOKEN`, `CHALLONGE_API_KEY`)
- [ ] VPS : utilisateur non-root, SSH par clé, UFW et pare-feu Hetzner
- [ ] `.env` complet, `ADMIN_TOKEN` fort, `chmod 600 .env`
- [ ] `npm run check-security` sans erreur
- [ ] PM2 lancé en une seule instance, `pm2 startup` configuré
- [ ] Nginx actif, DNS (A/AAAA) propagé, HTTPS via Certbot
- [ ] `https://randomizer.games/api/health` répond
- [ ] Connexion au panneau admin OK
- [ ] fail2ban et mises à jour automatiques actifs
- [ ] Sauvegardes en place

## Dépannage

| Symptôme | Où regarder |
|----------|-------------|
| L'app ne démarre pas | `pm2 logs randomizer --lines 50` ; souvent `ADMIN_TOKEN` absent ou `MONGODB_URI` incorrect |
| 502 Bad Gateway | `pm2 status`, puis `sudo nginx -t` et `/var/log/nginx/error.log` |
| Connexion admin refusée | HTTPS actif ? une seule instance PM2 ? |
| Pas de nouvelles courses | Onglet **Actions** de GitHub : le workflow échoue-t-il à joindre la base ? |
