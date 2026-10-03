/**
 * A chat group's settings, as a sub-screen with its own sidebar entry rather
 * than a dialog: its name and description, announcement mode, archiving, and
 * its members. The same screen creates a group (`roomId === 'new'`).
 *
 * Who may do what is the Master's call (room admins in their own group,
 * `chat.manage` holders in every group); here the controls simply are not drawn
 * for anybody else. Anyone may leave a group they are in.
 */

import { useEffect, useRef, useState } from 'react';
import type { ChatMemberRole, ChatPerson, ChatRoomDetail } from '@orderbook/shared';

import { Avatar } from './Avatar.js';
import { Button } from './Button.js';
import type { ChatTransport, ChatViewer } from './chatModel.js';
import { Combobox } from './Combobox.js';
import { useConfirm } from './ConfirmDialog.js';
import { EditorScreen } from './EditorScreen.js';
import { apiErrorText } from './errorText.js';
import { FormField, Input, Switch, Textarea } from './Form.js';
import { t } from './i18n.js';
import { ConflictBanner, SkeletonRows } from './States.js';
import { ServerMasterBadge } from './TierPill.js';
import { useToast } from './Toast.js';

export interface ChatGroupSettingsProps {
  transport: ChatTransport;
  /** A room id, or `'new'` to create a group. */
  roomId: string;
  viewer: ChatViewer;
  onBack: () => void;
  /** After a group is created or saved. */
  onSaved: (roomId: string) => void;
  /** After the viewer leaves a group they can no longer see. */
  onLeft: () => void;
}

export function ChatGroupSettings(props: ChatGroupSettingsProps) {
  const { roomId, viewer } = props;
  const creating = roomId === 'new';
  const transportRef = useRef(props.transport);
  transportRef.current = props.transport;
  const callbacks = useRef(props);
  callbacks.current = props;
  const toast = useToast();
  const confirm = useConfirm();

  const [detail, setDetail] = useState<ChatRoomDetail | null>(null);
  const [people, setPeople] = useState<ChatPerson[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [announce, setAnnounce] = useState(false);
  const [newMembers, setNewMembers] = useState<ChatPerson[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void transportRef.current.people().then(
      (found) => {
        if (!cancelled) setPeople(found);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (creating) return;
    let cancelled = false;
    void transportRef.current.room(roomId).then(
      (room) => {
        if (cancelled) return;
        setDetail(room);
        setName(room.name ?? '');
        setDescription(room.description ?? '');
        setAnnounce(room.announceOnly);
      },
      (caught: unknown) => {
        if (!cancelled) setError(apiErrorText(caught, 'chat.error.load'));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [roomId, creating]);

  const isManager = viewer.permissions.includes('chat.manage');
  const mayEdit = creating || detail?.myRole === 'admin' || isManager;
  const inRoom = new Set(detail?.members.map((member) => member.id) ?? []);
  const addable = people.filter(
    (person) => person.id !== viewer.id && !inRoom.has(person.id) && !newMembers.some((m) => m.id === person.id),
  );

  async function refresh(): Promise<void> {
    setDetail(await transportRef.current.room(roomId));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const room = await transportRef.current.createRoom({
          name,
          description: description.trim() === '' ? null : description,
          announceOnly: announce,
          memberIds: newMembers.map((person) => person.id),
        });
        toast.push(t('chat.group.created'), { tone: 'ok' });
        callbacks.current.onSaved(room.id);
      } else if (detail) {
        await transportRef.current.updateRoom(roomId, {
          name,
          description: description.trim() === '' ? null : description,
          announceOnly: announce,
        });
        toast.push(t('chat.group.saved'), { tone: 'ok' });
        await refresh();
      }
    } catch (caught) {
      setError(apiErrorText(caught, 'chat.error.group'));
    } finally {
      setBusy(false);
    }
  }

  async function archive(archived: boolean): Promise<void> {
    if (archived) {
      const ok = await confirm({
        title: t('chat.group.archiveTitle'),
        body: t('chat.group.archiveBody'),
        confirmLabel: t('chat.group.archive'),
        tone: 'danger',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await transportRef.current.updateRoom(roomId, { archived });
      await refresh();
    } catch (caught) {
      setError(apiErrorText(caught, 'chat.error.group'));
    } finally {
      setBusy(false);
    }
  }

  async function setMember(userId: string, role: ChatMemberRole | null): Promise<void> {
    try {
      const next = await transportRef.current.setMember(roomId, userId, role);
      if (userId === viewer.id && role === null) {
        callbacks.current.onLeft();
        return;
      }
      if (next) setDetail(next);
    } catch (caught) {
      toast.push(apiErrorText(caught, 'chat.error.member'), { tone: 'error' });
    }
  }

  async function leave(): Promise<void> {
    const ok = await confirm({
      title: t('chat.group.leaveTitle'),
      body: t('chat.group.leaveBody'),
      confirmLabel: t('chat.group.leave'),
      tone: 'danger',
    });
    if (ok) await setMember(viewer.id, null);
  }

  return (
    <EditorScreen
      title={creating ? t('chat.rooms.newGroup') : t('chat.group.title')}
      backLabel={t('chat.room.back')}
      onBack={() => {
        props.onBack();
        return true;
      }}
      actions={
        mayEdit ? (
          <Button variant="primary" busy={busy} disabled={name.trim() === ''} onClick={() => void save()}>
            {creating ? t('chat.group.create') : t('common.save')}
          </Button>
        ) : undefined
      }
    >
      {error && <ConflictBanner>{error}</ConflictBanner>}
      {!creating && !detail && !error && <SkeletonRows rows={4} columns={2} />}

      {(creating || detail) && (
        <div className="ob-chat-settings">
          {mayEdit && (
            <section className="ob-chat-settings-form">
              <FormField label={t('chat.group.name')} required>
                {(id) => (
                  <Input id={id} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
                )}
              </FormField>
              <FormField label={t('chat.group.description')}>
                {(id) => (
                  <Textarea
                    id={id}
                    rows={2}
                    value={description}
                    maxLength={280}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                )}
              </FormField>
              <Switch checked={announce} onChange={setAnnounce} label={t('chat.group.announce')} />
              <p className="ob-small">{t('chat.group.announceHelp')}</p>
            </section>
          )}

          <section className="ob-chat-settings-members">
            <h3 className="ob-body-strong">{t('chat.group.members')}</h3>

            {mayEdit && (
              <Combobox
                placeholder={t('chat.group.addMember')}
                options={addable.map((person) => ({ key: person.id, label: person.displayName, value: person }))}
                onSelect={(option) => {
                  if (creating) setNewMembers((current) => [...current, option.value]);
                  else void setMember(option.value.id, 'member');
                }}
              />
            )}

            <ul className="ob-chat-memberlist">
              {creating &&
                newMembers.map((person) => (
                  <li key={person.id} className="ob-chat-member">
                    <Avatar name={person.displayName} avatar={person.avatar} size="sm" />
                    <span className="ob-chat-membername">{person.displayName}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setNewMembers((current) => current.filter((m) => m.id !== person.id))}
                    >
                      {t('chat.group.remove')}
                    </Button>
                  </li>
                ))}
              {detail?.members.map((member) => (
                <li key={member.id} className="ob-chat-member">
                  <Avatar
                    name={member.displayName}
                    avatar={member.avatar}
                    size="sm"
                    highlight={member.tier === 'server_master'}
                  />
                  <span className="ob-chat-membername">
                    {member.displayName}
                    {member.tier === 'server_master' && <ServerMasterBadge />}
                  </span>
                  {member.role === 'admin' && <span className="ob-chat-badge">{t('chat.group.admin')}</span>}
                  {mayEdit && member.id !== viewer.id && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void setMember(member.id, member.role === 'admin' ? 'member' : 'admin')}
                      >
                        {member.role === 'admin' ? t('chat.group.makeMember') : t('chat.group.makeAdmin')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void setMember(member.id, null)}>
                        {t('chat.group.remove')}
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {!creating && detail && (
            <section className="ob-chat-settings-danger">
              {detail.myRole && (
                <Button variant="danger" onClick={() => void leave()}>
                  {t('chat.group.leave')}
                </Button>
              )}
              {mayEdit && (
                <Button
                  variant={detail.archivedAt ? 'secondary' : 'danger'}
                  busy={busy}
                  onClick={() => void archive(detail.archivedAt === null)}
                >
                  {detail.archivedAt ? t('chat.group.unarchive') : t('chat.group.archive')}
                </Button>
              )}
            </section>
          )}
        </div>
      )}
    </EditorScreen>
  );
}
