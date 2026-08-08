'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Lock, Clock, User as UserIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import ConferenceView from '@/components/conference/ConferenceView';
import useRoomChannel from '@/hooks/useRoomChannel';

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

  const guestIdentityRef = useRef(null);
  const myParticipantIdRef = useRef(null);
  myParticipantIdRef.current = myParticipant?.id || null;

  const isHost = !!(authUser && meeting && authUser.id === meeting.host_id);
  const currentUserId = authUser?.id || guestIdentityRef.current?.guestId || null;

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
    if (myParticipant) {
      await updateParticipant(myParticipant.id, { status: 'left', left_at: new Date().toISOString() });
    }
    router.push(authUser ? '/dashboard' : '/');
  };

  // ---- Rendus ----
  if (loading) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <div className="text-mist-300 text-sm font-mono">Connexion à la réunion…</div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center px-4">
        <div className="text-center">
          <p className="text-white font-semibold">Réunion introuvable</p>
          <p className="text-ink-500 text-sm mt-1.5">Vérifiez le code ou le lien que vous avez reçu.</p>
        </div>
      </div>
    );
  }

  if (needsName) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-ink-900 border border-ink-700 rounded-lg p-7">
          <h1 className="text-white text-lg font-semibold mb-1">Rejoindre "{meeting?.title}"</h1>
          <p className="text-ink-500 text-sm mb-6">Entrez votre nom pour continuer.</p>
          <form onSubmit={handleNameSubmit} className="space-y-4">
            <div className="relative">
              <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-500" />
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                required
                autoFocus
                placeholder="Votre nom"
                className="w-full pl-9 pr-3.5 py-2.5 bg-ink-800 border border-ink-700 rounded-md text-white text-sm placeholder:text-ink-500 focus:outline-none focus:border-signal-500 transition-colors"
              />
            </div>
            <button
              type="submit"
              className="w-full bg-signal-500 hover:bg-signal-400 text-white font-medium py-2.5 rounded-md transition-colors text-sm"
            >
              Rejoindre
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (lockedOut) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <Lock className="h-9 w-9 text-signal-400 mx-auto mb-4" />
          <p className="text-white font-semibold">Accès refusé</p>
          <p className="text-ink-500 text-sm mt-1.5">
            L'hôte a verrouillé cette réunion ou vous en a été exclu.
          </p>
        </div>
      </div>
    );
  }

  if (myParticipant?.status === 'waiting') {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <Clock className="h-9 w-9 text-amber-500 mx-auto mb-4 animate-pulse" />
          <p className="text-white font-semibold">En attente d'admission</p>
          <p className="text-ink-500 text-sm mt-1.5">
            L'hôte de "{meeting?.title}" doit vous laisser entrer. Cette page se mettra à jour automatiquement.
          </p>
        </div>
      </div>
    );
  }

  if (myParticipant?.status === 'denied' || myParticipant?.status === 'removed') {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <Lock className="h-9 w-9 text-signal-400 mx-auto mb-4" />
          <p className="text-white font-semibold">
            {myParticipant.status === 'denied' ? "Votre demande a été refusée" : "Vous avez été exclu de la réunion"}
          </p>
        </div>
      </div>
    );
  }

  const admittedParticipants = participants.filter(p => p.status === 'admitted');
  const waitingParticipants = participants.filter(p => p.status === 'waiting');

  return (
    <ConferenceView
      meeting={meeting}
      currentUserId={currentUserId}
      currentUserName={profile?.full_name || guestIdentityRef.current?.displayName || 'Vous'}
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
