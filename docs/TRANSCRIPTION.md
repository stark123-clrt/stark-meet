# Transcription en direct — architecture de référence

Document de référence du module de transcription de **Stark Meet**. Il décrit
l'architecture **en production depuis le 13 août 2026**, les mesures qui la
valident, et les modes de panne qu'elle a supprimés.

Les trois autres documents de ce dossier sont **historiques** :
`TRANSCRIPTION-ARCHITECTURE.md` décrit la chaîne Whisper abandonnée,
`TRANSCRIPTION-AUDIO-PIPELINE.md` explique les formes que prend l'audio — toujours
valable — et `TRANSCRIPTION-V2-REVUE.md` conserve les pièges relevés pendant la
conception. Ce fichier-ci fait foi.

---

## 1. Le principe

Le texte s'affiche **pendant** que la personne parle, et non après.

C'est la conséquence directe d'un choix de modèle. Whisper est **non causal** :
son encodeur regarde une fenêtre de 30 secondes entière avant de produire quoi
que ce soit, et il faut donc attendre la fin d'une phrase, puis payer une
inférence complète. Mesuré sur cette machine : 10 à 13 secondes avant le premier
mot, et jusqu'à 284 secondes de retard accumulé sur une réunion.

Un **transducteur** (Zipformer, via sherpa-onnx) est causal : il consomme l'audio
au fil de l'eau, garde un état interne, et émet des mots sans jamais revenir en
arrière. Il décide aussi lui-même de la fin d'une phrase, sur un critère
linguistique — l'émission répétée de jetons vides — et non sur un seuil de
silence réglé à la main.

Aucun réglage n'aurait fait franchir cet écart à Whisper : c'est une propriété
d'architecture, pas de performance.

---

## 2. Le flux

```
Navigateur ─── Opus 48 kHz, SRTP ───▶ mediasoup SFU (Node)
                                          │
                        ① AudioLevelObserver : qui parle ?
                        ② DirectTransport  : paquets RTP en mémoire
                                          │
                              WebSocket binaire (ws://passerelle:8077/stream)
                                          │
                                          ▼
                          Service de transcription (Python, cpuset 4-7)
                        ③ dépaquetage RTP + tampon de gigue
                        ④ décodage Opus (libopus, dissimulation de perte)
                        ⑤ rééchantillonnage 48 → 16 kHz (soxr, à état)
                        ⑥ sherpa-onnx, transducteur causal
                                          │
                              texte, sur la MÊME connexion
                                          │
                                          ▼
                          mediasoup ⑦ historique + tri chronologique
                                          │
                               Socket.IO `ctl:<meetingId>`
                                          ▼
                          Navigateurs : hypothèse en gris, phrase en noir
```

Point de conception important : **le texte revient par la connexion qui apporte
l'audio**. La version précédente rappelait le serveur par HTTP, ce qui obligeait à
exposer une route sur Internet et à la protéger par un secret partagé. Ce chemin
n'existe plus.

---

## 3. Les composants

### 3.1 Sélection des locuteurs — `server-mediasoup.js`

Un `AudioLevelObserver` par salle décide à qui attribuer une place de
transcription :

```js
audioLevelObserver = await roomRouter.createAudioLevelObserver({
  maxEntries: 3,     // ⚠️ le défaut de mediasoup est 1
  threshold: -55,    // dBov
  interval: 400,     // ms
});
```

Une place s'ouvre dès qu'un locuteur est entendu, et se libère après **30 secondes**
de silence. Cette hystérésis est délibérément longue : refermer vite coûtait le
début de la phrase suivante, le temps de rétablir le flux.

### 3.2 Extraction — `transcription-stream.js`

```js
const transport = await router.createDirectTransport();
const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
consumer.on('rtp', (packet) => socket.send(packet));
await consumer.resume();
```

`DirectTransport` livre les paquets **en mémoire**, sans réseau. Ni port, ni
fichier SDP, ni `transport.connect()`, ni sous-processus.

L'identité du locuteur est **figée à l'ouverture** et n'est jamais relue ensuite :
le texte arrive plus tard, quand le transport peut avoir été réattribué.

### 3.3 Dépaquetage — `transcriber/streaming.py`

C'est la partie la plus délicate, et celle qui a failli tout faire échouer.

**Un en-tête RTP ne fait pas 12 octets en WebRTC.** Sa taille dépend du nombre
d'identifiants CSRC et de la présence d'une extension d'en-tête — et WebRTC en
ajoute systématiquement (`abs-send-time`, `transport-cc`, `ssrc-audio-level`,
`mid`). En pratique, 20 à 32 octets. Découper à 12 injecterait la fin de
l'extension au début de la trame Opus, et le décodeur produirait du bruit **sans
lever d'erreur franche**.

Le tampon de gigue s'occupe de trois choses que ffmpeg faisait en silence :

- **le désordre**, trié sur le numéro de séquence, avec arithmétique modulaire
  sur 16 bits ;
- **les pertes**, comblées par la dissimulation de libopus, qui interpole depuis
  son état interne plutôt que de laisser un blanc ;
- **la continuité temporelle**, reconstruite depuis l'horodatage RTP, qui progresse
  de 960 par trame de 20 ms à 48 kHz. Sans cela, un silence en transmission
  discontinue comprimerait le flux et ferait dériver l'horodatage des phrases.

### 3.4 Reconnaissance

Un seul moteur sherpa-onnx pour tout le processus, plusieurs flux indépendants —
le modèle n'est donc en mémoire qu'une fois, contre 750 Mio par processus avec
Whisper.

Le traitement d'une session tourne dans **son propre thread**, jamais dans la
boucle d'événements : le décodage et l'inférence sont des appels C synchrones, et
une session bloquerait toutes les autres.

Les hypothèses sont émises au plus une fois par quart de seconde et seulement sur
changement réel. Sans cette limitation, `get_result` renvoyant le texte complet du
segment à chaque trame, on enverrait cinquante messages par seconde et par
locuteur.

### 3.5 Affichage

Chaque phrase porte un `spokenAt`, l'instant de **prononciation**. Serveur et
navigateur l'insèrent à sa place chronologique plutôt qu'en fin de liste : deux
locuteurs dont les flux n'avancent pas au même rythme verraient sinon une réponse
s'afficher avant sa question.

---

## 4. Mesures en production

Relevé sur une réunion réelle, machine en charge normale :

| | |
|---|---|
| Paquets reçus | 5 080 |
| Trames décodées | 5 079 |
| Trames perdues | **0** |
| Paquets réordonnés | 1 |
| Erreurs de dépaquetage | **1** (0,02 %) |
| Audio traité | 103,6 s |
| **RTF** | **0,179** |
| Retard accumulé | **0** |

Le RTF de 0,179 vaut environ **cinq locuteurs simultanés** sur les cœurs alloués.
Un banc sur fichier continu donnait 0,437 : l'écart vient du silence, très
présent en réunion réelle et presque gratuit à traiter.

Pour comparaison, la chaîne Whisper précédente sur la même machine : RTF de 1,5 à
2,5, un à deux locuteurs, 284 secondes de retard accumulé au pire, et 10 à
13 secondes avant le premier mot.

---

## 5. Modes de panne supprimés

Chacun de ces points a causé une panne réelle avant la migration.

**ffmpeg qui abandonne.** Il s'arrêtait de lui-même sur un délai réseau
(« Connection timed out ») et rien ne le relançait : un participant est resté avec
zéro octet reçu pendant toute une réunion, sa voix n'étant transcrite que par
l'écho du micro de l'autre, sous le mauvais nom. Il n'y a plus de ffmpeg.

**`transport.connect()` oublié.** Avec `comedia: false`, mediasoup n'émettait rien,
sans erreur. Il n'y a plus de `connect()`.

**L'interface d'écoute.** Un `PlainTransport` lié à `127.0.0.1` ne peut pas
atteindre l'hôte sur le bridge Docker ; les paquets partaient sur le loopback et
disparaissaient. Il n'y a plus de socket.

**Les conflits de ports.** Deux plages devaient être maintenues et distinguées.
Il n'y a plus de port.

**La route publique.** `/internal/transcript` était exposée sur Internet et
protégée par un secret partagé. Elle subsiste pour un transcripteur externe, mais
n'est plus dans le chemin nominal.

---

## 6. Exploitation

Le service tourne **hors Coolify**, pour que le `cpuset` protège la visioconférence
et qu'il redémarre indépendamment du serveur média :

```bash
docker run -d --name stark-transcriber --restart unless-stopped \
  --network host --cpuset-cpus=4-7 --memory=3g \
  -v stark-whisper-models:/models \
  -e TRANSCRIBER_PORT=8077 \
  -e SHERPA_MODEL_DIR=/models/sherpa-onnx-streaming-zipformer-fr-2023-04-14 \
  -e SHERPA_THREADS=2 \
  stark-transcriber
```

Côté Coolify, sur la ressource mediasoup : `TRANSCRIPTION_ENABLED=true` et
`TRANSCRIBER_PORT=8077`.

**Le diagnostic tient en une commande :**

```bash
curl -s http://127.0.0.1:8077/health
```

`decodeErrors` qui grimpe pendant que `receivedPackets` grimpe signale un
dépaquetage RTP erroné. `queued` qui monte signale que le CPU ne suit plus.
`lostFrames` mesure la qualité du réseau. `rtf` doit rester bien sous 1.

Repli possible vers l'ancienne chaîne Whisper sans reconstruire l'image :
`-e TRANSCRIBER_APP=service:app`.

---

## 7. Limites connues

**Pas de ponctuation ni de majuscules.** Les transducteurs produisent du texte
brut ; la casse est normalisée à l'affichage, faute de mieux. Le remède est un
petit modèle ONNX de restauration de ponctuation appliqué au texte confirmé —
quelques millisecondes par phrase.

**Justesse à valider.** Le modèle français disponible date d'avril 2023 et a été
entraîné sur Common Voice, c'est-à-dire de la lecture à voix haute plutôt que de
la conversation. Le protocole de comparaison existe : `transcriber/reference-fr.txt`
lu à voix normale, et `transcriber/bench_streaming.py` qui compte les erreurs par
distance d'édition. Points de repère sur cette machine : 81 % de mots corrects
pour `whisper-small` générique, 86 % pour `whisper-small-cv11-french`.

**Diaphonie acoustique.** Sans casque, le micro d'un participant capte la voix de
l'autre par ses haut-parleurs, et le texte est attribué au mauvais locuteur.
L'annulation d'écho du navigateur est active mais son résidu suffit au modèle. La
piste retenue, non implémentée, est de suspendre un flux tant qu'un autre est
nettement plus fort — un écho étant typiquement 15 à 30 dB sous la voix directe.

**Aucune persistance.** L'historique vit en mémoire du serveur mediasoup, plafonné
à 20 000 phrases, et disparaît à la fin de la réunion. Le compte-rendu automatique
exigera de l'écrire en base.
