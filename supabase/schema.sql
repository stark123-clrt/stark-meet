-- ============================================================================
-- STARK MEET — SCHEMA
-- ============================================================================
-- Source de vérité pour la base Supabase (self-hosted). À exécuter une fois
-- via l'éditeur SQL de Supabase Studio sur une instance neuve.
--
-- RLS permissive (USING (true)) sur toutes les tables — posture dev/MVP,
-- cohérente avec le reste du projet. Un durcissement des politiques est un
-- chantier séparé, à faire avant une mise en production réelle.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- Types
-- ============================================================================

do $$ begin
  create type meeting_status as enum ('scheduled', 'active', 'completed', 'cancelled');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type participant_role as enum ('host', 'co-host', 'guest');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type participant_status as enum ('waiting', 'admitted', 'denied', 'removed', 'left');
exception
  when duplicate_object then null;
end $$;

-- ============================================================================
-- profiles (extends auth.users)
-- ============================================================================

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text not null,
  avatar_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Préférences de l'utilisateur (réglages appliqués à chaque nouvel appel,
-- fuseau horaire d'affichage). En JSONB plutôt qu'en colonnes dédiées : ces
-- réglages évoluent souvent, et un ajout ne doit pas coûter une migration.
-- Ajouté après coup — cette ligne est sûre à rejouer sur une base en service.
alter table profiles add column if not exists preferences jsonb not null default '{}'::jsonb;

alter table profiles enable row level security;

create policy "Public can view all profiles" on profiles for select using (true);
create policy "Public can insert profiles" on profiles for insert with check (true);
create policy "Public can update profiles" on profiles for update using (true) with check (true);

-- ============================================================================
-- meetings
-- ============================================================================

create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  meeting_code text unique not null,
  scheduled_at timestamptz,
  duration_minutes integer default 60,
  waiting_room_enabled boolean not null default true,
  locked_at timestamptz,
  status meeting_status not null default 'scheduled',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table meetings enable row level security;

create policy "Public can view all meetings" on meetings for select using (true);
create policy "Public can insert meetings" on meetings for insert with check (true);
create policy "Public can update meetings" on meetings for update using (true) with check (true);
create policy "Public can delete meetings" on meetings for delete using (true);

create index if not exists idx_meetings_host on meetings(host_id);
create index if not exists idx_meetings_code on meetings(meeting_code);
create index if not exists idx_meetings_status on meetings(status);

-- ============================================================================
-- meeting_participants
-- ============================================================================
-- Un participant est soit un compte (profile_id), soit un invité anonyme
-- (guest_id — identifiant généré côté client et conservé en sessionStorage
-- pour retrouver son statut après un rafraîchissement de page).

create table if not exists meeting_participants (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  profile_id uuid references profiles(id) on delete cascade,
  guest_id uuid,
  display_name text not null,
  role participant_role not null default 'guest',
  status participant_status not null default 'waiting',
  force_muted boolean not null default false,
  joined_at timestamptz,
  left_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint meeting_participants_identity_check check (profile_id is not null or guest_id is not null)
);

alter table meeting_participants enable row level security;

create policy "Public can view all meeting participants" on meeting_participants for select using (true);
create policy "Public can insert meeting participants" on meeting_participants for insert with check (true);
create policy "Public can update meeting participants" on meeting_participants for update using (true) with check (true);
create policy "Public can delete meeting participants" on meeting_participants for delete using (true);

create index if not exists idx_meeting_participants_meeting on meeting_participants(meeting_id);
create index if not exists idx_meeting_participants_profile on meeting_participants(profile_id);
create index if not exists idx_meeting_participants_status on meeting_participants(meeting_id, status);

-- ============================================================================
-- meeting_messages (chat de réunion)
-- ============================================================================

create table if not exists meeting_messages (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  sender_id uuid not null,
  sender_name text not null,
  content text not null,
  created_at timestamptz default now()
);

alter table meeting_messages enable row level security;

create policy "Public can view all meeting messages" on meeting_messages for select using (true);
create policy "Public can insert meeting messages" on meeting_messages for insert with check (true);

create index if not exists idx_meeting_messages_meeting on meeting_messages(meeting_id);
create index if not exists idx_meeting_messages_created on meeting_messages(created_at);

-- ============================================================================
-- meeting_message_reactions (réactions emoji sur un message)
-- ============================================================================
-- user_id est l'identifiant applicatif de la personne : profile_id pour un
-- compte, guest_id pour un invité anonyme — sans clé étrangère, donc, puisque
-- les deux ne vivent pas dans la même table.
--
-- La contrainte d'unicité rend le basculement idempotent : réagir deux fois
-- avec le même emoji ne crée pas de doublon, et un double clic ne fausse pas
-- les compteurs.

create table if not exists meeting_message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references meeting_messages(id) on delete cascade,
  user_id uuid not null,
  user_name text not null,
  emoji text not null,
  created_at timestamptz default now(),
  constraint meeting_message_reactions_unique unique (message_id, user_id, emoji)
);

alter table meeting_message_reactions enable row level security;

-- `drop if exists` d'abord : ce bloc est destiné à être exécuté seul sur une
-- base déjà en service, et `create policy` échoue si la politique existe.
drop policy if exists "Public can view all message reactions" on meeting_message_reactions;
drop policy if exists "Public can insert message reactions" on meeting_message_reactions;
drop policy if exists "Public can delete message reactions" on meeting_message_reactions;

create policy "Public can view all message reactions" on meeting_message_reactions for select using (true);
create policy "Public can insert message reactions" on meeting_message_reactions for insert with check (true);
create policy "Public can delete message reactions" on meeting_message_reactions for delete using (true);

create index if not exists idx_message_reactions_message on meeting_message_reactions(message_id);



-- ============================================================================
-- updated_at triggers
-- ============================================================================


create or replace function update_updated_at_column()

returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;


do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'meetings', 'meeting_participants']
  loop
    execute format(
      'drop trigger if exists update_%1$s_updated_at on %1$s;
       create trigger update_%1$s_updated_at before update on %1$s
       for each row execute function update_updated_at_column();',
      t
    );
  end loop;
end $$;

-- ============================================================================
-- meeting_transcript_segments (transcription persistée)
-- ============================================================================
-- Jusqu'ici le transcript ne vivait qu'en mémoire dans le SFU : il disparaissait
-- à la fermeture de la salle et au moindre redéploiement, et l'espace admin
-- n'avait donc rien à afficher après la réunion.
--
-- Seules les phrases DÉFINITIVES sont écrites. Les hypothèses grises n'ont de
-- sens que pendant la réunion, où elles transitent par Socket.io.
--
-- segment_id est la clé stable produite par le transcripteur
-- (`<producerId>-<n>`). Le même segment est publié deux fois quand le LLM le
-- corrige : l'unicité sur (meeting_id, segment_id) transforme la seconde
-- écriture en remplacement au lieu d'un doublon.

create table if not exists meeting_transcript_segments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  segment_id text not null,
  participant_id text,
  display_name text not null,
  text text not null,
  -- Texte tel qu'entendu, conservé quand le LLM a corrigé, pour pouvoir revenir
  -- à la source si une correction s'avère fautive.
  raw_text text,
  corrected boolean not null default false,
  -- Instant de PRONONCIATION, pas d'arrivée : deux locuteurs dont les flux
  -- n'avancent pas au même rythme verraient sinon une réponse précéder sa
  -- question. C'est la clé de tri à la relecture.
  spoken_at timestamptz not null,
  created_at timestamptz default now(),
  constraint meeting_transcript_segments_unique unique (meeting_id, segment_id)
);

alter table meeting_transcript_segments enable row level security;

-- ⚠️ Politique DÉLIBÉRÉMENT plus stricte que les autres tables du schéma.
-- Un transcript est le contenu même de la conversation : le « Public can view
-- all » utilisé ailleurs exposerait toutes les réunions de tous les comptes à
-- la clé anonyme. Seuls l'hôte et les participants identifiés lisent, et
-- personne n'écrit avec cette clé — le SFU passe par la clé de service, qui
-- contourne RLS.
--
-- Un invité anonyme (guest_id) ne relit pas : il n'a pas de compte, donc pas
-- d'espace admin. Pendant la réunion il reçoit tout par Socket.io comme avant.

create policy "Host and members can view transcript"
  on meeting_transcript_segments for select
  using (
    exists (
      select 1 from meetings m
      where m.id = meeting_transcript_segments.meeting_id
        and m.host_id = auth.uid()
    )
    or exists (
      select 1 from meeting_participants p
      where p.meeting_id = meeting_transcript_segments.meeting_id
        and p.profile_id = auth.uid()
    )
  );

create index if not exists idx_transcript_segments_meeting
  on meeting_transcript_segments(meeting_id, spoken_at);

-- ============================================================================
-- Realtime publication
-- ============================================================================
-- ⚠️ L'application ne dépend PLUS de Supabase Realtime. Son websocket n'est
-- pas exposé sur cette instance self-hosted : aucun événement n'arrivait aux
-- clients, qui devaient rafraîchir la page pour voir une demande d'admission,
-- une admission ou un mute forcé.
--
-- Tout le temps réel passe désormais par le serveur Socket.io (events
-- `control:*` dans server-mediasoup.js) ; ces tables restent la source de
-- vérité persistante, relue au chargement et en réconciliation périodique.
--
-- La publication est conservée : elle ne coûte rien et redevient utilisable
-- telle quelle si le service Realtime est un jour correctement exposé.

do $$
declare
  t text;
begin
  foreach t in array array['meeting_participants', 'meeting_messages']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I;', t);
    end if;
  end loop;
end $$;
