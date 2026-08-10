'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Lock, User as UserIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import ConferenceView from '@/components/conference/ConferenceView';
import Lobby from '@/components/conference/Lobby';
import EndScreen from '@/components/conference/EndScreen';
import useRoomChannel from '@/hooks/useRoomChannel';
import useMediasoup from '@/hooks/useMediasoup';
import { withDefaults } from '@/lib/preferences';
import { shouldCompleteMeeting, formatTimeRange } from '@/lib/meetingSchedule';

// Filet de sécurité si le canal temps réel est momentanément indisponible :
// on resynchronise la liste depuis Supabase de temps en temps. Volontairement
// lent — le socket fait tout le travail en temps normal.
const RECONCILE_INTERVAL_MS = 15000;

function getOrCreateGuestIdentity(meetingCode) {
  const key = `stark-meet-guest-${meetingCode}`;
  const stored = sessionStorage.getItem(key);
  if (stored) return JSON.parse(stored);
  return null;
}

function saveGuestIdentity(meetingCode, identity) {
  sessionStorage.setItem(`stark-meet-guest-${meetingCode}`, JSON.stringify(identity));
}

export default function RoomPage() {
  const { code } = useParams();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [meeting, setMeeting] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [needsName, setNeedsName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [myParticipant, setMyParticipant] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [lockedOut, setLockedOut] = useState(false);

  // Trois phases, comme dans le template : préparation, appel, fin.
  const [phase, setPhase] = useState('lobby');
  const [joining, setJoining] = useState(false);
  const [endStats, setEndStats] = useState(null);
  const callStartedAtRef = useRef(null);

  const guestIdentityRef = useRef(null);
  const myParticipantIdRef = useRef(null);
  myParticipantIdRef.current = myParticipant?.id || null;

  const isHost = !!(authUser && meeting && authUser.id === meeting.host_id);
  const currentUserId = authUser?.id || guestIdentityRef.current?.guestId || null;
  const currentUserName = profile?.full_name || guestIdentityRef.current?.displayName || 'Vous';
  const preferences = useMemo(() => withDefaults(profile?.preferences), [profile?.preferences]);

  // Le média est piloté ici, et non dans ConferenceView : le lobby doit
  // afficher l'aperçu caméra avant que la vue d'appel n'existe, et l'entrée en
  // réunion doit réutiliser ce même flux plutôt que redemander l'accès aux
  // périphériques — ce qui provoquerait un second clignotement d'autorisation.
  const media = useMediasoup(meeting?.id, currentUserId, currentUserName);

  // ---- Chargement initial : réunion + identité ----
  useEffect(() => {
    const init = async () => {
      const supabase = createClient();
      const { data: meetingData } = await supabase
        .from('meetings')
        .select('*')
        .eq('meeting_code', code)
        .maybeSingle();

      if (!meetingData) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setMeeting(meetingData);

      const { data: { user } } = await supabase.auth.getUser();
      setAuthUser(user);

      if (user) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', user.id)
          .maybeSingle();
        setProfile(profileData);
        await joinAsIdentity(meetingData, { profileId: user.id, displayName: profileData?.full_name || 'Utilisateur' });
      } else {
        const existingGuest = getOrCreateGuestIdentity(code);
        if (existingGuest) {
          guestIdentityRef.current = existingGuest;
          await joinAsIdentity(meetingData, { guestId: existingGuest.guestId, displayName: existingGuest.displayName });
        } else {
          setNeedsName(true);
          setLoading(false);
        }
      }
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // ---- Rejoindre / créer sa ligne meeting_participants ----
  const joinAsIdentity = useCallback(async (meetingData, identity) => {
    const supabase = createClient();
    const isMeetingHost = identity.profileId && identity.profileId === meetingData.host_id;

    const filterColumn = identity.profileId ? 'profile_id' : 'guest_id';
    const filterValue = identity.profileId || identity.guestId;

    const { data: existing } = await supabase
      .from('meeting_participants')
      .select('*')
      .eq('meeting_id', meetingData.id)
      .eq(filterColumn, filterValue)
      .maybeSingle();

    if (existing) {
      if (existing.status === 'denied' || existing.status === 'removed') {
        setLockedOut(true);
        setLoading(false);
        return;
      }

      if (existing.status === 'waiting') {
        // Toujours en attente d'admission — on ne touche à rien.
        setMyParticipant(existing);
        setLoading(false);
        return;
      }

      // status 'admitted' ou 'left' (ex: on rejoint après être parti) —
      // l'hôte a déjà admis cette personne une fois, on la réadmet
      // directement plutôt que de la remettre en salle d'attente.
      const { data: updated } = await supabase
        .from('meeting_participants')
        .update({ status: 'admitted', joined_at: new Date().toISOString(), left_at: null })
        .eq('id', existing.id)
        .select()
        .single();

      setMyParticipant(updated || { ...existing, status: 'admitted' });
      setLoading(false);
      return;
    }

    // Nouveau participant
    if (!isMeetingHost && meetingData.locked_at) {
      setLockedOut(true);
      setLoading(false);
      return;
    }

    const needsWaiting = !isMeetingHost && meetingData.waiting_room_enabled;

    const { data: created, error } = await supabase
      .from('meeting_participants')
      .insert({
        meeting_id: meetingData.id,
        profile_id: identity.profileId || null,
        guest_id: identity.profileId ? null : identity.guestId,
        display_name: identity.displayName,
        role: isMeetingHost ? 'host' : 'guest',
        status: needsWaiting ? 'waiting' : 'admitted',
        joined_at: needsWaiting ? null : new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.error('Erreur en rejoignant la réunion:', error);
      setLoading(false);
      return;
    }

    setMyParticipant(created);
    setLoading(false);
  }, []);

  const handleNameSubmit = async (e) => {
    e.preventDefault();
    const displayName = nameInput.trim();
    if (!displayName || !meeting) return;

    const identity = { guestId: crypto.randomUUID(), displayName };
    saveGuestIdentity(code, identity);
    guestIdentityRef.current = identity;
    setNeedsName(false);
    setLoading(true);
    await joinAsIdentity(meeting, { guestId: identity.guestId, displayName });
  };

  // ---- Synchronisation de la liste des participants ----
  const loadParticipants = useCallback(async () => {
    if (!meeting?.id) return;
    const supabase = createClient();
    const { data } = await supabase
      .from('meeting_participants')
      .select('*')
      .eq('meeting_id', meeting.id)
      .order('created_at', { ascending: true });

    if (!data) return;
    setParticipants(data);

    const mine = myParticipantIdRef.current && data.find(p => p.id === myParticipantIdRef.current);
    if (mine) setMyParticipant(mine);
  }, [meeting?.id]);

  useEffect(() => {
    loadParticipants();
  }, [loadParticipants]);

  // Une action (admission, exclusion…) déclenche un événement chez tout le
  // monde en même temps. Sans regroupement, une salle de 40 personnes envoie
  // 40 requêtes simultanées à Supabase à chaque clic de l'hôte.
  const reloadTimerRef = useRef(null);
  const scheduleReload = useCallback(() => {
    clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(loadParticipants, 250);
  }, [loadParticipants]);

  useEffect(() => () => clearTimeout(reloadTimerRef.current), []);

  // ---- Canal temps réel (Socket.io) ----
  const applyParticipantPatch = useCallback((participantId, patch) => {
    setParticipants(prev => prev.map(p => (p.id === participantId ? { ...p, ...patch } : p)));
    setMyParticipant(prev => (prev && prev.id === participantId ? { ...prev, ...patch } : prev));
  }, []);

  const handleDirty = useCallback(() => {
    scheduleReload();
  }, [scheduleReload]);

  const handleParticipantUpdated = useCallback(({ participantId, patch }) => {
    // Le patch s'applique tout de suite (affichage instantané) ; la relecture
    // en base sert juste à rattraper une ligne qu'on ne connaîtrait pas encore.
    applyParticipantPatch(participantId, patch);
    scheduleReload();
  }, [applyParticipantPatch, scheduleReload]);

  const handleMeetingUpdated = useCallback(({ patch }) => {
    setMeeting(prev => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const handleEjected = useCallback(({ status }) => {
    setMyParticipant(prev => (prev ? { ...prev, status } : prev));
  }, []);

  const handleForceMutedSignal = useCallback(({ muted }) => {
    if (!myParticipantIdRef.current) return;
    applyParticipantPatch(myParticipantIdRef.current, { force_muted: muted });
  }, [applyParticipantPatch]);

  const roomChannel = useRoomChannel({
    meetingId: meeting?.id,
    participantId: myParticipant?.id,
    userId: currentUserId,
    displayName: profile?.full_name || guestIdentityRef.current?.displayName || 'Participant',
    isHost,
    onDirty: handleDirty,
    onParticipantUpdated: handleParticipantUpdated,
    onMeetingUpdated: handleMeetingUpdated,
    onEjected: handleEjected,
    onForceMuted: handleForceMutedSignal,
  });

  // Réconciliation périodique — uniquement un filet de sécurité.
  useEffect(() => {
    if (!meeting?.id) return;
    const interval = setInterval(loadParticipants, RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [meeting?.id, loadParticipants]);

  // ---- Aperçu du lobby ----
  // On ne demande la caméra qu'une fois l'identité connue et l'accès accordé :
  // solliciter les périphériques avant serait intrusif, et inutile si la
  // personne est refusée.
  const previewRequestedRef = useRef(false);
  useEffect(() => {
    if (previewRequestedRef.current) return;
    if (phase !== 'lobby' || !meeting || !currentUserId || lockedOut) return;
    if (myParticipant?.status === 'denied' || myParticipant?.status === 'removed') return;

    previewRequestedRef.current = true;
    media.initPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, meeting, currentUserId, lockedOut, myParticipant?.status]);

  // Application des préférences (arriver micro ou caméra coupés), une seule
  // fois, dès que le flux local existe.
  const prefsAppliedRef = useRef(false);
  useEffect(() => {
    if (prefsAppliedRef.current || !media.localStream) return;
    prefsAppliedRef.current = true;

    if (preferences.muteOnJoin) media.setMicEnabled(false);
    if (preferences.cameraOffOnJoin && media.isVideoOn) media.toggleVideo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.localStream]);

  // Libère caméra, micro et connexion si l'on quitte la page sans passer par
  // le bouton « Quitter » (fermeture d'onglet, exclusion par l'hôte).
  const leaveMediaRef = useRef(media.leaveMeeting);
  leaveMediaRef.current = media.leaveMeeting;
  useEffect(() => () => leaveMediaRef.current?.(), []);

  const handleJoinCall = async () => {
    setJoining(true);
    const joined = await media.joinMeeting();
    setJoining(false);

    // On ne bascule en appel que si la connexion a réellement abouti ; sinon on
    // reste dans le lobby, où le message d'erreur est visible.
    if (joined) {
      callStartedAtRef.current = Date.now();
      setPhase('call');
    }
  };

  // ---- Actions hôte ----
  // Chaque action écrit dans Supabase (persistance) puis diffuse sur le canal
  // de contrôle (temps réel + application côté SFU pour le mute et
  // l'exclusion, que la base ne peut pas imposer d'elle-même).
  const updateParticipant = async (participantId, patch) => {
    const target = participants.find(p => p.id === participantId);
    const targetUserId = target?.profile_id || target?.guest_id || null;

    const supabase = createClient();
    const { error } = await supabase.from('meeting_participants').update(patch).eq('id', participantId);
    if (error) {
      console.error('Erreur mise à jour participant:', error);
      throw error;
    }

    applyParticipantPatch(participantId, patch);
    roomChannel.sendParticipantUpdate(participantId, targetUserId, patch);
  };

  const handleAdmit = (id) => updateParticipant(id, { status: 'admitted', joined_at: new Date().toISOString() });
  const handleDeny = (id) => updateParticipant(id, { status: 'denied' });
  const handleRemove = (id) => updateParticipant(id, { status: 'removed' });
  const handleForceMute = (id) => {
    const target = participants.find(p => p.id === id);
    return updateParticipant(id, { force_muted: !target?.force_muted });
  };

  const handleToggleLock = async () => {
    const supabase = createClient();
    const newLockedAt = meeting.locked_at ? null : new Date().toISOString();
    await supabase.from('meetings').update({ locked_at: newLockedAt }).eq('id', meeting.id);
    setMeeting(prev => ({ ...prev, locked_at: newLockedAt }));
    roomChannel.sendMeetingUpdate({ locked_at: newLockedAt });
  };

  const handleLeaveMeeting = async () => {
    const durationMs = callStartedAtRef.current ? Date.now() - callStartedAtRef.current : 0;

    // Relevé AVANT de couper le média : `leaveMeeting()` vide `remotePeers`, et
    // on ne saurait plus si on était la dernière personne dans la salle.
    const wasLastParticipant = Object.keys(media.remotePeers || {}).length === 0;
    const closesMeeting = shouldCompleteMeeting(meeting, wasLastParticipant);

    // Le nombre de messages est compté en base plutôt que remonté depuis le
    // panneau de discussion : une requête `head` ne transfère aucune ligne, et
    // ça évite de faire traverser l'état du chat à toute l'application.
    let messages = 0;
    if (meeting?.id) {
      const supabase = createClient();
      const { count } = await supabase
        .from('meeting_messages')
        .select('id', { count: 'exact', head: true })
        .eq('meeting_id', meeting.id);
      messages = count ?? 0;
    }

    setEndStats({
      durationMs,
      participants: participants.filter((p) => p.status === 'admitted').length,
      messages,
      // « Ne se termine pas » couvre exactement les trois cas où la réunion
      // continue : d'autres sont encore là, ou j'étais seul mais l'heure de fin
      // n'est pas passée. Ajouter une condition d'horaire aurait annoncé « appel
      // terminé » alors que des gens parlent encore, après l'heure prévue.
      stillRunning: !closesMeeting,
    });

    media.leaveMeeting();

    if (myParticipant) {
      await updateParticipant(myParticipant.id, { status: 'left', left_at: new Date().toISOString() });
    }

    // La dernière personne referme la salle — immédiatement pour une réunion
    // instantanée, seulement après l'heure de fin pour une planifiée.
    if (closesMeeting) {
      const supabase = createClient();
      const { error } = await supabase
        .from('meetings')
        .update({ status: 'completed' })
        .eq('id', meeting.id);

      if (error) console.error('Clôture de la réunion impossible:', error);
      else {
        setMeeting((prev) => (prev ? { ...prev, status: 'completed' } : prev));
        roomChannel.sendMeetingUpdate({ status: 'completed' });
      }
    }

    setPhase('end');
  };

  /** Revenir dans la même réunion depuis l'écran de fin. */
  const handleRejoin = async () => {
    setEndStats(null);
    previewRequestedRef.current = false;
    prefsAppliedRef.current = false;

    if (myParticipant) {
      await updateParticipant(myParticipant.id, {
        status: 'admitted',
        joined_at: new Date().toISOString(),
        left_at: null,
      });
    }

    setPhase('lobby');
  };

  // ---- Rendus ----
  const admittedParticipants = participants.filter((p) => p.status === 'admitted');
  const waitingParticipants = participants.filter((p) => p.status === 'waiting');

  if (loading) {
    return (
      <div className="min-h-viewport bg-canvas flex items-center justify-center">
        <p className="font-mono text-[13px] text-slate-500">Connexion à la réunion…</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <CenteredNotice
        icon={Lock}
        title="Réunion introuvable"
        text="Vérifiez le code ou le lien que vous avez reçu."
      />
    );
  }

  // Un invité doit se nommer avant d'aller plus loin.
  if (needsName) {
    return (
      <div className="min-h-viewport bg-canvas flex items-center justify-center p-4">
        <div className="w-full max-w-[420px] bg-surface border border-slate-200 rounded-lg p-8">
          <h1 className="font-display font-bold text-[22px] tracking-heading">
            Rejoindre « {meeting?.title} »
          </h1>
          <p className="mt-1.5 text-[14px] text-slate-700">
            Indiquez votre nom : c&apos;est ce que verront les autres participants.
          </p>

          <form onSubmit={handleNameSubmit} className="mt-6 flex flex-col gap-4">
            <div className="relative">
              <UserIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                required
                autoFocus
                placeholder="Votre nom"
                className="w-full h-11 pl-10 pr-3.5 rounded-sm border border-slate-200 bg-surface text-[15px] placeholder:text-slate-500 outline-none transition-shadow duration-200 focus:border-brand-500 focus:shadow-focus"
              />
            </div>
            <button
              type="submit"
              className="w-full h-11 rounded-sm bg-brand-500 text-surface text-[15px] font-semibold hover:bg-brand-600 transition-colors"
            >
              Continuer
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (lockedOut) {
    return (
      <CenteredNotice
        icon={Lock}
        title="Accès refusé"
        text="L'hôte a verrouillé cette réunion, ou vous en avez été exclu."
      />
    );
  }

  if (myParticipant?.status === 'denied' || myParticipant?.status === 'removed') {
    return (
      <CenteredNotice
        icon={Lock}
        title={
          myParticipant.status === 'denied'
            ? 'Votre demande a été refusée'
            : 'Vous avez été exclu de la réunion'
        }
        text="Contactez l'hôte si vous pensez qu'il s'agit d'une erreur."
      />
    );
  }

  if (phase === 'end') {
    return (
      <EndScreen
        meeting={meeting}
        stats={endStats}
        isHost={!!authUser}
        stillRunning={!!endStats?.stillRunning}
        endsAtLabel={formatTimeRange(meeting, preferences.timeZone)?.split(' — ')[1] || null}
        onRejoin={handleRejoin}
      />
    );
  }

  // Phase de préparation — sert aussi d'écran d'attente pour un invité que
  // l'hôte n'a pas encore admis, qui peut ainsi régler son micro en patientant.
  if (phase === 'lobby') {
    return (
      <Lobby
        meeting={meeting}
        displayName={currentUserName}
        userId={currentUserId}
        localStream={media.localStream}
        isMicOn={media.isMicOn}
        isVideoOn={media.isVideoOn}
        onToggleMic={media.toggleMic}
        onToggleVideo={media.toggleVideo}
        onJoin={handleJoinCall}
        joining={joining}
        waiting={myParticipant?.status === 'waiting'}
        invitedCount={admittedParticipants.length}
        error={media.error}
        timeZone={preferences.timeZone}
      />
    );
  }

  return (
    <ConferenceView
      media={media}
      meeting={meeting}
      currentUserId={currentUserId}
      currentUserName={currentUserName}
      isHost={isHost}
      roomChannel={roomChannel}
      participants={admittedParticipants}
      waitingParticipants={waitingParticipants}
      onLeaveMeeting={handleLeaveMeeting}
      onToggleLock={handleToggleLock}
      onAdmit={handleAdmit}
      onDeny={handleDeny}
      onForceMute={handleForceMute}
      onRemove={handleRemove}
    />
  );
}

/** Message plein écran — réunion introuvable, accès refusé, exclusion. */
function CenteredNotice({ icon: Icon, title, text }) {
  return (
    <div className="min-h-viewport bg-canvas flex items-center justify-center px-4">
      <div className="max-w-[420px] text-center">
        <span className="w-14 h-14 rounded-full bg-slate-100 text-slate-700 flex items-center justify-center mx-auto mb-6">
          <Icon className="h-6 w-6" />
        </span>
        <p className="font-display font-bold text-[20px] tracking-heading">{title}</p>
        <p className="mt-2 text-[14px] leading-relaxed text-slate-700">{text}</p>
        <Link
          href="/"
          className="mt-6 inline-flex h-10 px-5 items-center rounded-sm border border-slate-200 bg-surface text-[14px] font-medium hover:bg-slate-100 transition-colors"
        >
          Retour à l&apos;accueil
        </Link>
      </div>
    </div>
  );
}
