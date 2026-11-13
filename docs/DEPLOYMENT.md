# Déploiement en production

Mise en ligne de randomizer.games sur un VPS Hetzner Cloud (Ubuntu 24.04) qui héberge tout : l'application derrière Nginx et HTTPS, la base MongoDB et les synchronisations planifiées.

## Ce qui tourne sur le serveur

| Composant | Rôle |
|-----------|------|
| MongoDB 8.0 | La base, joignable uniquement depuis le serveur lui-même (`127.0.0.1`) |
| Node.js + PM2 | L'application (`server.js`), une seule instance |
| Nginx + Certbot | HTTPS et proxy vers l'application |
| crontab | Les synchronisations (racetime, tournois, rando-list, Archipelago) et les sauvegardes, via [`scripts/cron/run-job.sh`](../scripts/cron/run-job.sh) |

La base n'est pas exposée sur Internet : toutes les tâches récurrentes tournent sur le serveur (voir [ARCHITECTURE.md](ARCHITECTURE.md#tâches-planifiées)). GitHub Actions ne sert plus qu'aux tests (`tests.yml`).

## Dimensionnement

Un **CX23** (2 vCPU, 4 Go de RAM, 40 Go de disque) suffit :

- la base fait environ 300 Mo de données (110 Mo sur disque une fois compressée), dont 180 000 courses ;
- elle grossit d'environ 80 courses par jour, soit à peine 15 Mo sur disque par an ;
- tout tient en mémoire avec un cache MongoDB limité à 1 Go, ce qui laisse la place à Node et aux synchronisations.

Prévoir 2 Go de swap (étape 1) comme filet de sécurité. Passer à un CX33 seulement si `free -h` montre que le swap sert en permanence.

À la création du serveur : Ubuntu 24.04, datacenter européen, clé SSH, IPv4 publique, et un **Firewall** Hetzner n'ouvrant que les ports 22, 80 et 443. Les **Backups** Hetzner (+20 %) sont un bon complément.

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

# Swap de 2 Go
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Puis, en tant que `randomizer` :

```bash
# Node.js LTS (22.x)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx git

# PM2 (gestionnaire de processus)
sudo npm install -g pm2
```

## 2. Installer MongoDB

Dépôt officiel de MongoDB (le paquet `mongodb` d'Ubuntu est obsolète). `mongodb-org` installe aussi `mongosh` et `mongodump`/`mongorestore`.

```bash
sudo apt install -y gnupg curl
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
  | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

### Créer les utilisateurs

Tant que l'authentification n'est pas activée, `mongosh` se connecte sans mot de passe depuis le serveur. Générer deux mots de passe (`openssl rand -hex 24`, sans caractères à échapper dans une URI), puis :

```bash
mongosh
```

```js
use admin
db.createUser({ user: 'admin', pwd: '<mot de passe admin>', roles: ['root'] })

use randomizer-hub
db.createUser({ user: 'randomizer', pwd: '<mot de passe appli>', roles: [{ role: 'readWrite', db: 'randomizer-hub' }] })
```

`admin` ne sert qu'à la maintenance (restauration) ; l'application n'utilise que `randomizer`, limité à sa base.

### Activer l'authentification et limiter la mémoire

Dans `/etc/mongod.conf`, vérifier ou ajouter :

```yaml
net:
  port: 27017
  bindIp: 127.0.0.1

security:
  authorization: enabled

storage:
  wiredTiger:
    engineConfig:
      cacheSizeGB: 1
```

```bash
sudo systemctl restart mongod
mongosh "mongodb://randomizer:<mot de passe appli>@127.0.0.1:27017/randomizer-hub?authSource=randomizer-hub" --eval 'db.runCommand({ ping: 1 })'
```

Ne jamais ouvrir le port 27017, ni dans UFW ni dans le pare-feu Hetzner. Pour consulter la base depuis son poste (Compass, mongosh), passer par un tunnel SSH :

```bash
ssh -N -L 27018:127.0.0.1:27017 randomizer@<IP du VPS>
# puis se connecter à mongodb://randomizer:<mot de passe>@localhost:27018/randomizer-hub?authSource=randomizer-hub
```

## 3. Installer l'application

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

MONGODB_URI=mongodb://randomizer:<mot de passe appli>@127.0.0.1:27017/randomizer-hub?authSource=randomizer-hub

# Tournois (import depuis l'admin et synchronisations)
CHALLONGE_API_KEY=
CHALLONGE_USERNAME=
STARTGG_API_TOKEN=

# Page streams
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=

# Restreams archivés sur YouTube
YOUTUBE_API_KEY=
```

```bash
chmod 600 .env
npm run check-security
```

`check-security` vérifie les variables obligatoires et quelques règles du code. Corriger toute erreur avant de continuer.

## 4. Migrer les données depuis Atlas

Pour ne rien perdre pendant la copie :

1. **Arrêter toute synchro qui écrit encore dans Atlas.**
2. Attendre que les exécutions en cours se terminent.
3. Copier la base, depuis le VPS. Dans Atlas, l'IP du VPS doit être autorisée (*Network Access*) le temps de la copie.

   ```bash
   cd ~
   mongodump --uri "mongodb+srv://<user>:<password>@<cluster>.mongodb.net" --db randomizer-hub \
     --gzip --archive=atlas.archive.gz

   mongorestore --uri "mongodb://admin:<mot de passe admin>@127.0.0.1:27017/?authSource=admin" \
     --gzip --archive=atlas.archive.gz
   ```

4. Comparer le nombre de documents des deux côtés :

   ```bash
   mongosh "<URI Atlas>/randomizer-hub" --quiet --eval 'db.getCollectionNames().forEach(c => print(c, db[c].countDocuments()))'
   mongosh "mongodb://randomizer:<mot de passe appli>@127.0.0.1:27017/randomizer-hub?authSource=randomizer-hub" --quiet \
     --eval 'db.getCollectionNames().forEach(c => print(c, db[c].countDocuments()))'
   ```

Garder la base Atlas quelques semaines comme filet de sécurité avant de la supprimer.

## 5. Démarrer avec PM2

**Une seule instance** : les compteurs de rate limiting sont gardés en mémoire. Avec plusieurs processus (`-i max`, mode cluster), chacun compterait de son côté. Les sessions admin, elles, sont en base (collection `adminsessions`) : un redémarrage ne déconnecte pas l'admin.

```bash
cd ~/randomizer-app
pm2 start server.js --name randomizer --max-memory-restart 1G
pm2 save
pm2 startup        # puis exécuter la commande qu'il affiche
```

Vérifier : `curl http://127.0.0.1:3000/api/health`. En production, l'application n'écoute que sur `127.0.0.1` : seul Nginx, sur la même machine, lui parle (`HOST` dans `.env` pour une autre adresse).

## 6. Tâches planifiées

[`scripts/cron/run-job.sh`](../scripts/cron/run-job.sh) lance chaque tâche avec un verrou (une tâche encore en cours n'est pas relancée), une durée maximale et un journal dans `~/logs/<tâche>.log`.

`crontab -e` (en tant que `randomizer`, le serveur étant à l'heure UTC) :

```cron
PATH=/usr/local/bin:/usr/bin:/bin

*/5   * * * *  /home/randomizer/randomizer-app/scripts/cron/run-job.sh racetime
2-59/15 * * * *  /home/randomizer/randomizer-app/scripts/cron/run-job.sh tournaments-update
7-59/15 * * * *  /home/randomizer/randomizer-app/scripts/cron/run-job.sh schedule-sites
12-59/30 * * * * /home/randomizer/randomizer-app/scripts/cron/run-job.sh race-vods
0     6 * * *  /home/randomizer/randomizer-app/scripts/cron/run-job.sh rando-list
20    6 * * *  /home/randomizer/randomizer-app/scripts/cron/run-job.sh archipelago
30    8 * * *  /home/randomizer/randomizer-app/scripts/cron/run-job.sh tournaments-discover
0     10 * * * /home/randomizer/randomizer-app/scripts/cron/run-job.sh players
15    10 * * * /home/randomizer/randomizer-app/scripts/cron/run-job.sh challonge-check
30    3 * * *  /home/randomizer/randomizer-app/scripts/cron/run-job.sh backup
45    6 * * *  /home/randomizer/randomizer-app/scripts/cron/run-job.sh publish-assets
```

Ces horaires sont recopiés dans `services/job-health.js`, qui en tire l'horaire et la prochaine exécution affichés par la page **Monitoring** : les modifier aux deux endroits.

Tester chaque tâche une fois à la main, par exemple `scripts/cron/run-job.sh racetime && tail ~/logs/racetime.log`.

Pour rattraper une période où les tâches ne tournaient pas, voir [SYNC-WORKFLOW.md](SYNC-WORKFLOW.md#relancer-à-la-main-sur-une-période).

À la mise en place de la tâche `schedule-sites`, reprendre une fois les restreams des événements terminés : `node scripts/sync-schedule-sites.js --archive` (Mido's House et Hyrule Town Hall). Pour `race-vods`, reprendre une fois les 60 derniers jours : `node scripts/sync-race-vods.js --days 60`, puis `node scripts/sync-race-restreams.js --days 60` et, pour les temps forts plus anciens, `node scripts/sync-race-restreams.js --days 3650 --highlights` (à vérifier d'abord avec `--dry-run`). Pour localhorst, reprendre une fois tout l'historique : `node scripts/sync-localhorst.js --archive`, et de même pour les calendriers iCal : `node scripts/sync-ical-restreams.js --archive`. Pour l'ALTTPR League, reprendre une fois toutes les saisons : `node scripts/sync-alttpr-league.js`, et pour GDQ tous les marathons : `node scripts/sync-gdq-runs.js --all`.

La resynchronisation complète d'un jeu se lance en SSH :

```bash
cd ~/randomizer-app
node scripts/sync-racetime-game.js --game ootr                  # toutes les courses du jeu
node scripts/sync-racetime-game.js --game ootr --max-pages 100  # limité à 100 pages
```

### Rotation des journaux

`/etc/logrotate.d/randomizer` :

```text
/home/randomizer/logs/*.log {
    su randomizer randomizer
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
```

### Audience

Les pages publiques signalent chaque vue à `/api/seen` (sans cookie, voir
`services/audience.js`) ; l'onglet Audience de l'admin les affiche. Pour
reprendre les jours qui précèdent la mesure, depuis les logs Nginx (lisibles
par root seulement ; Nginx les garde 14 jours) :

```bash
zcat -f /var/log/nginx/access.log.* /var/log/nginx/access.log \
  | sudo -u randomizer node /home/randomizer/randomizer-app/scripts/import-audience-logs.js --dry-run
```

Sans `--dry-run`, les vues reprises des logs remplacent celles d'un import précédent.

## 7. Nginx

`/etc/nginx/sites-available/randomizer.games` :

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name randomizer.games www.randomizer.games;

    client_max_body_size 2M;
    # Pas de version de Nginx dans les en-têtes ni les pages d'erreur
    server_tokens off;

    location / {
        # Zones définies dans /etc/nginx/conf.d/ratelimit.conf (ci-dessous)
        limit_req zone=pages_ip burst=20 nodelay;
        limit_req zone=pages_all burst=60;
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

`/etc/nginx/conf.d/ratelimit.conf` limite le débit des pages rendues par l'application (chacune interroge MongoDB). Les fichiers statiques ne sont pas comptés et l'API garde ses propres limites (`middleware/security.js`) :

```nginx
map $uri $is_page {
    ~^/(api|assets|js|data|admin)/                                          0;
    ~*\.(css|js|json|png|webp|svg|ico|jpe?g|gif|txt|xml|map|woff2?)$        0;
    default                                                                 1;
}
map $is_page $page_ip  { 1 $binary_remote_addr; default ""; }
map $is_page $page_all { 1 all;                 default ""; }

# Par visiteur : 5 pages/s, 20 d'avance pour les rafales
limit_req_zone $page_ip  zone=pages_ip:10m  rate=5r/s;
# Tous visiteurs réunis : 20 pages/s, ce que tient un CX23 (2 vCPU, un processus
# Node). Au-delà, 60 requêtes attendent leur tour, les suivantes reçoivent 429.
limit_req_zone $page_all zone=pages_all:1m  rate=20r/s;
limit_req_status 429;
limit_req_log_level warn;
```

Les en-têtes de sécurité (via `helmet`) et la mise en cache des fichiers statiques sont déjà gérés par l'application : inutile de les redéfinir ici. L'application fait confiance au premier proxy (`trust proxy`), ce qui lui permet de voir la vraie IP des visiteurs pour le rate limiting. En production, elle redirige aussi (301) `www.randomizer.games` et le HTTP vers `https://randomizer.games`, pour qu'une page n'ait qu'une adresse dans les moteurs de recherche : l'en-tête `X-Forwarded-Proto` ci-dessus est donc indispensable.

```bash
sudo ln -s /etc/nginx/sites-available/randomizer.games /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## 8. DNS et HTTPS

Chez Namecheap : **Domain List → Manage → Advanced DNS**. Supprimer les enregistrements de parking par défaut, puis ajouter :

| Type | Host | Valeur |
|------|------|--------|
| A | `@` | IPv4 du VPS |
| A | `www` | IPv4 du VPS |
| AAAA | `@` | IPv6 du VPS |
| AAAA | `www` | IPv6 du VPS |

Une fois le DNS propagé (`dig randomizer.games`) :

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d randomizer.games -d www.randomizer.games
```

Certbot ajoute la configuration HTTPS et programme le renouvellement automatique. Le cookie de session admin n'est envoyé qu'en HTTPS en production : l'admin ne fonctionne qu'une fois le certificat en place.

## 9. Durcir le serveur

```bash
# SSH par clé uniquement
# Le nom compte : sshd garde la première valeur lue, et l'image du VPS fournit
# un 50-cloud-init.conf qui réactive les mots de passe
sudo nano /etc/ssh/sshd_config.d/00-hardening.conf
#   PasswordAuthentication no
#   PermitRootLogin no
sudo systemctl restart ssh
sudo sshd -T | grep passwordauthentication   # doit répondre « no »

# Bannissement des tentatives de connexion répétées
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban

# Mises à jour de sécurité automatiques
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

Node.js et MongoDB ne viennent pas des dépôts Ubuntu : sans ce fichier, leurs correctifs ne s'installent jamais seuls.

```bash
sudo tee /etc/apt/apt.conf.d/51unattended-upgrades-thirdparty <<'EOF'
Unattended-Upgrade::Origins-Pattern {
	"site=deb.nodesource.com";
	"origin=mongodb,label=mongodb";
};
EOF
```

Après une mise à jour du paquet `nodejs`, PM2 et le site tournent encore sur l'ancien binaire. `/usr/local/sbin/restart-app-if-node-changed`, appelé par apt (`/etc/apt/apt.conf.d/99restart-app-after-node`, `DPkg::Post-Invoke`), relance alors le service `pm2-randomizer` :

```sh
#!/bin/sh
for pid in $(pgrep -u randomizer -f "PM2|server\.js"); do
  if readlink "/proc/$pid/exe" 2>/dev/null | grep -q "node.*(deleted)"; then
    logger -t restart-app "node mis à jour : redémarrage de pm2-randomizer"
    systemctl restart pm2-randomizer
    exit 0
  fi
done
exit 0
```

Une mise à jour du noyau ou de la libc ne s'applique qu'au redémarrage. Le serveur redémarre donc seul, **uniquement quand une mise à jour l'exige** (`/var/run/reboot-required`), à 4h UTC le lendemain de son installation : après la sauvegarde de 3h30, avant les synchros de 6h. MongoDB, nginx, cron et PM2 (`pm2 startup` + `pm2 save`) sont lancés au démarrage, le site revient en une minute environ.

```bash
sudo tee /etc/apt/apt.conf.d/52unattended-upgrades-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF
apt-config dump | grep Automatic-Reboot   # vérification
```

L'onglet Monitoring de l'admin montre l'état de ces services, un redémarrage en attente et ses paquets. Un réglage système fait à la main doit survivre au redémarrage (fichier dans `/etc/sysctl.d/`, pas seulement `sysctl -w`).

## 10. Sauvegardes

La base n'existe plus que sur ce serveur : les sauvegardes sont indispensables.

La tâche `backup` (3h30 UTC) lance `npm run db:backup`, qui écrit une archive `mongodump` compressée dans `~/randomizer-app/backups/` et ne garde que les 7 plus récentes. `BACKUP_DIR` et `BACKUP_KEEP` dans `.env` changent le dossier et le nombre d'archives gardées.

Une sauvegarde restée sur le serveur ne protège pas contre sa perte. En garder une copie ailleurs, par exemple en la rapatriant régulièrement sur son poste :

```bash
rsync -av randomizer@<IP du VPS>:randomizer-app/backups/ ~/Backups/randomizer/
```

ou en la poussant vers une Storage Box Hetzner. Les Backups Hetzner (images du disque) sont un complément, pas un remplacement : une image prise pendant une écriture peut contenir une base incohérente.

### Restaurer

```bash
cd ~/randomizer-app
pm2 stop randomizer
mongorestore --uri "mongodb://admin:<mot de passe admin>@127.0.0.1:27017/?authSource=admin" \
  --gzip --archive=backups/<fichier>.archive.gz --drop
pm2 start randomizer
```

`--drop` remplace chaque collection par celle de l'archive.

## Mettre à jour

```bash
cd ~/randomizer-app
git pull
npm ci --omit=dev
npm run check-security
pm2 restart randomizer
```

Les tâches planifiées prennent le nouveau code à leur prochaine exécution.

Les histoires et les jaquettes des jeux modifiées depuis l'admin, ainsi que les jaquettes des jeux créés par la tâche `archipelago` (`fetch-covers.js`), sont écrites directement dans `public/data/history/` et `public/assets/covers/` sur le serveur. La tâche `publish-assets` les commite et les pousse sur `main` tous les jours à 6h45 UTC, après la tâche `archipelago` (clé de déploiement en écriture). Son commit est construit sur `origin/main` même si le serveur n'est pas encore déployé (le code du serveur ne bouge pas), et les fichiers publiés restent indexés sur le serveur pour que le prochain `git pull --ff-only` passe. Elle remet la publication au lendemain seulement si `main` a lui-même modifié des jaquettes ou histoires pas encore déployées, et échoue si le serveur a des commits absents de `main`. Le bouton « Lancer » de l'onglet Synchronisation passe par `scripts/cron/run-job.sh`, comme la crontab : mêmes journaux, même verrou.

## Checklist

- [ ] VPS : utilisateur non-root, SSH par clé, UFW et pare-feu Hetzner (22, 80, 443), swap
- [ ] MongoDB : authentification activée, `bindIp: 127.0.0.1`, cache limité à 1 Go
- [ ] `.env` complet, `ADMIN_TOKEN` fort, `chmod 600 .env`
- [ ] `npm run check-security` sans erreur
- [ ] Workflows GitHub désactivés, base copiée depuis Atlas, nombres de documents identiques
- [ ] PM2 lancé en une seule instance, `pm2 startup` configuré
- [ ] crontab en place, chaque tâche testée une fois, logrotate configuré
- [ ] Nginx actif, DNS (A/AAAA) propagé, HTTPS via Certbot
- [ ] `https://randomizer.games/api/health` répond
- [ ] Connexion au panneau admin OK
- [ ] fail2ban et mises à jour automatiques actifs
- [ ] Première sauvegarde présente dans `backups/`, copie hors du serveur en place

## Dépannage

| Symptôme | Où regarder |
|----------|-------------|
| L'app ne démarre pas | `pm2 logs randomizer --lines 50` ; souvent `ADMIN_TOKEN` absent ou `MONGODB_URI` incorrect |
| 502 Bad Gateway | `pm2 status`, puis `sudo nginx -t` et `/var/log/nginx/error.log` |
| Connexion admin refusée | HTTPS actif ? une seule instance PM2 ? |
| Erreur de connexion à la base | `sudo systemctl status mongod`, `sudo journalctl -u mongod -n 50` ; mot de passe ou `authSource` de l'URI |
| Une tâche en échec ou en retard | Page **Monitoring** de l'admin : état de chaque tâche et fin de son journal ; `cat ~/logs/status/<tâche>.json` |
| Pas de nouvelles courses | `tail ~/logs/racetime.log` ; `crontab -l` ; une exécution bloquée laisse « l'exécution précédente tourne encore » |
| Serveur lent, swap très utilisé | `free -h`, `htop` ; réduire `cacheSizeGB` ou passer à un CX33 |
