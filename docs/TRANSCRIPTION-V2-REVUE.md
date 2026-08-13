# Revue de l'implémentation proposée (DirectTransport + sherpa-onnx)

L'architecture est validée : `DirectTransport` → WebSocket binaire → décodage et
reconnaissance côté Python, décodage maintenu dans le conteneur isolé. Le remplacement du
VAD Silero par l'endpointing natif du transducteur est également le bon choix — il supprime
un seuil empirique au profit d'une décision linguistique.

Cette note ne revient pas sur ces choix. Elle liste **sept défauts du code proposé**, classés
par gravité, avec les corrections. Le premier est fatal et invisible.

---

## 1. FATAL — l'en-tête RTP ne fait pas 12 octets en WebRTC

```python
payload = message[12:]   # ← faux dans la quasi-totalité des cas
```

Un en-tête RTP fait 12 octets **au minimum**. Sa taille réelle dépend de deux champs :

- **CC** (4 bits de poids faible du premier octet) : nombre d'identifiants CSRC, chacun
  occupant 4 octets supplémentaires.
- **X** (bit 4 du premier octet) : présence d'une **extension d'en-tête**, qui ajoute
  4 octets puis `length × 4` octets.

Or WebRTC utilise massivement les extensions d'en-tête — `abs-send-time`,
`transport-wide-cc`, `ssrc-audio-level`, `mid`. mediasoup en ajoute lui-même côté consumer.
En pratique, l'en-tête fait donc **20 à 32 octets**, et découper à 12 injecte les derniers
octets de l'extension au début de chaque trame Opus.

Le décodeur ne renverra pas une erreur franche : il produira du bruit, ou échouera par
intermittence. Avec le `except: pass` du point 3, on obtiendrait un service qui tourne, ne
journalise rien, et ne transcrit rien — exactement le scénario de panne silencieuse qui a
déjà coûté plusieurs jours sur ce projet.

```python
def parse_rtp(packet: bytes):
    """Renvoie (sequence, timestamp, marker, payload) ou None si le paquet est invalide."""
    if len(packet) < 12:
        return None

    first, second = packet[0], packet[1]
    version = first >> 6
    if version != 2:
        return None

    has_padding = bool(first & 0x20)
    has_extension = bool(first & 0x10)
    csrc_count = first & 0x0F
    marker = bool(second & 0x80)

    sequence = int.from_bytes(packet[2:4], "big")
    timestamp = int.from_bytes(packet[4:8], "big")

    offset = 12 + 4 * csrc_count
    if has_extension:
        if len(packet) < offset + 4:
            return None
        ext_words = int.from_bytes(packet[offset + 2:offset + 4], "big")
        offset += 4 + 4 * ext_words

    end = len(packet)
    if has_padding and end > offset:
        # Le dernier octet indique combien d'octets de bourrage retirer.
        end -= packet[-1]

    if offset >= end:
        return None
    return sequence, timestamp, marker, packet[offset:end]
```

---

## 2. GRAVE — le décodage bloque la boucle d'événements

Dans le code proposé, `codec.decode()`, `resampler.resample()` et surtout
`recognizer.decode_stream()` sont appelés **directement dans la coroutine** qui lit le
WebSocket. Ce sont des appels C synchrones : pendant leur exécution, aucune autre session
n'avance.

À un locuteur ça ne se voit pas. À dix, chaque session attend les neuf autres, et la latence
s'effondre — précisément ce que l'architecture cherchait à éviter.

Deux options. La plus simple : un **thread par session**, la reconnaissance étant de toute
façon séquentielle par flux, et les appels C de sherpa-onnx et PyAV libérant le GIL.

```python
async for message in websocket:
    if isinstance(message, bytes):
        await asyncio.to_thread(process_packet, session, message)
```

La plus efficace à grande échelle : accumuler les paquets dans une file par session et
laisser un pool de threads dépiler, ce qui permet aussi le décodage par lots de sherpa-onnx.

---

## 3. GRAVE — `except Exception: pass`

```python
except Exception as e:
    # Gérer les paquets corrompus sans faire planter la session
    pass
```

L'intention est juste — un paquet corrompu ne doit pas tuer la session — mais avaler
l'exception sans trace rend le diagnostic impossible. Combiné au défaut n°1, on obtient un
service parfaitement silencieux qui ne produit rien.

Il faut compter et journaliser avec limitation de débit :

```python
except Exception as error:
    session.decode_errors += 1
    if session.decode_errors in (1, 10, 100) or session.decode_errors % 1000 == 0:
        log.warning("Décodage impossible (%d au total) · %s: %s",
                    session.decode_errors, session.speaker, error)
```

Le compteur doit apparaître dans le point de contrôle `/health` : une session dont
`decode_errors` grimpe alors que `receivedPackets` grimpe aussi, c'est le défaut n°1.

---

## 4. IMPORTANT — un message par trame inonde le canal

```python
text = recognizer.get_result(stream)
if text:
    await websocket.send(json.dumps({"type": status, "text": text}))
```

`get_result` renvoie **l'hypothèse complète depuis le début du segment**, à chaque trame de
20 ms. Ce code émet donc jusqu'à cinquante messages par seconde et par locuteur, contenant
chacun tout le texte en cours. À trois locuteurs, cela fait cent cinquante rediffusions
Socket.IO par seconde vers tous les navigateurs, pour un texte qui n'a le plus souvent pas
changé.

Il faut n'émettre que sur **changement réel**, et limiter la cadence :

```python
now = time.monotonic()
if text != session.last_text and (now - session.last_sent > 0.25 or is_endpoint):
    session.last_text = text
    session.last_sent = now
    await send(...)
```

Un quart de seconde est imperceptible à la lecture et divise le trafic par dix.

---

## 5. IMPORTANT — décoder de l'Opus nu avec PyAV est fragile

```python
codec = av.CodecContext.create('opus', 'r')
codec.sample_rate = 48000
codec.channels = 2
```

Deux problèmes. D'abord `channels` est en lecture seule dans les versions récentes de PyAV,
où l'on définit `codec.layout`. Ensuite et surtout, le décodeur Opus d'avcodec s'attend
normalement à recevoir son `extradata` — l'en-tête `OpusHead` — que l'on n'a pas ici,
puisqu'on reçoit des trames nues extraites de RTP et non un conteneur Ogg.

Pour ce cas précis, **`opuslib`** — une liaison directe sur libopus — est plus adaptée. Elle
prend exactement des trames nues, et surtout elle expose la **dissimulation de perte de
paquets** :

```python
decoder = opuslib.Decoder(48000, 2)
pcm = decoder.decode(payload, frame_size=960)          # trame reçue
pcm = decoder.decode(None, frame_size=960, fec=False)  # trame perdue : libopus interpole
```

Cette seconde ligne est ce qui distingue un trou correctement comblé d'un blanc net. Le
rééchantillonnage vers 16 kHz peut alors être confié à `soxr`, très rapide et de bonne
qualité, ou à l'`AudioResampler` de PyAV si on garde la dépendance.

---

## 6. MOYEN — l'horodatage RTP boucle sur 32 bits

```python
if last_ts is not None and (ts - last_ts) > 960:
```

L'horodatage RTP est un entier 32 bits non signé. À 48 kHz il boucle toutes les 24 heures
environ — rare, mais le vrai problème est ailleurs : **un paquet en retard produit un écart
négatif**, et la comparaison brute conclut à tort qu'il n'y a pas de silence, ou pire, en
insère un énorme après un bouclage.

```python
delta = (ts - last_ts) & 0xFFFFFFFF
if delta > 0x80000000:      # écart interprété comme négatif : paquet en retard
    return                   # déjà traité, on l'ignore
```

Le même raisonnement vaut pour le numéro de séquence, sur 16 bits : la comparaison doit être
modulaire, jamais une simple soustraction.

---

## 7. MOYEN — le tampon de gigue est décrit mais pas écrit

Le commentaire annonce « en production, vous stockez les paquets dans un dictionnaire
ordonné », mais le code traite chaque paquet à son arrivée. Or c'est bien nécessaire :
mediasoup ne réordonne pas pour ses consumers, il réachemine dans l'ordre d'arrivée, et
l'ordre d'arrivée UDP n'est pas garanti.

À noter que le WebSocket ne réintroduit **pas** de désordre — TCP préserve l'ordre
d'émission. Le désordre à corriger est donc uniquement celui d'avant mediasoup, et il se
traite entièrement côté Python.

Une fenêtre de réordonnancement de 40 à 60 ms suffit, soit deux à trois trames :

```python
pending[sequence] = (timestamp, payload)
while expected_seq in pending or len(pending) > REORDER_WINDOW:
    if expected_seq not in pending:
        decode_lost_frame()          # dissimulation libopus
    else:
        decode(pending.pop(expected_seq))
    expected_seq = (expected_seq + 1) & 0xFFFF
```

---

## Deux points mineurs

Le message de contrôle `start` est envoyé par Node puis ignoré par Python (`continue`). Il
devrait servir à créer la session avec le nom du locuteur et le payload type négocié — ce
dernier permettant de rejeter les paquets d'un autre codec plutôt que de les décoder de
travers.

Enfin, Node ouvre **un WebSocket par locuteur**. Une seule connexion multiplexée, avec
l'identifiant de session en préfixe binaire, éviterait la poignée de main répétée à chaque
prise de parole — le fork étant ouvert et refermé au gré des silences.

---

## Ce qu'il reste à valider avant d'écrire quoi que ce soit

Ces sept corrections sont mécaniques. Le vrai risque du projet est ailleurs, et il n'est
toujours pas levé : **la justesse d'un Zipformer streaming en français** sur de la parole
spontanée. L'affirmation « WER très compétitif avec whisper-small » demande à être mesurée
avant de réécrire le pipeline.

Le protocole existe déjà : un texte de référence de 162 mots, lu à voix normale, avec deux
points de comparaison mesurés sur cette machine — 81 % de mots corrects pour `small`
générique, 86 % pour `whisper-small-cv11-french`. Faire lire le même texte au modèle
candidat et compter demande une heure. Si le résultat descend nettement sous 80 %, le gain
de latence ne rachètera pas la perte de justesse, et il faudra plutôt envisager une
architecture à deux modèles : le transducteur pour l'affichage en direct, Whisper en différé
pour le texte définitif et le compte-rendu.
