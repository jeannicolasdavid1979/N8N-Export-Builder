# Prompt pour l'agent qui installe le builder sur le VPS

À copier tel quel dans l'agent qui a un accès SSH au VPS.

---

Installe N8N Export Builder sur ce VPS, à côté de n8n, sans rien casser de l'existant.

Contexte : c'est un service web Python (FastAPI) qui garde des clés d'API chiffrées. Il ne doit jamais être exposé sans mot de passe ni sans HTTPS. Dépôt : https://github.com/jeannicolasdavid1979/N8N-Export-Builder, branche `main`. Guide de référence dans le dépôt : `docs/installation-vps.md`.

Étapes :

1. Reconnaissance, sans rien modifier : système, Docker et Docker Compose présents ou non, ports déjà occupés (`ss -ltnp`), comment n8n tourne (Docker, service, adresse interne, adresse publique), quel proxy HTTPS est en place (Caddy, Nginx, Traefik) et comment il est configuré. Rapporte ce que tu trouves avant de continuer.
2. Clone le dépôt dans `/opt/n8n-export-builder` (branche `main`).
3. Crée `.env` à partir de `.env.example`, en droits 600 :
   - `N8NB_PASSWORD` : 32 caractères aléatoires (`openssl rand -base64 24`) ;
   - `N8NB_SECRET_KEY` : clé Fernet (`python3 -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"`, ou `openssl rand -base64 32 | tr '+/' '-_'`).
   Ne m'affiche jamais ces valeurs dans ton rapport ; dis-moi seulement où elles sont.
4. `docker compose up -d --build`. Le conteneur n'écoute que sur 127.0.0.1:8790. Vérifie : `curl -s http://127.0.0.1:8790/api/health` doit renvoyer `{"ok": true, ...}`, puis `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8790/api/state` doit renvoyer 401 (mot de passe exigé).
5. Accès HTTPS : si un proxy existe déjà, ajoute un hôte `builder.<domaine>` vers `127.0.0.1:8790` dans sa configuration, en suivant son style, et recharge-le sans couper n8n. Demande-moi le sous-domaine si tu ne le déduis pas de la configuration existante. S'il n'y a aucun proxy, n'en installe pas : indique-moi la commande de tunnel SSH `ssh -L 8790:127.0.0.1:8790 <utilisateur>@<vps>`.
6. Depuis le conteneur, vérifie que n8n est joignable : `docker compose exec builder python -c "import urllib.request;print(urllib.request.urlopen('http://host.docker.internal:5678/healthz').status)"` (adapte l'adresse selon ce que tu as trouvé à l'étape 1). Note l'adresse interne et l'adresse publique de n8n.
7. Sauvegarde : ajoute le volume Docker `builder-data` et le fichier `.env` à la sauvegarde existante s'il y en a une ; sinon, dis-le moi.

Interdits : ne modifie ni ne redémarre n8n, ne touche pas à ses données, n'ouvre aucun port public directement vers 8790, n'installe rien d'autre que ce qu'il faut pour le builder, ne désactive aucun pare-feu.

Rapport attendu : adresse d'accès au builder, emplacement du mot de passe, adresse interne et publique de n8n à saisir dans « Instances n8n », résultats des vérifications 4 et 6, et tout écart par rapport à ce plan.
