/**
 * "Share in chat": pick where a pending or final order goes, add a line if you
 * like, and send it as a record chip.
 *
 * Reached from the Share in chat button on a record, which hands over just
 * `{kind, id}`. What the chip shows in the room is worked out for each reader,
 * so sharing a record with a room whose members may not open it is safe: they
 * see "Restricted record". Rooms the person cannot speak in (an announcement
 * group they do not run, an archived group) are not offered.
 */

import { useEffect, useRef, useState } from 'react';
import type { ChatRecordChip, ChatRoomSummary } from '@orderbook/shared';

import { Avatar } from './Avatar.js';
import { Button } from './Button.js';
import { roomTitle, type ChatTransport, type ChatViewer } from './chatModel.js';
import { EditorScreen } from './EditorScreen.js';
import { apiErrorText } from './errorText.js';
import { FormField, Textarea } from './Form.js';
import { t } from './i18n.js';
import { Icon } from './icons';
import { ConflictBanner, EmptyState, SkeletonRows } from './States.js';
import { useToast } from './Toast.js';

export interface ChatShareScreenProps {
  transport: ChatTransport;
  chip: ChatRecordChip;
  viewer: ChatViewer;
  onBack: () => void;
  /** After the post is sent (or queued): the room it went to. */
  onShared: (roomId: string) => void;
}

export function ChatShareScreen(props: ChatShareScreenProps) {
  const transportRef = useRef(props.transport);
  transportRef.current = props.transport;
  const toast = useToast();

  const [rooms, setRooms] = useState<ChatRoomSummary[] | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void transportRef.current.rooms().then(
      (found) => {
        if (cancelled) return;
        const manager = props.viewer.permissions.includes('chat.manage');
        setRooms(
          found.filter(
            (room) =>
              room.myRole !== null &&
              !room.archivedAt &&
              (room.kind !== 'announcement' || room.myRole === 'admin' || manager),
          ),
        );
      },
      (caught: unknown) => {
        if (!cancelled) setError(apiErrorText(caught, 'chat.error.load'));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.viewer.permissions]);

  async function share(): Promise<void> {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await transportRef.current.post(choice, { body: note.trim(), refs: [props.chip] });
      toast.push(t('chat.share.sent'), { tone: 'ok' });
      props.onShared(choice);
    } catch (caught) {
      setError(apiErrorText(caught, 'chat.error.send'));
    } finally {
      setBusy(false);
    }
  }

  const kind = props.chip.kind === 'lead' ? t('chat.ref.lead') : t('chat.ref.order');

  return (
    <EditorScreen
      title={t('chat.share.title')}
      meta={
        <span className="ob-chat-chip">
          <span className="ob-chat-chip-open">
            <Icon name={props.chip.kind === 'lead' ? 'leads' : 'orders'} size={12} />
            <span>{`${kind} ${props.chip.id}`}</span>
          </span>
        </span>
      }
      backLabel={t('chat.room.back')}
      onBack={() => {
        props.onBack();
        return true;
      }}
      // A note typed to go with the record is asked about before back throws it away.
      unsaved={note.trim() !== ''}
      actions={
        <Button variant="primary" busy={busy} disabled={!choice} onClick={() => void share()}>
          {t('chat.share.send')}
        </Button>
      }
    >
      {error && <ConflictBanner>{error}</ConflictBanner>}
      <div className="ob-chat-share">
        <h3 className="ob-body-strong">{t('chat.share.pickRoom')}</h3>
        {rooms === null ? (
          error ? null : <SkeletonRows rows={4} columns={2} />
        ) : rooms.length === 0 ? (
          <EmptyState title={t('chat.share.noRooms')} />
        ) : (
          <ul className="ob-chat-roomlist" role="radiogroup" aria-label={t('chat.share.pickRoom')}>
            {rooms.map((room) => (
              <li key={room.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={choice === room.id}
                  className="ob-chat-roomrow"
                  data-selected={choice === room.id ? 'true' : undefined}
                  onClick={() => setChoice(room.id)}
                >
                  {room.direct ? (
                    <Avatar name={room.direct.displayName} avatar={room.direct.avatar} size="sm" />
                  ) : (
                    <span className="ob-chat-roomicon" aria-hidden="true">
                      <Icon name="chat" size={16} />
                    </span>
                  )}
                  <span className="ob-chat-roomtext">
                    <span className="ob-body-strong">{roomTitle(room)}</span>
                  </span>
                  {choice === room.id && <Icon name="check" size={14} />}
                </button>
              </li>
            ))}
          </ul>
        )}

        <FormField label={t('chat.share.note')}>
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={note}
              maxLength={4000}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </FormField>
      </div>
    </EditorScreen>
  );
}
