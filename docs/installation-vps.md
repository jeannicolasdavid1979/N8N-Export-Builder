# Installation sur un VPS

Le builder est un petit service web (Python). Il garde des clés d'API chiffrées : il ne s'expose jamais sans mot de passe ni sans HTTPS.

## Avec Docker (recommandé)

```bash
git clone https://github.com/jeannicolasdavid1979/N8N-Export-Builder.git
cd N8N-Export-Builder
cp .env.example .env
# Dans .env : N8NB_PASSWORD (long, aléatoire) et N8NB_SECRET_KEY :
python3 -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"   # ou : openssl rand -base64 32 | tr '+/' '-_'
docker compose up -d --build
curl -s http://127.0.0.1:8790/api/health        # {"ok": true, ...}
```

Le conteneur n'écoute que sur `127.0.0.1:8790`. Pour y accéder :

- **HTTPS public** : un proxy inverse (Caddy, voir `deploy/Caddyfile`, ou Nginx, ou Traefik s'il sert déjà n8n) vers `127.0.0.1:8790` ;
- **ou tunnel SSH**, sans rien ouvrir : `ssh -L 8790:127.0.0.1:8790 utilisateur@vps` puis `http://localhost:8790`.

## Avec Coolify

1. Nouvelle ressource, dépôt Git public ou privé, branche `main`, type de construction **Dockerfile**.
2. Port exposé : `8790`. Domaine : celui de votre choix ; Coolify pose le HTTPS.
3. Variables : `N8NB_PASSWORD` (long, aléatoire) et `N8NB_SECRET_KEY` (clé Fernet, voir plus haut). Sans mot de passe, le conteneur refuse de démarrer : c'est voulu.
4. Stockage persistant : un volume monté sur `/data` (clés chiffrées, fiches, workflows). Sans lui, tout est perdu à chaque déploiement.
5. Contrôle de santé : `GET /api/health` (sans mot de passe).
6. Mise à jour : « Redeploy » après chaque poussée, ou le déploiement automatique sur la branche.

## Sans Docker

```bash
python3 -m venv .venv && .venv/bin/pip install .
N8NB_PASSWORD=... N8NB_SECRET_KEY=... N8NB_DATA=/var/lib/n8n-builder .venv/bin/n8n-export-builder --host 127.0.0.1 --port 8790
```

Un service systemd fait l'affaire (`Restart=always`, variables dans un `EnvironmentFile` en droits 600).

## Relier le n8n du même VPS

Dans **Instances n8n** : type VPS, adresse publique HTTPS de n8n (celle que les agents du Hub appelleront), clé d'API n8n (Paramètres, API n8n). Si n8n n'est joignable qu'en interne, l'adresse depuis le conteneur est `http://host.docker.internal:5678` ; dans ce cas, à l'export vers le Hub, choisissez « Autre adresse » et saisissez l'adresse publique.

## Sauvegarde

Tout est dans le volume `builder-data` (fichier `builder.json` et `.secret` si `N8NB_SECRET_KEY` n'est pas fourni). Sans la clé Fernet, les clés d'API enregistrées sont illisibles : sauvegardez-la à part.

## Mise à jour

```bash
git pull && docker compose up -d --build
```
