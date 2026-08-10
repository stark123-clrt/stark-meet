# Stark Meet — infrastructure et incidents résolus

Ce document explique **pourquoi** l'infrastructure est configurée comme elle l'est. Chaque
réglage inhabituel vient d'une panne réelle : sans la trace du symptôme, quelqu'un
« nettoiera » un jour un paramètre qui paraît arbitraire et fera réapparaître le problème.

Pour chaque incident : le symptôme observé, la cause réelle, le correctif, et la commande
qui permet de vérifier que le correctif tient toujours.

---

## Vue d'ensemble du déploiement

Trois ressources Coolify sur un VPS Contabo (8 vCPU, 23 Gio, IP publique `167.86.108.98`).

| Ressource | Rôle | Ports |
|---|---|---|
| **Next.js** | interface, routes API | 3000 via Traefik |
| **mediasoup** | SFU (média WebRTC) + signalisation Socket.IO | 3001 via Traefik, `40000-40199` UDP+TCP en direct |
| **Supabase** (self-hosted) | Postgres, auth, storage | 8000 via Traefik |

`coturn` tourne **hors Docker**, directement sur l'hôte, sur le port `3478`.

La machine héberge aussi **mailcow** et **WireGuard**, qui consomment une part notable des
ressources. Environ 2 à 2,8 cœurs sont déjà occupés au repos ; il reste ~5 cœurs de marge.
**Aucun swap n'est configuré** : un dépassement mémoire ne ralentit pas, il tue un
processus, et le noyau ne choisit pas forcément la victime qu'on souhaiterait.

---

## 1. Aucun temps réel — tout demandait un rafraîchissement manuel

**Symptôme.** L'hôte ne voyait pas les demandes d'admission arriver. Un invité admis restait
bloqué sur l'écran d'attente. Il fallait recharger la page à chaque étape.

**Cause.** L'application reposait sur **Supabase Realtime**, dont le websocket n'est pas
exposé sur cette instance self-hosted. Aucun événement n'arrivait jamais aux clients.

**Correctif.** Tout le temps réel passe par le serveur Socket.IO de mediasoup, qui fonctionne
déjà puisque la vidéo circule. Un **plan de contrôle** distinct du plan média a été ajouté
dans [`server-mediasoup.js`](../server-mediasoup.js) : room logique `ctl:<meetingId>`,
événements `control:join`, `control:participant-updated`, `control:meeting-updated`,
`control:chat`, `control:chat-reaction`, `force-muted`, `control:ejected`.

Les deux plans sont séparés parce qu'un invité en salle d'attente doit recevoir les
événements de contrôle **avant** d'avoir le droit de produire du média.

Supabase reste la base de données. Un rechargement de réconciliation toutes les 15 secondes
sert de filet, et une resynchronisation est forcée à chaque reconnexion du canal.

**Vérification.** `node scratchpad/test-control.js` — 10 contrôles automatisés sur deux
clients réels (admission, exclusion, mute, verrouillage, chat, réactions).

---

## 2. Le mute forcé de l'hôte n'avait aucun effet

**Symptôme.** L'hôte coupait le micro d'un participant ; celui-ci continuait de s'entendre.

**Cause.** L'action n'écrivait qu'un `force_muted` en base. Rien ne coupait le flux, et
personne ne recevait l'information — voir l'incident 1.

**Correctif.** La coupure est appliquée **côté serveur** : le producer audio de la cible est
mis en pause dans le SFU, donc plus aucun paquet n'est relayé, quoi que fasse son navigateur.
L'état est mémorisé par utilisateur dans `forceMutedUsers`, si bien qu'un participant muté
qui recharge sa page est repausé dès qu'il reproduit. Un `resumeProducer` est refusé tant que
l'hôte n'a pas levé la coupure.

Le dé-mute ne rallume volontairement pas le micro : il lève l'interdiction et laisse la
personne se réactiver elle-même — l'hôte ne doit pas pouvoir ouvrir un micro à distance.

---

## 3. À partir du 3ᵉ participant, plus aucun flux

**Symptôme.** À deux, tout fonctionnait. Le troisième arrivant ne voyait ni n'entendait
personne.

**Cause.** Le serveur choisissait « le premier transport de réception venu » pour créer le
consumer, sans tenir compte du client qui le demandait. Le consumer était donc créé sur un
transport DTLS différent de celui sur lequel le client l'attendait.

**Correctif.** Le client transmet le `transportId` cible dans l'événement `consume`, et le
serveur l'utilise. Au passage, le client n'ouvre plus qu'**un seul** transport de réception
partagé par tous les pairs, au lieu d'un par pair — voir l'incident 4.

---

## 4. Plafond invisible de 12 participants par réunion

**Symptôme.** Aucun, jusqu'au 13ᵉ participant — puis une erreur d'allocation de port peu
explicite. Invisible en test à deux.

**Cause.** La plage `40000-40199` (200 ports) était découpée par worker. Avec 8 workers, cela
faisait **25 ports par worker**. Chaque transport WebRTC consomme un port UDP, chaque
participant utilise deux transports → **12 participants**.

Et comme un router mediasoup ne migre pas entre workers, **une réunion vit entièrement sur
sa tranche** : le plafond était par réunion, pas global.

**Correctif.** `MEDIASOUP_WORKERS=3`. La tranche passe à 66 ports par worker, soit
**33 participants par réunion**.

Le nombre de workers a donc deux effets opposés : plus de workers = plus de cœurs
exploités, mais moins de ports par réunion. Trois est le compromis retenu pour un objectif
de 30 participants.

**Vérification.**

```
docker logs $(docker ps --format '{{.Names}}' | grep ecvdu6szrzk) 2>&1 | grep -i worker
```

Attendu : trois workers, tranches `40000-40065`, `40066-40131`, `40132-40197`.

**Piste pour aller plus loin.** `worker.createWebRtcServer()` permet à tous les transports
d'un worker de partager **un seul** port UDP et un seul TCP. Six ports publiés au total, et
le plafond disparaît. Non fait — inutile tant que 33 suffit.

---

## 5. 3,6 Gio de RAM perdus en mappage de ports

**Symptôme.** 16 Gio sur 23 déjà consommés au repos, et 12 000 à 24 000 changements de
contexte par seconde.

**Cause.** **826 processus `docker-proxy`**, alors que mediasoup n'en explique que 400
(200 ports × TCP+UDP). Docker mappait la plage **en IPv4 *et* en IPv6** :
200 × 2 protocoles × 2 familles = 800, plus une vingtaine pour Supabase.

Or `listenIps: [{ ip: '0.0.0.0' }]` est une écoute **IPv4 uniquement**, et `announcedIp` est
une adresse IPv4. Les 400 proxies IPv6 transféraient vers un service qui n'écoute pas en
IPv6 : ils ne servaient à rien, dans aucun scénario.

**Correctif.** Préfixer explicitement les Port Mappings par `0.0.0.0:`, ce qui interdit à
Docker de dupliquer en IPv6 :

```
0.0.0.0:40000-40199:40000-40199/udp,0.0.0.0:40000-40199:40000-40199/tcp
```

**Résultat mesuré** : 826 → **426** processus, 3 626 Mio → **1 847 Mio**. **1,78 Gio rendus.**

**Vérification.**

```
ps aux | grep -c docker-proxy
ps -o rss= -C docker-proxy | awk '{s+=$1} END {print s/1024 " MiB"}'
```

⚠️ **Ne pas retirer `enableTcp: true`** pour économiser les 200 proxies restants : c'est le
repli ICE des réseaux qui bloquent l'UDP.

---

## 6. Sortie silencieuse de la réunion après une coupure réseau

**Symptôme.** Un téléphone passant du Wi-Fi à la 4G restait affiché « connecté » mais
n'échangeait plus rien. Panne trompeuse, pire qu'un échec franc.

**Cause.** Socket.IO se reconnectait bien, mais le serveur avait détruit le peer à la
déconnexion (`cleanupPeer`) et le socket revenait avec un **nouvel identifiant**. Personne ne
rejouait `join-room`.

**Correctif.** Dans [`useMediasoup.js`](../hooks/useMediasoup.js), la séquence d'adhésion est
isolée dans `establishSession(stream)`, **rejouable**. À la reconnexion : `resetMediaSession()`
ferme les objets périmés, puis la séquence est rejouée **avec le même flux local**, sans
redemander l'accès caméra.

Quatre pièges traités :

- **le device est rechargé** — si la salle s'était vidée, le router a été fermé et recréé,
  avec de nouvelles capacités RTP ;
- **les signaux éphémères sont réémis** — main levée et partage d'écran, que le serveur a
  oubliés avec le peer ;
- **l'état du micro est restauré** — un micro coupé avant la coupure ne doit pas revenir en
  émettant ;
- **un départ volontaire n'entraîne aucune reconnexion** — `hasJoinedRef` est remis à zéro.

Un bandeau apparaît **dès la coupure**, pas seulement au retour.

**Vérification.** Couper le Wi-Fi d'un téléphone une dizaine de secondes en pleine réunion,
puis le rallumer. La réunion doit reprendre sans rechargement.

---

## 7. Impossible de se connecter derrière un réseau fermé

**Symptôme.** Aucun en test — PC et téléphone sur le même réseau réussissent toujours en
direct. Le problème n'apparaît que chez un utilisateur derrière un NAT strict ou un réseau
d'entreprise, et il ne se connecte jamais.

**Cause.** Aucun serveur TURN. Le client doit joindre le SFU directement, ce qu'un réseau
filtrant interdit.

**Correctif.** `coturn` installé sur l'hôte, hors Docker.

### Configuration `/etc/turnserver.conf`

```
listening-port=3478
listening-ip=167.86.108.98
relay-ip=167.86.108.98
external-ip=167.86.108.98
realm=stark-meet
server-name=stark-meet
fingerprint
use-auth-secret
static-auth-secret=<secret>
min-port=50000
max-port=50500
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
```

**Trois points non négociables :**

**`listening-ip` doit être l'IP publique, pas `0.0.0.0`.** Avec `0.0.0.0`, coturn énumère
*toutes* les interfaces et s'attache à chacune — y compris les dizaines de ponts Docker
(`10.0.x.1`, `172.x.x.1`), sur des adresses qu'aucun client externe ne peut joindre.

**Les six lignes `denied-peer-ip` sont une protection, pas du confort.** Sans elles, le
serveur TURN relaie vers n'importe quelle adresse — dont `127.0.0.1` et le réseau Docker.
N'importe qui pourrait s'en servir pour atteindre **Postgres et Supabase**, qui tournent sur
la même machine.

**Pas de TLS sur le 443** : Traefik l'occupe déjà, et il ne sait pas relayer du TURN. Les
réseaux n'autorisant strictement que le 443 ne sont donc pas couverts. Il faudrait une
seconde IP publique.

### Identifiants temporaires

`use-auth-secret` signifie que coturn ne gère pas de comptes : il valide un couple dérivé du
secret partagé. La route [`app/api/turn/route.js`](../app/api/turn/route.js) les fabrique —
nom = `<expiration>:stark-meet`, mot de passe = `base64(HMAC-SHA1(secret, nom))`, validité
4 heures.

Le navigateur voit forcément ces identifiants : ils sont publics par nature. Avec un mot de
passe **fixe**, quiconque lit le JavaScript disposerait d'un relais de bande passante gratuit
et permanent. Signés et datés, ils ne valent plus rien après expiration.

⚠️ `TURN_SECRET` va sur la ressource **Next.js**, **sans** préfixe `NEXT_PUBLIC_`. Avec ce
préfixe, Next.js l'inclurait dans le bundle envoyé au navigateur.

### Vérification

```
ss -tulpn | awk '/turnserver/ {print $1, $5}' | sort -u
grep -c '^denied-peer-ip' /etc/turnserver.conf
```

Attendu : `tcp 167.86.108.98:3478`, `udp 167.86.108.98:3478`, et `6`. **Deux lignes, pas
quarante** — plus, c'est que `listening-ip` est revenu à `0.0.0.0`.

**Test de bout en bout.** Ajouter `?forceRelay` à l'URL d'une réunion force ICE à n'utiliser
que TURN. Sans cela le chemin direct est toujours choisi et le relais n'est jamais exercé :
on ne découvrirait la panne qu'au premier utilisateur bloqué.

```
https://<domaine>/room/<CODE>?forceRelay
```

Validé le 10/08/2026 : connexion réussie entre la France et le Maroc, relais forcé.

---

## 8. Son dédoublé sur la personne à l'écran

**Symptôme.** Un son creux, métallique, « comme deux micros côte à côte ».

**Cause.** La personne mise en avant est rendue **deux fois** — grande vue et vignette du
bandeau — et chaque `VideoCard` créait son propre `<audio>` sur le même flux. Deux sorties
jamais parfaitement synchronisées produisent un filtrage en peigne.

**Correctif.** `playAudio={false}` sur la grande vue ; c'est la vignette qui porte l'audio,
et elle est toujours présente. L'analyseur de niveau reste actif des deux côtés : il ne
produit aucun son.

**À ne pas confondre** avec l'effet larsen de deux appareils dans la même pièce, qui est de
l'acoustique et qu'aucun code ne corrigera. L'indice qui les distingue : le larsen disparaît
au casque, le dédoublement non.

---

## Configuration de référence

### Ressource mediasoup

```
MEDIASOUP_WORKERS=3
MEDIASOUP_MIN_PORT=40000
MEDIASOUP_MAX_PORT=40199
MEDIASOUP_ANNOUNCED_IP=167.86.108.98
CLIENT_URL=https://<domaine-nextjs>
```

Port Mappings : `0.0.0.0:40000-40199:40000-40199/udp,0.0.0.0:40000-40199:40000-40199/tcp`

⚠️ `MEDIASOUP_MIN_PORT`/`MAX_PORT` doivent correspondre **exactement** aux ports publiés. Si
mediasoup peut tirer un port hors de ce qui est mappé, il en attribuera parfois un
injoignable — et les connexions échoueront de façon aléatoire, sans motif apparent.

### Ressource Next.js

```
NEXT_PUBLIC_SUPABASE_URL=https://<domaine-supabase>
NEXT_PUBLIC_SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…
NEXT_PUBLIC_MEDIASOUP_URL=https://<domaine-mediasoup>
NEXT_PUBLIC_APP_URL=https://<domaine-nextjs>
TURN_HOST=167.86.108.98
TURN_SECRET=…
```

Règle simple : tout ce qui commence par `NEXT_PUBLIC_` finit dans le navigateur.

### Ressource Supabase

```
GOTRUE_EXTERNAL_GOOGLE_ENABLED=true
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=…
GOTRUE_EXTERNAL_GOOGLE_SECRET=…
GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI=https://<domaine-supabase>/auth/v1/callback
GOTRUE_SITE_URL=https://<domaine-nextjs>
ADDITIONAL_REDIRECT_URLS=https://<domaine-nextjs>/**
API_EXTERNAL_URL=https://<domaine-supabase>
```

⚠️ `GOTRUE_SITE_URL` valait l'URL de Supabase par défaut, ce qui déposait les retours OAuth
sur Supabase Studio au lieu de l'application. L'URL de redirection déclarée dans Google
Console est celle de **Supabase** (`/auth/v1/callback`), pas celle du frontend : c'est
Supabase qui échange le code et fabrique la session.

---

## Limites connues

**Le CPU d'un worker devient la contrainte avant 30 personnes.** Une réunion vit sur un
router, donc un worker, donc un cœur. À 30 participants caméra ouverte avec une grille qui
affiche tout le monde : 30 producers, 30 × 29 = 870 consumers vidéo, autant en audio, soit
~1 740 consumers sur un cœur. L'ordre de grandeur pour un worker mediasoup est de quelques
centaines. Augmenter `MEDIASOUP_WORKERS` n'aide pas : cela répartit les réunions entre
cœurs, pas une réunion sur plusieurs cœurs.

Leviers, par rentabilité : pagination des consumers (n'en consommer que les tuiles
affichées), simulcast, audio limité aux N locuteurs actifs, puis `pipeToRouter`.

**Aucun swap.** Un pic mémoire tue un processus. Avant d'ajouter un service gourmand,
prévoir `MALLOC_ARENA_MAX=2` et une limite mémoire Docker explicite, pour que le noyau tue
le nouveau venu plutôt que Postgres.

**La clôture d'une réunion dépend du bouton « Quitter ».** Si la dernière personne ferme son
onglet, le statut reste `active` en base. L'affichage reste juste — le tableau de bord se
fonde sur l'heure de fin — mais le statut ne bouge pas.

**RLS permissive.** Toutes les politiques Supabase sont en `using (true)`. Posture MVP
assumée ; un durcissement est un chantier à part, à faire avant une mise en service réelle.

**Réseaux n'autorisant que le port 443** non couverts, faute d'une seconde IP publique pour
y placer TURN sur TLS.
