'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { LogOut, Video, CalendarClock, Users, Settings, Menu, X } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { ensureProfile } from '@/lib/ensureProfile';
import { withDefaults } from '@/lib/preferences';
import { generateMeetingCode } from '@/lib/meetingCode';
import Avatar from '@/components/ui/Avatar';
import CreateMeetingDialog from '@/components/dashboard/CreateMeetingDialog';
import MeetingsSection from '@/components/dashboard/MeetingsSection';
import HistorySection from '@/components/dashboard/HistorySection';
import ContactsSection from '@/components/dashboard/ContactsSection';
import SettingsSection from '@/components/dashboard/SettingsSection';

const NAV = [
  { key: 'meetings', label: 'Réunions', icon: Video, title: 'Vos réunions' },
  { key: 'history', label: 'Historique', icon: CalendarClock, title: 'Historique' },
  { key: 'contacts', label: 'Contacts', icon: Users, title: 'Contacts' },
  { key: 'settings', label: 'Réglages', icon: Settings, title: 'Réglages' },
];

export default function DashboardPage() {
  const router = useRouter();

  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [loading, setLoading] = useState(true);

  const [section, setSection] = useState('meetings');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [inviteFor, setInviteFor] = useState(null);
  const [creatingInstant, setCreatingInstant] = useState(false);
  const [copiedCode, setCopiedCode] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  const preferences = useMemo(() => withDefaults(profile?.preferences), [profile?.preferences]);
  const timeZone = preferences.timeZone;

  // ---- Chargement ----
  const loadData = useCallback(async (hostId) => {
    const supabase = createClient();

    const { data: meetingRows } = await supabase
      .from('meetings')
      .select('*')
      .eq('host_id', hostId)
      .order('created_at', { ascending: false });

    const rows = meetingRows || [];
    setMeetings(rows);

    if (rows.length === 0) {
      setParticipants([]);
      return;
    }

    // Une seule requête pour toutes les réunions : l'e-mail des comptes arrive
    // par l'imbrication PostgREST (clé étrangère profile_id), ce qui évite une
    // requête par participant pour construire les contacts.
    const { data: participantRows } = await supabase
      .from('meeting_participants')
      .select('id, meeting_id, profile_id, guest_id, display_name, role, joined_at, left_at, profiles(email, full_name)')
      .in('meeting_id', rows.map((m) => m.id));

    setParticipants(participantRows || []);
  }, []);

  useEffect(() => {
    const init = async () => {
      const supabase = createClient();
      const { data: { user: authUser } } = await supabase.auth.getUser();

      if (!authUser) {
        router.push('/auth');
        return;
      }

      setUser(authUser);
      setProfile(await ensureProfile(supabase, authUser));
      await loadData(authUser.id);
      setLoading(false);
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadData]);

  // ---- Dérivations ----
  const participantsByMeeting = useMemo(() => {
    const grouped = {};
    for (const row of participants) {
      (grouped[row.meeting_id] ||= []).push(row);
    }
    return grouped;
  }, [participants]);

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const live = [];
    const soon = [];
    const done = [];

    for (const meeting of meetings) {
      const scheduled = meeting.scheduled_at ? new Date(meeting.scheduled_at).getTime() : null;

      if (meeting.status === 'active') live.push(meeting);
      else if (meeting.status === 'scheduled' && (!scheduled || scheduled >= now)) soon.push(meeting);
      else done.push(meeting);
    }

    // Les réunions en cours d'abord : c'est là qu'on veut cliquer.
    return { upcoming: [...live, ...soon], past: done };
  }, [meetings]);

  const contacts = useMemo(() => {
    const byKey = new Map();

    for (const row of participants) {
      const key = row.profile_id || row.guest_id;
      if (!key || key === user?.id) continue; // soi-même n'est pas un contact

      const existing = byKey.get(key);
      if (existing) {
        existing.meetings += 1;
        continue;
      }

      byKey.set(key, {
        key,
        name: row.profiles?.full_name || row.display_name || 'Participant',
        email: row.profiles?.email || null,
        meetings: 1,
      });
    }

    return Array.from(byKey.values()).sort((a, b) => b.meetings - a.meetings);
  }, [participants, user?.id]);

  // ---- Actions ----
  const copyLink = (code) => {
    navigator.clipboard.writeText(`${window.location.origin}/room/${code}`);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 1500);
  };

  const openRoom = (code) => router.push(`/room/${code}`);

  const handleInstant = async () => {
    if (!user) return;
    setCreatingInstant(true);

    const supabase = createClient();
    const { data, error } = await supabase
      .from('meetings')
      .insert({
        host_id: user.id,
        title: 'Réunion instantanée',
        meeting_code: generateMeetingCode(),
        waiting_room_enabled: preferences.waitingRoomDefault,
        status: 'active',
      })
      .select()
      .single();

    setCreatingInstant(false);
    if (error) {
      console.error('Création instantanée impossible:', error);
      return;
    }
    openRoom(data.meeting_code);
  };

  const handleCreated = (meeting) => {
    setShowCreate(false);
    setMeetings((prev) => [meeting, ...prev]);

    // Créée depuis un contact : on reste sur place et on met le lien dans le
    // presse-papier, puisque le but est de l'envoyer à quelqu'un — pas
    // d'entrer seul dans la salle.
    if (inviteFor) {
      setInviteFor(null);
      setSection('meetings');
      copyLink(meeting.meeting_code);
      return;
    }

    if (meeting.status === 'active') openRoom(meeting.meeting_code);
  };

  /** Inviter un contact : créer la réunion, puis copier le lien à lui envoyer. */
  const handleInvite = (contact) => {
    setInviteFor(contact);
    setShowCreate(true);
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);

    const supabase = createClient();
    // `.select()` est indispensable : une suppression bloquée par RLS ne
    // remonte aucune erreur, seulement « 0 ligne ». Sans ce contrôle,
    // l'interface effacerait la réunion à l'écran alors qu'elle reste en base.
    const { data, error } = await supabase
      .from('meetings')
      .delete()
      .eq('id', pendingDelete.id)
      .select();

    setDeleting(false);

    if (error) {
      setDeleteError("La réunion n'a pas pu être supprimée.");
      return;
    }
    if (!data || data.length === 0) {
      setDeleteError(
        'Suppression refusée par la base de données. La politique RLS de suppression sur « meetings » est probablement absente.'
      );
      return;
    }

    setMeetings((prev) => prev.filter((m) => m.id !== pendingDelete.id));
    setPendingDelete(null);
  };

  const handleSaveSettings = async ({ fullName, preferences: nextPreferences }) => {
    if (!user) return;
    setSavingSettings(true);
    setSettingsSaved(false);

    const supabase = createClient();
    const { data, error } = await supabase
      .from('profiles')
      .update({ full_name: fullName || profile?.full_name, preferences: nextPreferences })
      .eq('id', user.id)
      .select()
      .single();

    setSavingSettings(false);

    if (error || !data) {
      console.error('Enregistrement des réglages impossible:', error);
      return;
    }

    setProfile(data);
    setSettingsSaved(true);
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/auth');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="font-mono text-[13px] text-slate-500">Chargement…</p>
      </div>
    );
  }

  const current = NAV.find((item) => item.key === section) || NAV[0];

  const navList = (
    <nav className="flex-1 flex flex-col gap-1 p-3 lg:px-3 lg:py-5">
      {NAV.map(({ key, label, icon: Icon }) => {
        const active = key === section;
        const count = key === 'meetings' ? upcoming.length
          : key === 'history' ? past.length
          : key === 'contacts' ? contacts.length
          : null;

        return (
          <button
            key={key}
            onClick={() => { setSection(key); setMobileNavOpen(false); }}
            className={`flex items-center gap-3 h-[42px] px-3 rounded-md text-[14px] font-medium text-left transition-colors duration-150 ease-standard ${
              active ? 'bg-brand-50 text-brand-500' : 'text-slate-700 hover:bg-slate-100 hover:text-slate-950'
            }`}
          >
            <Icon className="h-[18px] w-[18px] flex-none" />
            {label}
            {count > 0 && <span className="ml-auto text-[12px] text-slate-500">{count}</span>}
          </button>
        );
      })}
    </nav>
  );

  const identity = (
    <div className="p-3 border-t border-slate-200">
      <div className="flex items-center gap-3 p-2.5 rounded-md">
        <Avatar size="md" name={profile?.full_name} seed={user?.id} />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium truncate">{profile?.full_name}</p>
          <p className="text-[12px] text-slate-500 truncate">{profile?.email}</p>
        </div>
        <button
          onClick={handleLogout}
          title="Déconnexion"
          className="w-8 h-8 flex-none flex items-center justify-center rounded-sm text-slate-500 hover:text-slate-950 hover:bg-slate-100 transition-colors"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-screen flex bg-slate-50 text-slate-950 overflow-hidden">
      {/* ---- Barre latérale ---- */}
      <aside className="hidden lg:flex w-64 flex-none flex-col bg-surface border-r border-slate-200">
        <Link href="/" className="flex items-center gap-2.5 h-[68px] px-5 border-b border-slate-200 text-slate-950">
          <span className="w-8 h-8 rounded-md bg-brand-500 flex items-center justify-center text-surface flex-none">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M22 8.6a1 1 0 0 0-1.5-.9L17 9.8V8a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1.8l3.5 2.1a1 1 0 0 0 1.5-.9V8.6Z" />
            </svg>
          </span>
          <span className="font-display font-bold text-[18px] tracking-heading">Stark Meet</span>
        </Link>
        {navList}
        {identity}
      </aside>

      {/* ---- Navigation mobile ---- */}
      {mobileNavOpen && (
        <>
          <div className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden" onClick={() => setMobileNavOpen(false)} />
          <aside className="fixed inset-y-0 left-0 z-40 w-64 flex flex-col bg-surface border-r border-slate-200 lg:hidden">
            <div className="flex items-center justify-between h-[68px] px-5 border-b border-slate-200">
              <span className="font-display font-bold text-[18px] tracking-heading">Stark Meet</span>
              <button onClick={() => setMobileNavOpen(false)} className="p-1.5 text-slate-500 hover:text-slate-950">
                <X className="h-4 w-4" />
              </button>
            </div>
            {navList}
            {identity}
          </aside>
        </>
      )}

      {/* ---- Contenu ---- */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <header className="flex-none h-[68px] flex items-center gap-4 px-4 sm:px-8 bg-surface border-b border-slate-200">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="lg:hidden p-2 -ml-2 rounded-sm text-slate-700 hover:bg-slate-100"
            title="Navigation"
          >
            <Menu className="h-5 w-5" />
          </button>

          <h1 className="font-display font-bold text-[20px] sm:text-[22px] tracking-heading truncate">
            {current.title}
          </h1>

          <button
            onClick={() => setShowCreate(true)}
            className="ml-auto h-10 px-4 sm:px-5 flex-none rounded-sm bg-brand-500 text-surface text-[14px] font-semibold hover:bg-brand-600 transition-colors"
          >
            <span className="hidden sm:inline">Nouvelle réunion</span>
            <span className="sm:hidden">Nouvelle</span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-8">
          {section === 'meetings' && (
            <MeetingsSection
              meetings={upcoming}
              participantsByMeeting={participantsByMeeting}
              timeZone={timeZone}
              creatingInstant={creatingInstant}
              copiedCode={copiedCode}
              onInstant={handleInstant}
              onSchedule={() => setShowCreate(true)}
              onJoinCode={openRoom}
              onCopyLink={copyLink}
              onOpen={openRoom}
              onDelete={(meeting) => { setPendingDelete(meeting); setDeleteError(''); }}
            />
          )}

          {section === 'history' && (
            <HistorySection
              meetings={past}
              participantsByMeeting={participantsByMeeting}
              timeZone={timeZone}
            />
          )}

          {section === 'contacts' && (
            <ContactsSection contacts={contacts} onInvite={handleInvite} />
          )}

          {section === 'settings' && (
            <SettingsSection
              profile={profile}
              preferences={preferences}
              onSave={handleSaveSettings}
              saving={savingSettings}
              saved={settingsSaved}
            />
          )}
        </div>
      </main>

      {showCreate && (
        <CreateMeetingDialog
          hostId={user.id}
          defaultWaitingRoom={preferences.waitingRoomDefault}
          onClose={() => { setShowCreate(false); setInviteFor(null); }}
          onCreated={handleCreated}
        />
      )}

      {pendingDelete && (
        <div className="fixed inset-0 bg-slate-950/40 flex items-center justify-center p-4 z-50">
          <div className="bg-surface rounded-lg shadow-overlay max-w-md w-full border border-slate-200 p-6">
            <h3 className="font-display font-bold text-[17px] tracking-heading">Supprimer cette réunion ?</h3>
            <p className="mt-2 text-[14px] text-slate-700">
              <span className="font-medium text-slate-950">{pendingDelete.title}</span>{' '}
              <span className="font-mono text-[12px] text-slate-500">({pendingDelete.meeting_code})</span>
            </p>
            <p className="mt-3 text-[13px] leading-relaxed text-slate-700">
              La discussion et la liste des participants seront supprimées avec elle, et le lien
              d&apos;invitation cessera de fonctionner. Cette action est définitive.
            </p>

            {deleteError && (
              <p className="mt-4 px-3.5 py-2.5 rounded-sm bg-error-50 text-error-500 text-[13px]">
                {deleteError}
              </p>
            )}

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="flex-1 h-11 rounded-sm border border-slate-200 text-[15px] font-medium text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 h-11 rounded-sm bg-error-500 text-surface text-[15px] font-semibold hover:brightness-110 transition disabled:opacity-50"
              >
                {deleting ? 'Suppression…' : 'Supprimer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
