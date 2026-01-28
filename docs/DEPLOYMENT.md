# 🚀 Guide de Déploiement Production - randomizer.games

Ce guide vous accompagne pour déployer votre application sur un VPS (DigitalOcean ou Hetzner Cloud) avec **randomizer.games**.

---

## 📊 Ressources Recommandées

### Option 1: Hetzner Cloud (Recommandé - Meilleur rapport qualité/prix)
- **CPX11**: 2 vCPU, 2GB RAM, 40GB SSD - ~4.5€/mois
- **CPX21**: 3 vCPU, 4GB RAM, 80GB SSD - ~9€/mois (recommandé)
- **CPX31**: 4 vCPU, 8GB RAM, 160GB SSD - ~17€/mois

### Option 2: DigitalOcean
- **Basic Droplet**: 1 vCPU, 1GB RAM - $6/mois (minimum)
- **Basic Droplet**: 2 vCPU, 2GB RAM - $12/mois (recommandé)
- **Basic Droplet**: 2 vCPU, 4GB RAM - $24/mois

**💡 Recommandation**: Hetzner CPX21 (3 vCPU, 4GB RAM) pour commencer.

---

## 🔐 Corrections de Sécurité Appliquées

### ✅ Protections ajoutées:

1. **Rate Limiting**
   - 100 requêtes/15 min pour API générale
   - 30 requêtes/min pour recherche
   - 10 requêtes/heure pour opérations d'écriture
   - 5 requêtes/min pour webhooks

2. **Protection NoSQL Injection**
   - Sanitization automatique avec `express-mongo-sanitize`
   - Validation stricte des ObjectIds MongoDB

3. **Protection SSRF (Server-Side Request Forgery)**
   - Whitelist de domaines autorisés pour proxy d'images
   - Blocage des IPs privées/internes
   - Validation stricte des URLs

4. **Gestion des erreurs sécurisée**
   - Pas de stack traces en production
   - Logging sécurisé des erreurs

5. **Headers de sécurité**
   - Helmet.js configuré
   - CSP (Content Security Policy)
   - CORS restreint en production

6. **Validation des inputs**
   - Validation `limit` et `page` (anti-DoS)
   - Sanitization des strings
   - Limite de taille des payloads (1MB)

7. **Cache sécurisé**
   - Limite de taille pour éviter memory leak
   - Nettoyage automatique

---

## 🛠️ Installation sur VPS

### 1. Prérequis sur le serveur

```bash
# Mettre à jour le système
sudo apt update && sudo apt upgrade -y

# Installer Node.js 20.x LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Installer MongoDB
wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc | sudo apt-key add -
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
sudo apt update
sudo apt install -y mongodb-org

# Démarrer MongoDB
sudo systemctl start mongod
sudo systemctl enable mongod

# Installer Nginx (reverse proxy)
sudo apt install -y nginx

# Installer PM2 (process manager)
sudo npm install -g pm2

# Installer Git
sudo apt install -y git
```

### 2. Configuration du firewall

```bash
# UFW (Ubuntu Firewall)
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

### 3. Cloner et configurer l'application

```bash
# Créer un utilisateur dédié (recommandé)
sudo adduser randomizer
sudo usermod -aG sudo randomizer
su - randomizer

# Cloner le projet
cd ~
git clone <votre-repo-git> randomizer-app
cd randomizer-app

# Installer les dépendances
npm install --production

# Copier et configurer les variables d'environnement
cp .env.example .env
nano .env
```

### 4. Configuration `.env` Production

```bash
NODE_ENV=production
PORT=3000
MONGODB_URI=mongodb://localhost:27017/randomizer

# Twitch (si streams activés)
TWITCH_CLIENT_ID=votre_client_id
TWITCH_CLIENT_SECRET=votre_secret

# Webhook GitHub (générer avec: openssl rand -hex 32)
GITHUB_WEBHOOK_SECRET=votre_secret_webhook
```

### 5. Configuration Nginx

```bash
sudo nano /etc/nginx/sites-available/randomizer.games
```

Contenu:

```nginx
server {
    listen 80;
    server_name randomizer.games www.randomizer.games;

    # Limite de taille des uploads
    client_max_body_size 2M;

    # Sécurité
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Cache pour les assets statiques
    location ~* \.(jpg|jpeg|png|gif|ico|css|js|svg|woff|woff2|ttf)$ {
        proxy_pass http://localhost:3000;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

Activer le site:

```bash
sudo ln -s /etc/nginx/sites-available/randomizer.games /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 6. Configurer SSL avec Let's Encrypt (HTTPS)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d randomizer.games -d www.randomizer.games
```

Certbot va automatiquement:
- Obtenir le certificat SSL
- Configurer Nginx pour HTTPS
- Mettre en place le renouvellement automatique

### 7. Démarrer l'application avec PM2

```bash
cd ~/randomizer-app

# Démarrer l'app
pm2 start server.js --name randomizer-api -i max

# Sauvegarder la configuration PM2
pm2 save
pm2 startup

# Copier/coller la commande affichée par PM2
```

Configuration PM2 avancée (optionnel):

```bash
# Créer ecosystem.config.js
nano ecosystem.config.js
```

```javascript
module.exports = {
  apps: [{
    name: 'randomizer-api',
    script: './server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    max_memory_restart: '1G'
  }]
};
```

Puis:

```bash
mkdir logs
pm2 start ecosystem.config.js
```

---

## 🌐 Configuration DNS

Dans votre registrar de domaine (où vous avez acheté randomizer.games):

### Records A
```
Type: A
Name: @
Value: <IP_DE_VOTRE_VPS>
TTL: 3600

Type: A
Name: www
Value: <IP_DE_VOTRE_VPS>
TTL: 3600
```

**⏰ Temps de propagation**: 1-48 heures (généralement < 2 heures)

---

## 🔔 Configuration Webhook GitHub

### Sur votre serveur

1. Générer un secret:
```bash
openssl rand -hex 32
```

2. Ajouter à `.env`:
```bash
GITHUB_WEBHOOK_SECRET=le_secret_genere
```

3. Redémarrer:
```bash
pm2 restart randomizer-api
```

### Sur GitHub (rando-list repository)

1. Aller sur https://github.com/video-game-randomizers/rando-list/settings/hooks
2. Cliquer "Add webhook"
3. Configurer:
   - **Payload URL**: `https://randomizer.games/api/sync-rando-list/webhook`
   - **Content type**: `application/json`
   - **Secret**: (le secret généré plus haut)
   - **Events**: Sélectionner "Just the push event"
   - **Active**: ✅ coché

---

## 📊 Monitoring et Maintenance

### Logs en temps réel

```bash
# Logs application
pm2 logs randomizer-api

# Logs Nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Logs MongoDB
sudo tail -f /var/log/mongodb/mongod.log
```

### Commandes PM2 utiles

```bash
pm2 status                # Statut des apps
pm2 restart randomizer-api # Redémarrer
pm2 stop randomizer-api    # Arrêter
pm2 delete randomizer-api  # Supprimer
pm2 monit                  # Monitoring interactif
```

### Mettre à jour l'application

```bash
cd ~/randomizer-app
git pull
npm install --production
pm2 restart randomizer-api
```

### Backup MongoDB

```bash
# Créer un script de backup
nano ~/backup-mongo.sh
```

```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/home/randomizer/backups/mongodb"
mkdir -p $BACKUP_DIR

mongodump --out=$BACKUP_DIR/backup_$DATE
tar -czf $BACKUP_DIR/backup_$DATE.tar.gz $BACKUP_DIR/backup_$DATE
rm -rf $BACKUP_DIR/backup_$DATE

# Garder seulement les 7 derniers backups
ls -t $BACKUP_DIR/*.tar.gz | tail -n +8 | xargs rm -f
```

```bash
chmod +x ~/backup-mongo.sh

# Ajouter au cron (tous les jours à 3h du matin)
crontab -e
# Ajouter: 0 3 * * * /home/randomizer/backup-mongo.sh
```

---

## 🔒 Sécurité Post-Déploiement

### 1. Désactiver l'accès SSH par mot de passe

```bash
sudo nano /etc/ssh/sshd_config
```

Modifier:
```
PasswordAuthentication no
PermitRootLogin no
```

```bash
sudo systemctl restart sshd
```

### 2. Fail2ban (protection brute force)

```bash
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

### 3. Mises à jour automatiques de sécurité

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

### 4. Monitoring avec PM2 Plus (optionnel)

```bash
pm2 register
# Suivre les instructions
pm2 link <public_key> <private_key>
```

---

## 🚨 Checklist de Déploiement

- [ ] VPS créé et SSH configuré
- [ ] Node.js, MongoDB, Nginx installés
- [ ] Firewall (UFW) configuré
- [ ] Application clonée et dépendances installées
- [ ] `.env` configuré avec valeurs production
- [ ] Nginx configuré et actif
- [ ] SSL/HTTPS activé avec Let's Encrypt
- [ ] DNS A records configurés (@ et www)
- [ ] PM2 démarré et configuré en auto-start
- [ ] Webhook GitHub configuré (si nécessaire)
- [ ] Backups MongoDB automatisés
- [ ] Monitoring actif (PM2 logs)
- [ ] Fail2ban installé
- [ ] Tester tous les endpoints: https://randomizer.games/api/health

---

## 📞 Troubleshooting

### L'application ne démarre pas

```bash
# Vérifier les logs
pm2 logs randomizer-api --lines 50

# Vérifier MongoDB
sudo systemctl status mongod

# Tester manuellement
cd ~/randomizer-app
NODE_ENV=production node server.js
```

### Erreur 502 Bad Gateway

```bash
# Vérifier que l'app tourne
pm2 status

# Vérifier Nginx
sudo nginx -t
sudo systemctl status nginx

# Logs Nginx
sudo tail -f /var/log/nginx/error.log
```

### DNS ne résout pas

```bash
# Vérifier la propagation
dig randomizer.games
nslookup randomizer.games

# Attendre jusqu'à 48h pour propagation complète
```

---

## 📈 Optimisations Futures

1. **CDN**: CloudFlare (gratuit) pour assets statiques
2. **MongoDB Atlas**: Base de données managée (backup auto, scaling)
3. **Redis**: Cache pour améliorer performances
4. **Monitoring**: Grafana + Prometheus
5. **Load Balancer**: Si traffic important
6. **Docker**: Containerisation pour déploiements simplifiés

---

**✅ Votre application est maintenant sécurisée et prête pour la production !**
