# Module de transcription — architecture, mesures et problèmes ouverts

Document de passation. Il décrit l'état réel du module de transcription en direct de
**Stark Meet**, une application de visioconférence auto-hébergée. Il inclut les mesures
faites en production, les conceptions qui ont échoué et pourquoi, ainsi que les questions
précises sur lesquelles un avis extérieur serait utile.

Rien ici n'est théorique : tous les chiffres viennent de la machine décrite au §1.

---

## 1. Contexte matériel et contraintes

**Machine unique**, un VPS Contabo :

| | |
|---|---|
| CPU | 8 cœurs (vCPU partagés, pas dédiés) |
| RAM | 23 Gio, dont ~17 déjà utilisés, **aucun swap** |
| Charge existante | ~60 conteneurs : deux piles Supabase complètes, Odoo, Grafana/Loki, Coolify, mailcow |
| Réseau | Docker bridge, Traefik en frontal, coturn pour le relais WebRTC |

**Contraintes de conception imposées par le projet :**

1. **Auto-hébergement obligatoire.** Le cahier des charges exige que l'audio ne quitte pas
   la machine (exigence RGPD, hébergement européen sous contrat de sous-traitance). Les API
   externes (Deepgram, Gladia…) sont donc une solution de repli, pas la cible.
2. **Aucune parole ne doit être perdue.** Arbitrage explicite du client : un transcript en
   retard est acceptable, un transcript troué ne l'est pas. Cette contrainte a renversé une
   conception antérieure (voir §6).
3. **La visioconférence est prioritaire.** Le module de transcription ne doit jamais
   dégrader l'audio/vidéo temps réel ni pouvoir faire tomber le serveur média.
4. **Usage réel visé : 2 à 3 participants.** Le cahier des charges parlait de 30, mais
   l'usage constaté est une conversation à deux.

---

## 2. Vue d'ensemble du flux

```
Navigateur (WebRTC)
   │  Opus 48 kHz
   ▼
mediasoup SFU (Node, conteneur Docker bridge)
   │  ① AudioLevelObserver sélectionne qui transcrire
   │  ② PlainTransport + Consumer par locuteur retenu
   │  RTP Opus → UDP vers l'hôte (10.0.1.1:51000-51099)
   ▼
Service de transcription (Python/FastAPI, conteneur --network host)
   │  ③ ffmpeg : RTP Opus → PCM s16le 16 kHz mono sur stdout
   │  ④ tampon mémoire par locuteur (30 min max), jamais vidé sans traitement
   │  ⑤ VAD Silero : découpe aux silences → « phrases »
   │  ⑥ faster-whisper (CTranslate2, int8, CPU) : 1 inférence par phrase
   ▼
   │  HTTP POST /internal/transcript (HTTPS via Traefik, secret partagé)
   ▼
mediasoup SFU (Node)
   │  ⑦ historique en mémoire + rediffusion Socket.IO sur `ctl:<meetingId>`
   ▼
Navigateurs de tous les participants
   ⑧ panneau latéral, tri chronologique
```

---

## 3. Composants, un par un

### 3.1 Sélection des locuteurs — `server-mediasoup.js`

Un `AudioLevelObserver` mediasoup est créé **par salle** :

```js
audioLevelObserver = await roomRouter.createAudioLevelObserver({
  maxEntries: 3,     // ⚠️ le défaut de mediasoup est 1
  threshold: -55,    // dBov
  interval: 400,     // ms
});
```

Chaque producteur audio est inscrit à sa création (`addProducer`). L'événement `volumes`
sert à décider **à qui attribuer une place de transcription** :

- une place s'ouvre dès qu'un locuteur est signalé actif ;
- elle se libère après **30 s** sans signal (hystérésis) ;
- plafond de **3 places simultanées** (contrainte CPU, voir §5).

Motivation : sans cette sélection, les trois premiers à produire du son occupaient les
places, y compris des auditeurs silencieux.

### 3.2 Fork RTP — `transcription-fork.js`

Pour chaque place attribuée :

```js
transport = await router.createPlainTransport({
  listenInfo: { protocol: 'udp', ip: '0.0.0.0', portRange: { min: 51100, max: 51199 } },
  rtcpMux: true,
  comedia: false,
});
consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
// POST /session/start au service Python (lui indique le port de destination)
await new Promise(r => setTimeout(r, 300));       // laisser ffmpeg se lier
await transport.connect({ ip: '10.0.1.1', port }); // ⚠️ sans ceci, aucun paquet n'est émis
await consumer.resume();
```

Points qui ont coûté cher à découvrir :

- **`transport.connect()` est indispensable** avec `comedia: false`. Sans lui, mediasoup
  n'émet rien, sans erreur ni avertissement.
- **`listenInfo.ip` détermine l'interface d'émission.** Lié à `127.0.0.1`, le transport ne
  peut pas atteindre l'hôte sur le bridge Docker : les paquets partent sur le loopback et
  disparaissent silencieusement.
- **Deux plages de ports distinctes** : 51000-51099 pour les destinations (ffmpeg),
  51100-51199 pour les sockets d'émission de mediasoup. Les confondre crée des conflits.
- L'**identité du locuteur est figée à l'ouverture du fork**, car Whisper rend son texte
  plusieurs secondes plus tard, quand le transport peut avoir été recyclé.

### 3.3 Décodage — ffmpeg, dans le service Python

SDP écrit à la volée, avec le payload type **réel du consumer** (pas une constante) :

```
c=IN IP4 0.0.0.0        ← et non 127.0.0.1 : détermine l'interface d'écoute de ffmpeg
m=audio <port> RTP/AVP <pt>
a=rtpmap:<pt> opus/48000/2
```

```
ffmpeg -protocol_whitelist file,rtp,udp -fflags +nobuffer -flags low_delay
       -i fork.sdp -ar 16000 -ac 1 -f s16le -
```

**Panne observée en production :** ffmpeg s'arrête de lui-même
(`Error during demuxing: Connection timed out`) s'il ne reçoit rien pendant un moment —
typiquement le creux entre son lancement et la première émission de mediasoup. La session
restait alors vivante avec **zéro octet reçu pendant toute la réunion**. Le service
surveille désormais le processus et le relance (20 tentatives max).

### 3.4 Tampon et découpage — `transcriber/service.py`

Un thread lit `ffmpeg.stdout` en continu et empile dans un `bytearray` par session.
**Rien n'est jamais retiré du tampon sans avoir été transcrit**, sauf au-delà de 30 minutes
de retard (garde-fou mémoire ; 30 min de PCM 16 kHz mono ≈ 58 Mio).

Toutes les 500 ms, un thread cherche la prochaine phrase :

- VAD **Silero** (embarqué avec faster-whisper) sur la tête du tampon ;
- une plage de parole est considérée **terminée** si elle est suivie d'au moins
  **1,0 s de silence**, ou si elle atteint **20 s** ;
- l'audio consommé est retiré du tampon, ce qui fait avancer une horloge de flux
  (`consumed_s`) utilisée pour l'horodatage.

### 3.5 Inférence

`faster-whisper` / CTranslate2, **int8, CPU**, un modèle par processus
(`ProcessPoolExecutor`, 2 processus — le GIL et CTranslate2 ne font pas bon ménage).

Configuration actuelle :

| Paramètre | Valeur | Raison |
|---|---|---|
| Modèle | `bofenghuang/whisper-small-cv11-french`, converti CT2 int8 | +5 points de justesse vs `small` générique, à vitesse identique |
| `beam_size` | 2 | 5 coûtait 14 s/phrase (voir §5) |
| `language` | `fr` forcé | la détection auto coûte 0,6 à 1,9 s **par appel** |
| `word_timestamps` | `False` | coût majeur, et inutile depuis le découpage au VAD |
| `condition_on_previous_text` | `False` | évite les boucles d'hallucination |
| `temperature` | `0.0` | **critique** : le repli par températures croissantes réessaie jusqu'à 6 fois sur du bruit — 36 s de calcul observés pour 2 s d'audio, session gelée |
| `vad_filter` | `False` | le VAD est déjà passé en amont |
| `chunk_length` | 10 | tentative de réduire le remplissage à 30 s (non encore validé) |
| `initial_prompt` | vocabulaire métier + nom du locuteur + 220 derniers caractères confirmés | corrige les noms propres et les enchaînements |

Jusqu'à **5 phrases en vol simultanément** par locuteur (file d'attente devant les
2 processus), avec republication **en ordre** : on ne dépile que par la tête.

Délai de garde de 60 s par inférence ; au-delà, la phrase est abandonnée et un marqueur
`[…]` est inséré si plus de 1,5 s d'audio a réellement été perdue.

### 3.6 Retour et diffusion

Le service poste sur `/internal/transcript` du serveur mediasoup. Comme le transcripteur
est en `--network host`, il ne peut pas joindre le conteneur mediasoup par son IP de
bridge : il repasse par l'**URL publique HTTPS**, donc la route est exposée sur Internet et
protégée par un **secret partagé** (`X-Transcriber-Secret`).

Chaque phrase porte un `spokenAt` — l'instant de **prononciation**, calculé à partir de
l'horloge du flux audio, et non l'instant de transcription. Serveur et navigateur insèrent
chaque phrase à sa place **chronologique**, ce qui permet de remettre en ordre deux
locuteurs dont les transcriptions n'avancent pas au même rythme.

L'historique vit **en mémoire** du serveur mediasoup (20 000 phrases max, purgé à la fin de
la réunion). Aucune persistance en base à ce jour.

---

## 4. Ce qui a été mesuré

Toutes les mesures sont faites **pendant une réunion réelle**, machine en charge normale.

### 4.1 Coût d'une inférence

`small` générique, int8, 4 threads, `beam=1`, sans `word_timestamps` :

| Audio fourni | Temps de calcul |
|---|---|
| 2,1 s | 5,96 s |
| 2,5 s | 5,08 s |
| 3,6 s | 6,42 s |
| 5,3 s | 5,59 s |
| 8,2 s | 5,43 s |
| 8,6 s | 8,10 s |

**Le coût est quasi indépendant de la durée de l'audio.** C'est cohérent avec le fait que
Whisper complète toute entrée à 30 s avant l'encodage : on paie 30 s d'encodeur pour
analyser 3 s de parole.

Autres relevés :

- `tiny`, mêmes réglages : **0,95 à 1,61 s** par phrase.
- `small` avec `beam=5` et le modèle français : **4,8 à 8,2 s**, montant jusqu'à **14,3 s**,
  avec un retard cumulé de **284 s** sur une seule réunion.
- `word_timestamps=True` : facteur ~2 à 3 sur le temps total.
- Détection de langue automatique : **0,6 à 1,9 s par appel**, mesuré à l'horodatage entre
  `Processing audio` et `Detected language`.

### 4.2 Justesse

Protocole : un texte de référence de **162 mots** lu à voix normale, comptage manuel des
substitutions, insertions et omissions.

| Configuration | Mots corrects | Erreurs |
|---|---|---|
| `small` générique, beam 5, contexte glissant | 81 % | 31 |
| `whisper-small-cv11-french`, beam 5, contexte glissant | **86 %** | 23 |

Nature des erreurs restantes : très majoritairement **morphologiques** (accords
singulier/pluriel, articles `de`/`des`, terminaisons verbales). Les noms propres et le
vocabulaire technique sont corrects depuis l'ajout du contexte glissant dans
`initial_prompt`.

### 4.3 Débit

- Un locuteur produit une phrase toutes les **4 à 6 s** de parole.
- Capacité observée avec 2 processus : environ **une phrase absorbée toutes les 3 à 5 s**.
- Conséquence : **1 à 2 locuteurs** tiennent le rythme. Au-delà, le retard croît sans se
  résorber jusqu'au premier silence prolongé.

---

## 5. Conceptions abandonnées, et pourquoi

Ces échecs sont documentés parce qu'ils délimitent l'espace des solutions.

### 5.1 Fenêtre glissante + LocalAgreement-2 — abandonné

Première conception : réanalyser toutes les 2 s une fenêtre des N dernières secondes, et ne
figer que ce que deux passes consécutives confirment.

**Deux échecs successifs.** D'abord une fenêtre réellement glissante (« les 4 dernières
secondes ») : deux passes consécutives ne partagent aucun préfixe commun, donc
LocalAgreement ne confirme jamais rien. Corrigé par un **ancrage** qui n'avance que sur le
texte confirmé — la variante correcte, celle de Whisper-Streaming.

Ensuite, sous charge, le mécanisme sacrifiait l'audio le plus ancien pour préserver la
latence : transcript troué, marqueur `[…]` devant presque chaque phrase. Contraire à la
contrainte n°2.

### 5.2 Découpage à intervalle fixe — abandonné

Couper toutes les 5 s tronquait une phrase sur deux (« Pour aujourd'hui, », « Je pense que
c'est l'une des choses que »), et chaque fragment partait au modèle sans le contexte de
l'autre moitié. Remplacé par le découpage au VAD.

### 5.3 `beam_size = 5` — abandonné

Gain de justesse réel mais coût prohibitif sur cette machine (14 s/phrase, 284 s de retard
cumulé). Ramené à 2.

---

## 6. Problèmes ouverts

### 6.1 Diaphonie acoustique — le plus gênant

Constaté en production sur une conversation à deux : le micro du participant A capte la voix
de B sortant de ses haut-parleurs. L'annulation d'écho du navigateur est active
(`echoCancellation`, `noiseSuppression`, `autoGainControl` tous à `true`) mais son résidu
suffit largement à Whisper.

Résultat observé : **62 phrases attribuées à A, 1 à B**, alors que B parlait autant. Le
texte de B était transcrit depuis le flux de A, donc sous le mauvais nom, et de qualité
dégradée.

Piste envisagée mais non implémentée : utiliser les volumes de l'`AudioLevelObserver` pour
suspendre la transcription d'un flux tant qu'un autre est nettement plus fort (un écho est
typiquement 15 à 30 dB sous la voix directe). Inconvénient : la parole réellement simultanée
serait perdue pour le locuteur le plus faible.

### 6.2 Débit insuffisant au-delà de 2 locuteurs

Voir §4.3. Levier principal identifié mais non validé : **réduire le remplissage à 30 s**
(`chunk_length`). Si l'encodeur travaille réellement sur la durée demandée plutôt que sur
30 s, le coût devrait chuter d'un facteur 3 environ.

### 6.3 Ordre d'affichage

Le tri chronologique par `spokenAt` est correct sur le fond, mais dégrade l'expérience :
une phrase en retard s'insère **au milieu** de l'historique, donc l'utilisateur ne voit rien
apparaître en bas de l'écran. Aucune solution d'affichage n'a encore été retenue.

### 6.4 Absence de persistance

Tout vit en mémoire et disparaît à la fin de la réunion. La suite du projet (compte-rendu
automatique par LLM) exige le transcript complet.

### 6.5 Hypothèses intermédiaires désactivées

L'interface sait afficher deux niveaux de certitude (texte confirmé en noir, hypothèse en
gris). Les hypothèses sont désactivées car chacune consomme une inférence qui doit revenir
aux phrases en attente. Conséquence : le premier mot d'une phrase apparaît environ
**10 à 13 s** après le début de la phrase (fin de phrase + 1 s de silence + inférence).

---

## 7. Questions sur lesquelles un avis serait utile

1. **Le remplissage à 30 s.** Le paramètre `chunk_length` de `faster-whisper` réduit-il
   réellement le travail de l'encodeur CTranslate2, ou seulement la segmentation ? Y a-t-il
   une perte de qualité mesurable à encoder des fenêtres de 8-10 s avec des poids entraînés
   sur 30 s ? Existe-t-il une meilleure méthode pour éviter ce gaspillage ?

2. **Architecture en flux sur CPU.** Un modèle nativement causal (transducteur type
   Zipformer via sherpa-onnx, Parakeet, ou équivalent) serait-il préférable à Whisper pour
   cet usage ? Qu'existe-t-il de crédible **en français**, à qualité comparable ou
   supérieure à `whisper-small` affiné, tournant sur 3-4 cœurs CPU ? Comment gérer la
   ponctuation et les majuscules, que ces modèles ne produisent généralement pas ?

3. **Diaphonie.** Existe-t-il une meilleure approche que le locuteur dominant ? Faut-il
   plutôt mélanger tous les flux en une piste unique et faire de la diarisation, sachant
   qu'on dispose gratuitement de l'attribution exacte via les flux séparés de mediasoup ?
   Peut-on soustraire le signal de A du signal de B côté serveur (annulation d'écho
   acoustique côté SFU) ?

4. **Découpage.** Le seuil de 1,0 s de silence est empirique. Existe-t-il une méthode plus
   robuste pour délimiter des unités de sens en conversation spontanée, sans couper au
   milieu d'une hésitation ni attendre trop longtemps ?

5. **Dimensionnement.** Pour dix participants simultanés avec ce type d'architecture, quelle
   est la configuration matérielle réaliste ? Le calcul mené donne 4 à 5 cœurs dédiés en
   permanence avec `small`, ce qui semble beaucoup — y a-t-il une erreur de raisonnement ?

6. **Justesse.** Les erreurs restantes sont morphologiques (accords). Est-ce un symptôme
   corrigeable par un affinage supplémentaire sur de la parole spontanée française, ou une
   limite structurelle de la taille `small` ? Un post-traitement grammatical léger
   serait-il pertinent avant l'envoi au LLM de compte-rendu ?

---

## 8. Fichiers concernés

| Fichier | Rôle |
|---|---|
| `server-mediasoup.js` | SFU, `AudioLevelObserver`, attribution des places, `/internal/transcript`, rediffusion Socket.IO |
| `transcription-fork.js` | `PlainTransport`, consumers, pool de ports, dialogue avec le service Python |
| `transcriber/service.py` | FastAPI, ffmpeg, tampon, VAD, inférence, renvoi |
| `transcriber/measure.py` | Mesure du RTF hors ligne |
| `transcriber/bench_window.py` | Mesure du coût selon la longueur de fenêtre et le `chunk_length` |
| `hooks/useRoomChannel.js` | Réception et tri chronologique côté navigateur |
| `components/conference/TranscriptPanel.js` | Affichage à deux niveaux de certitude |

Déploiement : mediasoup et l'application Next.js sont déployés par Coolify ; le service de
transcription tourne **hors Coolify**, lancé par `docker run --network host
--cpuset-cpus=4-7 --memory=3g`, pour que le `cpuset` protège la visioconférence et que le
service redémarre indépendamment du serveur média.
