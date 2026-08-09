'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Plus, Copy, Video, CalendarClock, Users, Settings } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import CreateMeetingDialog from '@/components/dashboard/CreateMeetingDialog';
import { initialsOf } from '@/lib/identity';

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  useEffect(() => {
    checkUser();
  }, []);

  const checkUser = async () => {
    const supabase = createClient();
    const { data: { user: authUser } } = await supabase.auth.getUser();

    if (!authUser) {
      router.push('/auth');
      return;
    }

    setUser(authUser);

    const { data: profileData } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', authUser.id)
      .maybeSingle();
    setProfile(profileData);

    await loadMeetings(authUser.id);
    setLoading(false);
  };

  const loadMeetings = async (hostId) => {
    const supabase = createClient();
    const { data } = await supabase
      .from('meetings')
      .select('*')
      .eq('host_id', hostId)
      .order('created_at', { ascending: false });
    setMeetings(data || []);
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/auth');
  };

  const handleCreated = (meeting) => {
    setShowCreateDialog(false);
    setMeetings((prev) => [meeting, ...prev]);
    if (meeting.status === 'active') {
      router.push(`/room/${meeting.meeting_code}`);
    }
  };

  const copyLink = (meetingCode) => {
    const url = `${window.location.origin}/room/${meetingCode}`;
    navigator.clipboard.writeText(url);
  };

  const statusPill = {
    scheduled: (
      <span className="font-mono text-[11px] font-semibold text-ink-500 border border-ink-700 rounded px-2 py-1">
        PLANIFIÉE
      </span>
    ),
    active: (
      <span className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-ok-500">
        <span className="w-1.5 h-1.5 rounded-full bg-ok-500 inline-block" />
        EN DIRECT
      </span>
    ),
    completed: (
      <span className="font-mono text-[11px] font-semibold text-ink-600 border border-ink-700 rounded px-2 py-1">
        TERMINÉE
      </span>
    ),
    cancelled: (
      <span className="font-mono text-[11px] font-semibold text-signal-300 border border-signal-500/30 rounded px-2 py-1">
        ANNULÉE
      </span>
    ),
  };

  const navItems = [
    { icon: Video, label: 'Réunions', active: true },
    { icon: CalendarClock, label: 'Historique', active: false },
    { icon: Users, label: 'Contacts', active: false },
    { icon: Settings, label: 'Paramètres', active: false },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <div className="text-mist-300 text-sm font-mono">Chargement…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950 flex">
      <aside className="hidden md:flex w-[248px] flex-none border-r border-ink-700 flex-col justify-between p-5 py-7">
        <div className="flex flex-col gap-8">
          <div className="flex items-center gap-2 font-mono font-bold text-white text-[15px]">
            <span className="w-1.5 h-1.5 rounded-full bg-signal-500 inline-block" />
            STARK MEET
          </div>
          <div className="flex flex-col gap-1">
            {navItems.map(({ icon: Icon, label, active }) => (
              <div
                key={label}
                className={`flex items-center gap-2.5 px-2.5 py-2.5 rounded-md text-sm ${
                  active ? 'bg-white/[0.06] text-white' : 'text-ink-500'
                }`}
              >
                <Icon className="h-[15px] w-[15px]" />
                {label}
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="w-[30px] h-[30px] rounded-full bg-[#1f4a45] text-white font-mono text-xs font-semibold flex items-center justify-center flex-none">
            {initialsOf(profile?.full_name)}
          </span>
          <div className="flex flex-col min-w-0">
            <span className="text-sm text-white truncate">{profile?.full_name}</span>
            <span className="text-[11.5px] text-ink-600">Hôte</span>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex md:hidden items-center justify-between px-5 py-4 border-b border-ink-700">
          <div className="flex items-center gap-2 font-mono font-bold text-white text-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-signal-500 inline-block" />
            STARK MEET
          </div>
          <button onClick={handleLogout} className="p-2 text-ink-500 hover:text-white hover:bg-ink-800 rounded-md transition-colors" title="Déconnexion">
            <LogOut className="h-4 w-4" />
          </button>
        </header>

        <main className="flex-1 px-6 sm:px-14 py-8 sm:py-11 max-w-[960px] w-full">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-bold text-white">Vos réunions</h1>
              <p className="text-sm text-ink-500">
                {meetings.filter((m) => m.status === 'scheduled').length} planifiée(s) ·{' '}
                {meetings.filter((m) => m.status === 'active').length} en direct actuellement
              </p>
            </div>
            <div className="hidden md:flex items-center gap-3">
              <button
                onClick={handleLogout}
                className="p-2.5 text-ink-500 hover:text-white hover:bg-ink-800 rounded-md transition-colors"
                title="Déconnexion"
              >
                <LogOut className="h-4 w-4" />
              </button>
              <button
                onClick={() => setShowCreateDialog(true)}
                className="text-sm font-semibold text-white px-[18px] py-2.5 bg-signal-500 hover:bg-signal-600 rounded whitespace-nowrap transition-colors"
              >
                + Nouvelle réunion
              </button>
            </div>
          </div>

          <button
            onClick={() => setShowCreateDialog(true)}
            className="md:hidden w-full mb-6 flex items-center justify-center gap-2 px-4 py-3 bg-signal-500 hover:bg-signal-600 text-white rounded text-sm font-semibold transition-colors"
          >
            <Plus className="h-4 w-4" />
            Nouvelle réunion
          </button>

          {meetings.length === 0 ? (
            <div className="border border-ink-700 rounded-md p-14 text-center">
              <Video className="h-10 w-10 text-ink-600 mx-auto mb-4" />
              <p className="text-mist-300 font-medium">Aucune réunion pour l'instant</p>
              <p className="text-ink-500 text-sm mt-1.5">Créez votre première réunion pour commencer.</p>
            </div>
          ) : (
            <div className="flex flex-col border border-ink-700 rounded-md overflow-hidden">
              {meetings.map((meeting) => (
                <div
                  key={meeting.id}
                  className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 px-5 py-[18px] border-b border-ink-700 last:border-b-0"
                >
                  <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="text-[15px] font-semibold text-white truncate">{meeting.title}</span>
                    <span className="font-mono text-[11.5px] text-ink-500">{meeting.meeting_code}</span>
                  </div>
                  <div className="flex items-center gap-3.5 flex-none">
                    {statusPill[meeting.status] || statusPill.scheduled}
                    <span className="text-[13px] text-ink-500 hidden sm:inline whitespace-nowrap">
                      {meeting.scheduled_at
                        ? new Date(meeting.scheduled_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
                        : 'Instantanée'}
                    </span>
                    {meeting.status !== 'completed' && meeting.status !== 'cancelled' ? (
                      <button
                        onClick={() => router.push(`/room/${meeting.meeting_code}`)}
                        className="text-[13px] font-semibold text-white px-3.5 py-2 bg-signal-500 hover:bg-signal-600 rounded transition-colors whitespace-nowrap"
                      >
                        Rejoindre
                      </button>
                    ) : null}
                    <button
                      onClick={() => copyLink(meeting.meeting_code)}
                      className="p-2 text-ink-500 hover:text-white hover:bg-white/[0.06] rounded-md transition-colors"
                      title="Copier le lien"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      {showCreateDialog && (
        <CreateMeetingDialog
          hostId={user.id}
          onClose={() => setShowCreateDialog(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
