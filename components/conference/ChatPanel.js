'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Smile, ArrowDown, Plus } from 'lucide-react';
import { initialsOf, avatarColorFor } from '@/lib/identity';
import EmojiPicker from './EmojiPicker';

// Réactions proposées au survol : les six suffisent dans 95 % des cas, le
// bouton « + » ouvre le sélecteur complet pour le reste.
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👏', '😮'];

// Deux messages d'affilée de la même personne sont regroupés sous un seul
// en-tête tant qu'ils tiennent dans cette fenêtre.
const GROUPING_WINDOW_MS = 5 * 60 * 1000;

// Deux expressions pour un même motif : `String.split` a besoin du groupe
// capturant, mais `RegExp.test` sur une regex globale garde un `lastIndex`
// entre les appels et renverrait un résultat sur deux dans la boucle de rendu.
const URL_SPLIT = /(https?:\/\/[^\s<]+)/g;
const URL_TEST = /^https?:\/\/[^\s<]+$/;

const EMOJI_ONLY = /^(?:\s*(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Emoji_Component}|️|‍)+\s*)+$/u;

function countGraphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter().segment(text)].length;
  }
  return Array.from(text).length;
}

/** Un message fait uniquement d'un ou deux emojis mérite un rendu en grand. */
function isBigEmoji(text) {
  const trimmed = (text || '').trim();
  if (!trimmed || !EMOJI_ONLY.test(trimmed)) return false;
  const count = countGraphemes(trimmed.replace(/\s/g, ''));
  return count > 0 && count <= 3;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return "Aujourd'hui";
  if (sameDay(date, yesterday)) return 'Hier';
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Rend le texte en gardant les retours à la ligne et en rendant les liens cliquables. */
function renderContent(text) {
  return (text || '').split(URL_SPLIT).map((part, index) =>
    URL_TEST.test(part) ? (
      <a
        key={index}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="text-signal-300 underline underline-offset-2 break-all hover:text-signal-400"
      >
        {part}
      </a>
    ) : (
      part
    )
  );
}

/** Regroupe les réactions par emoji, en retenant qui a réagi. */
function groupReactions(reactions, currentUserId) {
  const grouped = new Map();

  for (const reaction of reactions || []) {
    if (!grouped.has(reaction.emoji)) {
      grouped.set(reaction.emoji, { emoji: reaction.emoji, names: [], mine: false });
    }
    const entry = grouped.get(reaction.emoji);
    entry.names.push(reaction.user_name);
    if (reaction.user_id === currentUserId) entry.mine = true;
  }

  return Array.from(grouped.values());
}

export default function ChatPanel({ messages, loading, currentUserId, onSend, onToggleReaction }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [composerPickerOpen, setComposerPickerOpen] = useState(false);
  const [reactionPickerFor, setReactionPickerFor] = useState(null);
  const [pendingCount, setPendingCount] = useState(0);

  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const atBottomRef = useRef(true);

  // Découpe la liste plate en éléments d'affichage : séparateurs de date et
  // messages, chacun sachant s'il ouvre un groupe.
  const items = useMemo(() => {
    const result = [];
    let previous = null;

    for (const message of messages) {
      const isNewDay =
        !previous ||
        new Date(previous.created_at).toDateString() !== new Date(message.created_at).toDateString();

      if (isNewDay) result.push({ type: 'day', id: `day-${message.id}`, at: message.created_at });

      const continuesGroup =
        !isNewDay &&
        previous?.sender_id === message.sender_id &&
        new Date(message.created_at) - new Date(previous.created_at) < GROUPING_WINDOW_MS;

      result.push({ type: 'message', id: message.id, message, startsGroup: !continuesGroup });
      previous = message;
    }

    return result;
  }, [messages]);

  const scrollToBottom = (behavior = 'smooth') => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    setPendingCount(0);
  };

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    atBottomRef.current = distance < 80;
    if (atBottomRef.current) setPendingCount(0);
  };

  // Ne pas arracher la lecture de l'historique : on ne suit le fil que si on
  // était déjà en bas, sinon on signale les nouveaux messages par une pastille.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom(messages.length <= 1 ? 'auto' : 'smooth');
    else setPendingCount((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  const insertInDraft = (text) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setDraft((prev) => prev + text);
      return;
    }
    const { selectionStart, selectionEnd } = textarea;
    setDraft((prev) => prev.slice(0, selectionStart) + text + prev.slice(selectionEnd));
    // Replacer le curseur après l'emoji inséré, une fois le rendu appliqué.
    requestAnimationFrame(() => {
      textarea.focus();
      const caret = selectionStart + text.length;
      textarea.setSelectionRange(caret, caret);
    });
  };

  const submit = async () => {
    const content = draft.trim();
    if (!content || sending) return;

    setSending(true);
    setDraft('');
    atBottomRef.current = true;

    const result = await onSend(content);
    if (!result?.ok) setDraft(content); // échec réseau : on rend sa saisie

    setSending(false);
  };

  const handleKeyDown = (event) => {
    // Entrée envoie, Maj+Entrée passe à la ligne — convention universelle des
    // messageries. Le composeur était un <input> mono-ligne auparavant.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto scrollbar-hide px-3 py-4 flex flex-col gap-0.5"
      >
        {loading && <p className="text-ink-500 text-sm text-center mt-8">Chargement…</p>}

        {!loading && messages.length === 0 && (
          <div className="text-center mt-10 px-4">
            <p className="text-mist-300 text-sm font-medium">Aucun message</p>
            <p className="text-ink-500 text-xs mt-1.5">
              Lancez la discussion — tout le monde dans la réunion la verra.
            </p>
          </div>
        )}

        {items.map((item) =>
          item.type === 'day' ? (
            <div key={item.id} className="flex items-center gap-3 py-3">
              <span className="flex-1 h-px bg-ink-700" />
              <span className="font-mono text-[10px] font-bold tracking-wide text-ink-600 uppercase">
                {formatDayLabel(item.at)}
              </span>
              <span className="flex-1 h-px bg-ink-700" />
            </div>
          ) : (
            <MessageRow
              key={item.id}
              message={item.message}
              startsGroup={item.startsGroup}
              currentUserId={currentUserId}
              onToggleReaction={onToggleReaction}
              pickerOpen={reactionPickerFor === item.id}
              onOpenPicker={() => setReactionPickerFor(item.id)}
              onClosePicker={() => setReactionPickerFor(null)}
            />
          )
        )}
      </div>

      {pendingCount > 0 && (
        <button
          onClick={() => scrollToBottom()}
          className="absolute left-1/2 -translate-x-1/2 bottom-[74px] z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-signal-500 hover:bg-signal-400 text-white text-[12px] font-semibold shadow-lg transition-colors"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          {pendingCount} nouveau{pendingCount > 1 ? 'x' : ''} message{pendingCount > 1 ? 's' : ''}
        </button>
      )}

      <div className="flex-none border-t border-ink-700 p-3">
        <div className="relative flex items-end gap-2">
          {composerPickerOpen && (
            <EmojiPicker
              align="left"
              onSelect={(emoji) => {
                insertInDraft(emoji);
                setComposerPickerOpen(false);
              }}
              onClose={() => setComposerPickerOpen(false)}
            />
          )}

          <button
            type="button"
            onClick={() => setComposerPickerOpen((open) => !open)}
            title="Emojis"
            className={`flex-none w-9 h-9 rounded-md flex items-center justify-center transition-colors ${
              composerPickerOpen ? 'bg-white/[0.1] text-white' : 'text-ink-500 hover:text-white hover:bg-white/[0.06]'
            }`}
          >
            <Smile className="h-[18px] w-[18px]" />
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Écrire un message…"
            className="flex-1 resize-none max-h-28 bg-white/[0.05] border border-ink-700 rounded-md px-3 py-2 text-[13.5px] leading-relaxed text-white placeholder:text-ink-500 focus:outline-none focus:border-signal-500 transition-colors scrollbar-hide"
          />

          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || sending}
            title="Envoyer"
            className="flex-none w-9 h-9 rounded-md bg-signal-500 hover:bg-signal-400 disabled:opacity-30 disabled:cursor-not-allowed text-white transition-colors flex items-center justify-center"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  startsGroup,
  currentUserId,
  onToggleReaction,
  pickerOpen,
  onOpenPicker,
  onClosePicker,
}) {
  const isMine = message.sender_id === currentUserId;
  const color = avatarColorFor(message.sender_id || message.sender_name);
  const reactions = groupReactions(message.reactions, currentUserId);
  const big = isBigEmoji(message.content);

  // Mes messages à droite, ceux des autres à gauche, avec des fonds distincts :
  // on identifie l'auteur d'un coup d'œil sans lire le nom, comme sur
  // WhatsApp ou Teams. L'avatar reste du côté extérieur de la bulle.
  return (
    <div
      className={`group relative flex gap-2 px-1 ${startsGroup ? 'mt-3' : ''} ${
        isMine ? 'flex-row-reverse' : 'flex-row'
      }`}
    >
      <div className="flex-none w-8">
        {startsGroup ? (
          <span
            className="w-8 h-8 rounded-full flex items-center justify-center font-mono text-[11px] font-bold"
            style={{ background: color.bg, color: color.fg }}
            title={message.sender_name}
          >
            {initialsOf(message.sender_name)}
          </span>
        ) : (
          // Colonne réservée pour aligner les bulles d'un même groupe.
          <span className="block w-8 h-full" />
        )}
      </div>

      <div className={`flex flex-col min-w-0 max-w-[78%] ${isMine ? 'items-end' : 'items-start'}`}>
        {startsGroup && (
          <div className={`flex items-baseline gap-2 mb-1 ${isMine ? 'flex-row-reverse' : ''}`}>
            <span className="text-[12.5px] font-semibold text-white truncate">
              {isMine ? 'Vous' : message.sender_name}
            </span>
            <span className="font-mono text-[10.5px] text-ink-600 flex-none">
              {formatTime(message.created_at)}
            </span>
          </div>
        )}

        <div
          className={`px-3 py-2 whitespace-pre-wrap break-words ${
            big ? 'text-[32px] leading-tight bg-transparent px-1 py-0' : 'text-[13.5px] leading-relaxed'
          } ${
            big
              ? ''
              : isMine
                ? 'bg-signal-500/20 border border-signal-500/30 text-white rounded-2xl rounded-tr-sm'
                : 'bg-white/[0.07] border border-white/[0.05] text-mist-300 rounded-2xl rounded-tl-sm'
          }`}
        >
          {renderContent(message.content)}
        </div>

        {reactions.length > 0 && (
          <div className={`flex flex-wrap gap-1 mt-1 ${isMine ? 'justify-end' : ''}`}>
            {reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                onClick={() => onToggleReaction(message.id, reaction.emoji)}
                title={reaction.names.join(', ')}
                className={`flex items-center gap-1 h-6 px-1.5 rounded-full text-[12px] border transition-colors ${
                  reaction.mine
                    ? 'bg-signal-500/15 border-signal-500/45 text-signal-300'
                    : 'bg-white/[0.06] border-transparent text-mist-300 hover:bg-white/[0.1]'
                }`}
              >
                <span>{reaction.emoji}</span>
                <span className="font-mono text-[10.5px] tabular-nums">{reaction.names.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Barre de réactions rapides, révélée au survol — côté intérieur, pour
          ne pas déborder du panneau. */}
      <div
        className={`absolute -top-2 z-10 items-center gap-0.5 p-0.5 rounded-md bg-ink-850 border border-ink-700 shadow-lg ${
          isMine ? 'left-2' : 'right-2'
        } ${pickerOpen ? 'flex' : 'hidden group-hover:flex'}`}
      >
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            onClick={() => onToggleReaction(message.id, emoji)}
            title={`Réagir avec ${emoji}`}
            className="w-6 h-6 rounded text-[14px] hover:bg-white/[0.1] transition-colors flex items-center justify-center"
          >
            {emoji}
          </button>
        ))}
        <span className="w-px h-4 bg-ink-700 mx-0.5" />
        <button
          onClick={() => (pickerOpen ? onClosePicker() : onOpenPicker())}
          title="Plus d'emojis"
          className="w-6 h-6 rounded text-ink-500 hover:text-white hover:bg-white/[0.1] transition-colors flex items-center justify-center"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        {pickerOpen && (
          <EmojiPicker
            align="right"
            onSelect={(emoji) => {
              onToggleReaction(message.id, emoji);
              onClosePicker();
            }}
            onClose={onClosePicker}
          />
        )}
      </div>
    </div>
  );
}
