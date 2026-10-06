/**
 * The shared Chatroom over a fake `ChatTransport`, the way both panels mount it:
 * the room list and its unread figures, search, asking for a right, a room with
 * its composer, record chips and the record picker, tasks and their receipts,
 * the edit window, and Share in chat.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatMessage,
  ChatPerson,
  ChatRoomDetail,
  ChatRoomMember,
  ChatRoomSummary,
} from '@orderbook/shared';

import { ChatConversation } from '../src/ChatConversation.js';
import { ChatGroupSettings } from '../src/ChatGroupSettings.js';
import { ChatroomScreen } from '../src/ChatroomScreen.js';
import { useChatUnread } from '../src/chatUnread.js';
import { ChatShareScreen } from '../src/ChatShareScreen.js';
import type { ChatEvent, ChatTransport, ChatViewer } from '../src/chatModel.js';
import { ConfirmProvider } from '../src/ConfirmDialog.js';
import { t } from '../src/i18n.js';
import { ToastProvider } from '../src/Toast.js';
import { installBrowserStubs } from './panel-harness.js';

beforeEach(() => {
  installBrowserStubs();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- Fixtures -------------------------------------------------------------------

const person = (id: string, name: string, tier = 'office'): ChatPerson => ({ id, displayName: name, avatar: null, tier });
const ME = person('US1', 'Asha');
const BINA = person('US2', 'Bina');
const CHETAN = person('US3', 'Chetan', 'server_master');

const member = (who: ChatPerson, role: 'admin' | 'member', lastReadSeq = 0): ChatRoomMember => ({
  ...who,
  role,
  lastReadSeq,
});

const NOW = new Date().toISOString();
const LONG_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'seq'>): ChatMessage {
  return {
    roomId: 'room-1',
    kind: 'text',
    author: BINA,
    body: `message ${overrides.seq}`,
    refs: [],
    mentions: [],
    system: null,
    createdAt: NOW,
    editedAt: null,
    deletedAt: null,
    pinnedAt: null,
    pinnedBy: null,
    task: null,
    clientId: null,
    ...overrides,
  };
}

function summary(overrides: Partial<ChatRoomSummary> & Pick<ChatRoomSummary, 'id'>): ChatRoomSummary {
  return {
    kind: 'group',
    name: 'Dispatch desk',
    description: null,
    announceOnly: false,
    archivedAt: null,
    myRole: 'member',
    muted: false,
    lastSeq: 0,
    lastReadSeq: 0,
    unread: 0,
    mentionUnread: 0,
    memberCount: 3,
    lastMessageAt: null,
    lastMessage: null,
    direct: null,
    ...overrides,
  };
}

function detail(overrides: Partial<ChatRoomDetail> = {}): ChatRoomDetail {
  return {
    ...summary({ id: 'room-1', myRole: 'member', lastSeq: 2 }),
    members: [member(ME, 'member'), member(BINA, 'member'), member(CHETAN, 'admin')],
    pinned: [],
    ...overrides,
  };
}

interface Fake extends ChatTransport {
  emit: (event: ChatEvent) => void;
  listeners: Set<(event: ChatEvent) => void>;
}

function makeTransport(overrides: Partial<ChatTransport> = {}, rooms: ChatRoomSummary[] = []): Fake {
  const listeners = new Set<(event: ChatEvent) => void>();
  const transport: Fake = {
    people: vi.fn(async () => [ME, BINA, CHETAN]),
    rooms: vi.fn(async () => rooms),
    room: vi.fn(async () => detail()),
    messages: vi.fn(async () => [message({ id: 'CM1', seq: 1 }), message({ id: 'CM2', seq: 2 })]),
    post: vi.fn(async (roomId, input) => ({
      message: message({ id: 'CM9', seq: 3, roomId, author: ME, body: input.body, refs: [] }),
    })),
    edit: vi.fn(async (id, body) => message({ id, seq: 1, author: ME, body, editedAt: NOW })),
    remove: vi.fn(async (id) => message({ id, seq: 1, author: ME, body: '', deletedAt: NOW })),
    pin: vi.fn(async (id, pinned) => message({ id, seq: 1, pinnedAt: pinned ? NOW : null })),
    taskDone: vi.fn(async (id) => message({ id, seq: 1 })),
    read: vi.fn(async (_roomId, seq) => ({ lastReadSeq: seq })),
    mute: vi.fn(async () => null),
    direct: vi.fn(async () => summary({ id: 'direct-1', kind: 'direct', name: null, direct: BINA })),
    createRoom: vi.fn(async (input) => summary({ id: 'new-room', name: input.name })),
    updateRoom: vi.fn(async (roomId) => summary({ id: roomId })),
    setMember: vi.fn(async () => detail()),
    search: vi.fn(async () => []),
    tasks: vi.fn(async () => []),
    requestAccess: vi.fn(async () => ({ notified: 2 })),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    listeners,
    ...overrides,
  };
  return transport;
}

const viewer = (permissions: string[] = ['chat.use'], tier = 'office'): ChatViewer => ({ id: 'US1', permissions, tier });

function wrap(node: React.ReactElement) {
  return (
    <ToastProvider>
      <ConfirmProvider>{node}</ConfirmProvider>
    </ToastProvider>
  );
}

const noRecords = async () => [];

function room(transport: ChatTransport, extra: Partial<React.ComponentProps<typeof ChatConversation>> = {}) {
  return render(
    wrap(
      <ChatConversation
        transport={transport}
        roomId="room-1"
        viewer={viewer(['chat.use', 'chat.shareRecords', 'chat.tasks'])}
        onBack={() => undefined}
        onOpenSettings={() => undefined}
        onOpenRecord={() => undefined}
        findRecords={noRecords}
        {...extra}
      />,
    ),
  );
}

// --- The list ----------------------------------------------------------------------

function Badge({ transport, enabled = true }: { transport: ChatTransport; enabled?: boolean }) {
  const unread = useChatUnread(transport, enabled);
  return <span data-testid="badge">{`${unread.total}/${unread.mentions}`}</span>;
}

describe('unread figures', () => {
  const ROOMS = [
    summary({ id: 'a', lastSeq: 5, lastReadSeq: 2, unread: 3, mentionUnread: 1 }),
    summary({ id: 'b', lastSeq: 9, lastReadSeq: 0, unread: 9, muted: true, mentionUnread: 2 }),
    summary({ id: 'c', lastSeq: 4, lastReadSeq: 0, unread: 4, archivedAt: NOW }),
    summary({ id: 'd', lastSeq: 2, lastReadSeq: 2 }),
  ];

  it('counts rooms that are not muted or archived, and every mention in a live room', async () => {
    render(<Badge transport={makeTransport({}, ROOMS)} />);
    await waitFor(() => expect(screen.getByTestId('badge').textContent).toBe('3/3'));
  });

  it('asks for nothing without chat.use, and reads again a moment after a push', async () => {
    const quiet = makeTransport({}, ROOMS);
    render(<Badge transport={quiet} enabled={false} />);
    await act(async () => undefined);
    expect(quiet.rooms).not.toHaveBeenCalled();
    cleanup();

    const live = makeTransport({}, ROOMS);
    render(<Badge transport={live} />);
    await waitFor(() => expect(live.rooms).toHaveBeenCalledTimes(1));
    act(() => live.emit({ kind: 'room', roomId: 'a' }));
    await waitFor(() => expect(live.rooms).toHaveBeenCalledTimes(2));
    // Somebody else reading a room moves none of this person's figures.
    act(() => live.emit({ kind: 'read', roomId: 'a', userId: 'US2', seq: 3 }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(live.rooms).toHaveBeenCalledTimes(2);
  });
});

describe('the room list', () => {
  const ROOMS = [
    summary({
      id: 'a',
      name: 'Dispatch desk',
      lastSeq: 5,
      unread: 5,
      mentionUnread: 1,
      lastMessageAt: NOW,
      lastMessage: message({ id: 'CM5', seq: 5, body: 'Truck is here' }),
    }),
    summary({ id: 'b', name: 'Godown', muted: true, unread: 2, lastSeq: 2 }),
    summary({ id: 'c', kind: 'direct', name: null, direct: CHETAN }),
  ];

  function screenFor(transport: ChatTransport, permissions: string[] = ['chat.use'], tier = 'office') {
    return render(
      wrap(
        <ChatroomScreen
          transport={transport}
          page="rooms"
          viewer={viewer(permissions, tier)}
          openRoom={null}
          onOpenRoom={vi.fn()}
          share={null}
          onShareDone={() => undefined}
          onOpenRecord={() => undefined}
          findRecords={noRecords}
        />,
      ),
    );
  }

  it('shows each room with its unread pill, mention mark, mute mark and a Server Master badge on a direct chat', async () => {
    screenFor(makeTransport({}, ROOMS));

    const dispatch = (await screen.findByText('Dispatch desk')).closest('button')!;
    expect(within(dispatch).getByLabelText(t('chat.rooms.unreadLabel', { count: 5 }))).toBeTruthy();
    expect(within(dispatch).getByTitle(t('chat.rooms.mentioned'))).toBeTruthy();
    expect(within(dispatch).getByText(/Truck is here/)).toBeTruthy();

    const godown = screen.getByText('Godown').closest('button')!;
    expect(within(godown).getByText(t('chat.rooms.muted'))).toBeTruthy();

    const direct = screen.getAllByText('Chetan').map((node) => node.closest('button')).find(Boolean)!;
    expect(direct.querySelector('[data-server-master]')).not.toBeNull();
  });

  it('opens a room on click', async () => {
    const onOpenRoom = vi.fn();
    render(
      wrap(
        <ChatroomScreen
          transport={makeTransport({}, ROOMS)}
          page="rooms"
          viewer={viewer()}
          openRoom={null}
          onOpenRoom={onOpenRoom}
          share={null}
          onShareDone={() => undefined}
          onOpenRecord={() => undefined}
          findRecords={noRecords}
        />,
      ),
    );

    fireEvent.click((await screen.findByText('Godown')).closest('button')!);
    expect(onOpenRoom).toHaveBeenCalledWith({ id: 'b' });
  });

  it('searches messages from the search box that Ctrl+F finds, and opens a hit at its message', async () => {
    const onOpenRoom = vi.fn();
    const transport = makeTransport(
      {
        search: vi.fn(async () => [
          { message: message({ id: 'CM7', seq: 7, body: 'the pallet is ready' }), roomId: 'a', roomName: 'Dispatch desk', roomKind: 'group' as const },
        ]),
      },
      ROOMS,
    );
    render(
      wrap(
        <ChatroomScreen
          transport={transport}
          page="rooms"
          viewer={viewer()}
          openRoom={null}
          onOpenRoom={onOpenRoom}
          share={null}
          onShareDone={() => undefined}
          onOpenRecord={() => undefined}
          findRecords={noRecords}
        />,
      ),
    );

    const box = await screen.findByPlaceholderText(t('chat.rooms.search'));
    expect(box.hasAttribute('data-screen-search')).toBe(true);

    fireEvent.change(box, { target: { value: 'p' } });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(transport.search).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: 'pallet' } });
    const hit = await screen.findByText(/the pallet is ready/);
    expect(transport.search).toHaveBeenCalledWith('pallet');
    fireEvent.click(hit.closest('button')!);
    expect(onOpenRoom).toHaveBeenCalledWith({ id: 'a', seq: 7 });
  });

  it('offers only the controls the person\'s rights allow', async () => {
    screenFor(makeTransport({}, ROOMS), ['chat.use']);
    await screen.findByText('Dispatch desk');
    expect(screen.queryByRole('button', { name: t('chat.rooms.newDirect') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('chat.rooms.newGroup') })).toBeNull();
    cleanup();

    screenFor(makeTransport({}, ROOMS), ['chat.use', 'chat.directMessages', 'chat.createGroups', 'chat.tasks', 'chat.shareRecords'], 'management');
    await screen.findByText('Dispatch desk');
    expect(screen.getByRole('button', { name: t('chat.rooms.newDirect') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('chat.rooms.newGroup') })).toBeTruthy();
    expect(screen.queryByText(t('chat.access.hint'))).toBeNull();
  });

  it('offers Request access where a right is missing, and asks for exactly that one', async () => {
    const transport = makeTransport({}, ROOMS);
    screenFor(transport, ['chat.use', 'chat.shareRecords'], 'office');
    await screen.findByText('Dispatch desk');

    const ask = (right: string) => screen.queryByRole('button', { name: t('chat.access.ask', { right }) });
    expect(ask(t('permission.chat.directMessages'))).toBeTruthy();
    expect(ask(t('permission.chat.tasks'))).toBeTruthy();
    // Held already, and above an office role's ceiling: neither is offered.
    expect(ask(t('permission.chat.shareRecords'))).toBeNull();
    expect(ask(t('permission.chat.createGroups'))).toBeNull();

    fireEvent.click(ask(t('permission.chat.tasks'))!);
    await waitFor(() => expect(transport.requestAccess).toHaveBeenCalledWith('chat.tasks'));
    expect(await screen.findByText(t('chat.access.sent'))).toBeTruthy();
  });
});

// --- A room ----------------------------------------------------------------------------

describe('the composer', () => {
  it('is absent from an announcement group for a member and present for a room admin', async () => {
    room(makeTransport({ room: vi.fn(async () => detail({ kind: 'announcement', announceOnly: true, myRole: 'member' })) }));
    expect(await screen.findByText(t('chat.composer.announceOnly'))).toBeTruthy();
    expect(screen.queryByPlaceholderText(t('chat.composer.placeholder'))).toBeNull();
    cleanup();

    room(makeTransport({ room: vi.fn(async () => detail({ kind: 'announcement', announceOnly: true, myRole: 'admin' })) }));
    expect(await screen.findByPlaceholderText(t('chat.composer.placeholder'))).toBeTruthy();
  });

  it('is absent from an archived group, which can only be read', async () => {
    room(makeTransport({ room: vi.fn(async () => detail({ archivedAt: NOW })) }));
    expect(await screen.findByText(t('chat.room.archivedNote'))).toBeTruthy();
    expect(screen.queryByPlaceholderText(t('chat.composer.placeholder'))).toBeNull();
  });

  it('has no way to attach a file or a picture, anywhere', async () => {
    const { container } = room(makeTransport());
    await screen.findByPlaceholderText(t('chat.composer.placeholder'));

    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByLabelText(/attach|upload|photo|image|file/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /attach|upload|photo|image|file/i })).toBeNull();

    // And nothing in the screens' source could draw one.
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ['ChatConversation', 'ChatroomScreen', 'ChatGroupSettings', 'ChatShareScreen']) {
      const source = readFileSync(path.join(here, '..', 'src', `${file}.tsx`), 'utf8');
      expect(source).not.toMatch(/type=["']file["']/);
      expect(source).not.toMatch(/FileReader|DataTransfer|onPaste/);
    }
  });

  it('sends on Enter, keeps a new line on Shift+Enter, and shows the message that comes back', async () => {
    const transport = makeTransport();
    room(transport);
    const box = await screen.findByPlaceholderText(t('chat.composer.placeholder'));

    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(transport.post).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(transport.post).toHaveBeenCalledWith('room-1', { body: 'line one', refs: [], mentions: [], task: null }),
    );
    expect(await screen.findByText('line one')).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('opens a member list on @ and sends the mention', async () => {
    const transport = makeTransport();
    room(transport);
    const box = (await screen.findByPlaceholderText(t('chat.composer.placeholder'))) as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: 'hello @bi', selectionStart: 9 } });
    const list = await screen.findByRole('listbox', { name: t('chat.composer.mentionList') });
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual(['Bina']);

    fireEvent.mouseDown(within(list).getByRole('option', { name: 'Bina' }));
    expect(box.value).toBe('hello @Bina ');

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(transport.post).toHaveBeenCalled());
    expect(vi.mocked(transport.post).mock.calls[0]![1]).toMatchObject({ body: 'hello @Bina', mentions: ['US2'] });
  });

  it('keeps what is typed the moment the composer is drawn, before React has run its effects', async () => {
    // Waits on the DOM alone, without the settle Testing Library adds after a findBy: on a loaded
    // machine that settle can come after the typing, and a reset run on mount used to wipe it.
    room(makeTransport());
    const box = await new Promise<HTMLTextAreaElement>((resolve) => {
      const find = () => document.querySelector('textarea');
      const hit = find();
      if (hit) return resolve(hit);
      const observer = new MutationObserver(() => {
        const found = find();
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    fireEvent.change(box, { target: { value: 'hello @bi', selectionStart: 9 } });
    expect(await screen.findByRole('listbox', { name: t('chat.composer.mentionList') })).toBeTruthy();
    expect(box.value).toBe('hello @bi');
  });

  it('starts a new draft in another room, even one that opens from memory', async () => {
    const transport = makeTransport();
    const at = (roomId: string) =>
      wrap(
        <ChatConversation
          transport={transport}
          roomId={roomId}
          viewer={viewer(['chat.use', 'chat.shareRecords', 'chat.tasks'])}
          onBack={() => undefined}
          onOpenSettings={() => undefined}
          onOpenRecord={() => undefined}
          findRecords={noRecords}
        />,
      );
    // Room two read once, so it is held and opens without a blank moment.
    const view = render(at('room-2'));
    await screen.findByText('message 2');
    view.rerender(at('room-1'));
    await waitFor(() => expect(transport.room).toHaveBeenCalledWith('room-1'));
    const box = (await screen.findByPlaceholderText(t('chat.composer.placeholder'))) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'for room one', selectionStart: 12 } });

    view.rerender(at('room-2'));

    const next = (await screen.findByPlaceholderText(t('chat.composer.placeholder'))) as HTMLTextAreaElement;
    expect(next.value).toBe('');
  });

  it('does not treat an email address as a mention', async () => {
    room(makeTransport());
    const box = await screen.findByPlaceholderText(t('chat.composer.placeholder'));
    fireEvent.change(box, { target: { value: 'write to a@bi', selectionStart: 13 } });
    expect(screen.queryByRole('listbox', { name: t('chat.composer.mentionList') })).toBeNull();
  });
});

describe('record chips and the picker', () => {
  const OPTIONS = [
    { kind: 'order' as const, id: 'OD0000000009', label: 'OD0000000009', partyName: 'Patel Tiles' },
    { kind: 'lead' as const, id: 'LD0000000003', label: 'LD0000000003', partyName: 'Shah Traders' },
  ];

  it('shows the picker only with chat.shareRecords, searches records and sends a chip', async () => {
    const transport = makeTransport();
    const find = vi.fn(async () => OPTIONS);
    room(transport, { findRecords: find });

    fireEvent.click(await screen.findByRole('button', { name: t('chat.composer.addRecord') }));
    fireEvent.click(await screen.findByText(/Patel Tiles/));
    expect(find).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: t('chat.composer.removeRef', { label: 'OD0000000009' }) })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: t('chat.composer.send') }));
    await waitFor(() => expect(transport.post).toHaveBeenCalled());
    expect(vi.mocked(transport.post).mock.calls[0]![1]).toMatchObject({ refs: [{ kind: 'order', id: 'OD0000000009' }] });
    cleanup();

    room(makeTransport(), { viewer: viewer(['chat.use']) });
    await screen.findByPlaceholderText(t('chat.composer.placeholder'));
    expect(screen.queryByRole('button', { name: t('chat.composer.addRecord') })).toBeNull();
  });

  it('opens a chip it may open, and shows "Restricted record" for one it may not', async () => {
    const onOpenRecord = vi.fn();
    room(
      makeTransport({
        messages: vi.fn(async () => [
          message({
            id: 'CM1',
            seq: 1,
            refs: [
              { kind: 'order', id: 'OD1', label: 'OD1', partyName: 'Patel Tiles', restricted: false },
              { kind: 'lead', id: 'LD9', label: null, partyName: null, restricted: true },
            ],
          }),
        ]),
      }),
      { onOpenRecord },
    );

    const open = (await screen.findByText(/Patel Tiles/)).closest('button')!;
    fireEvent.click(open);
    expect(onOpenRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: 'order', id: 'OD1' }));

    const restricted = screen.getByText(t('chat.ref.restricted')).closest('button')!;
    expect(restricted.disabled).toBe(true);
    expect(document.body.textContent).not.toContain('LD9');
  });
});

describe('messages', () => {
  it('replaces a queued bubble with the Master\'s copy when the push with the same clientId arrives', async () => {
    const transport = makeTransport({
      post: vi.fn(async () => ({ pending: { clientId: 'MU-1', id: 'TMP1' } })),
    });
    room(transport);
    const box = await screen.findByPlaceholderText(t('chat.composer.placeholder'));

    fireEvent.change(box, { target: { value: 'queued words' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(t('chat.message.sending'))).toBeTruthy();

    act(() =>
      transport.emit({
        kind: 'message',
        roomId: 'room-1',
        message: message({ id: 'CM77', seq: 3, author: ME, body: 'queued words', clientId: 'MU-1' }),
      }),
    );
    await waitFor(() => expect(screen.queryByText(t('chat.message.sending'))).toBeNull());
    expect(screen.getAllByText('queued words')).toHaveLength(1);
  });

  it('shows a deleted message as a tombstone and an edited one as edited', async () => {
    room(
      makeTransport({
        messages: vi.fn(async () => [
          message({ id: 'CM1', seq: 1, body: '', deletedAt: NOW }),
          message({ id: 'CM2', seq: 2, body: 'corrected', editedAt: NOW }),
        ]),
      }),
    );
    expect(await screen.findByText(t('chat.message.deleted'))).toBeTruthy();
    expect(screen.getByText(/corrected/).textContent).toContain(t('chat.message.edited'));
  });

  it('offers Edit and Delete only on one\'s own messages inside five minutes, and Pin only to room admins', async () => {
    const own = message({ id: 'CM1', seq: 1, author: ME, body: 'mine, fresh' });
    const stale = message({ id: 'CM2', seq: 2, author: ME, body: 'mine, old', createdAt: LONG_AGO });
    const theirs = message({ id: 'CM3', seq: 3, author: BINA, body: 'theirs' });
    const messages = vi.fn(async () => [own, stale, theirs]);

    room(makeTransport({ messages }));
    await screen.findByText('mine, fresh');
    // One message action menu: the fresh own message (Edit, Delete). Not stale, not theirs, no pin for a member.
    const menus = screen.getAllByRole('button', { name: t('chat.message.actions') });
    expect(menus).toHaveLength(1);
    fireEvent.click(menus[0]!);
    expect(screen.getByRole('menuitem', { name: t('chat.message.edit') })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: t('chat.message.delete') })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: t('chat.message.pin') })).toBeNull();
    cleanup();

    // A room admin may also pin, and delete what others wrote.
    room(makeTransport({ messages, room: vi.fn(async () => detail({ myRole: 'admin' })) }));
    await screen.findByText('mine, fresh');
    expect(screen.getAllByRole('button', { name: t('chat.message.actions') })).toHaveLength(3);
  });

  it('edits a message in place', async () => {
    const transport = makeTransport({
      messages: vi.fn(async () => [message({ id: 'CM1', seq: 1, author: ME, body: 'first draft' })]),
    });
    room(transport);
    await screen.findByText('first draft');

    fireEvent.click(screen.getByRole('button', { name: t('chat.message.actions') }));
    fireEvent.click(screen.getByRole('menuitem', { name: t('chat.message.edit') }));
    const field = screen.getByRole('textbox', { name: t('chat.message.edit') });
    fireEvent.change(field, { target: { value: 'second draft' } });
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }));

    await waitFor(() => expect(transport.edit).toHaveBeenCalledWith('CM1', 'second draft', []));
    expect(await screen.findByText(/second draft/)).toBeTruthy();
  });

  it('loads older messages on request and shows day separators', async () => {
    const page = Array.from({ length: 50 }, (_, index) => message({ id: `CM${100 + index}`, seq: 100 + index }));
    const messages = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([message({ id: 'CM50', seq: 50, body: 'an older one' })]);
    room(makeTransport({ messages: messages as ChatTransport['messages'] }));

    await screen.findByText('message 100');
    expect(screen.getByText(t('chat.day.today'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('chat.room.loadOlder') }));
    expect(await screen.findByText('an older one')).toBeTruthy();
    expect(messages.mock.calls[1]![1]).toMatchObject({ beforeSeq: 100 });
  });

  it('keeps what it holds and says so when the Master is out of reach, then reads again on resync', async () => {
    const unavailable = Object.assign(new Error('unavailable'), { code: 'unavailable', pending: [] });
    const messages = vi
      .fn()
      .mockResolvedValueOnce([message({ id: 'CM1', seq: 1, body: 'already here' })])
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValue([message({ id: 'CM1', seq: 1, body: 'already here' }), message({ id: 'CM2', seq: 2, body: 'missed meanwhile' })]);
    const transport = makeTransport({ messages: messages as ChatTransport['messages'] });
    room(transport);
    await screen.findByText('already here');

    act(() => transport.emit({ kind: 'resync' }));
    expect(await screen.findByText(t('chat.offline'))).toBeTruthy();
    expect(screen.getByText('already here')).toBeTruthy();

    act(() => transport.emit({ kind: 'resync' }));
    expect(await screen.findByText('missed meanwhile')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(t('chat.offline'))).toBeNull());
  });

  it('reports what has been read a second after the room settles, and not before', async () => {
    const transport = makeTransport();
    room(transport);
    await screen.findByText('message 2');
    expect(transport.read).not.toHaveBeenCalled();
    await waitFor(() => expect(transport.read).toHaveBeenCalledWith('room-1', 2), { timeout: 3000 });
  });
});

describe('tasks', () => {
  const TASK = message({
    id: 'CM5',
    seq: 5,
    kind: 'task',
    author: CHETAN,
    body: 'Dispatch the Morbi order',
    task: { assignees: [ME], dueOn: '2026-11-02', doneAt: null, doneBy: null },
  });

  it('ticks a task through the transport and shows who finished it', async () => {
    const transport = makeTransport({
      messages: vi.fn(async () => [TASK]),
      taskDone: vi.fn(async () => ({ ...TASK, task: { ...TASK.task!, doneAt: NOW, doneBy: ME } })),
    });
    room(transport);
    await screen.findByText('Dispatch the Morbi order');
    expect(screen.getByText(t('chat.task.due', { date: '2026-11-02' }))).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: t('chat.task.markDone') }));
    await waitFor(() => expect(transport.taskDone).toHaveBeenCalledWith('CM5', true));
    expect(await screen.findByText(t('chat.task.doneBy', { name: 'Asha' }))).toBeTruthy();
  });

  it('does not let somebody who is not on the task tick it', async () => {
    room(makeTransport({ messages: vi.fn(async () => [{ ...TASK, task: { ...TASK.task!, assignees: [BINA] } }]) }));
    await screen.findByText('Dispatch the Morbi order');
    expect((screen.getByRole('checkbox', { name: t('chat.task.markDone') }) as HTMLInputElement).disabled).toBe(true);
  });

  it('counts "seen by" from the members\' read positions and lists the names', async () => {
    const withReads = detail({
      members: [member(ME, 'member', 5), member(BINA, 'member', 5), member(CHETAN, 'admin', 9)],
    });
    // Chetan wrote it; Asha and Bina are the others, and both have read up to it.
    room(makeTransport({ messages: vi.fn(async () => [TASK]), room: vi.fn(async () => withReads) }));
    await screen.findByText('Dispatch the Morbi order');
    expect(screen.getByRole('button', { name: t('chat.task.seenBy.other', { count: 2, total: 2 }) })).toBeTruthy();
    cleanup();

    const partly = detail({
      members: [member(ME, 'member', 5), member(BINA, 'member', 1), member(CHETAN, 'admin', 9)],
    });
    room(makeTransport({ messages: vi.fn(async () => [TASK]), room: vi.fn(async () => partly) }));
    const seen = await screen.findByRole('button', { name: t('chat.task.seenBy.other', { count: 1, total: 2 }) });
    fireEvent.click(seen);
    const names = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(names).toEqual(expect.arrayContaining(['Asha', 'Bina']));
  });

  it('shows the task toggle only with chat.tasks, and needs a person before it sends', async () => {
    const transport = makeTransport();
    room(transport);
    fireEvent.click(await screen.findByRole('button', { name: t('chat.composer.task') }));
    const box = screen.getByPlaceholderText(t('chat.composer.placeholder'));
    fireEvent.change(box, { target: { value: 'Please dispatch' } });
    expect((screen.getByRole('button', { name: t('chat.composer.send') }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Bina' }));
    fireEvent.click(screen.getByRole('button', { name: t('chat.composer.send') }));
    await waitFor(() => expect(transport.post).toHaveBeenCalled());
    expect(vi.mocked(transport.post).mock.calls[0]![1]).toMatchObject({ task: { assignees: ['US2'], dueOn: null } });
    cleanup();

    room(makeTransport(), { viewer: viewer(['chat.use']) });
    await screen.findByPlaceholderText(t('chat.composer.placeholder'));
    expect(screen.queryByRole('button', { name: t('chat.composer.task') })).toBeNull();
  });
});

describe('a room an administrator is looking at without being in it', () => {
  it('shows no messages and offers to add themselves', async () => {
    const transport = makeTransport({ room: vi.fn(async () => detail({ myRole: null })) });
    room(transport, { viewer: viewer(['chat.use', 'chat.manage']) });

    expect(await screen.findByText(t('chat.room.notMember'))).toBeTruthy();
    expect(transport.messages).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText(t('chat.composer.placeholder'))).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: t('chat.room.addMyself') }));
    await waitFor(() => expect(transport.setMember).toHaveBeenCalledWith('room-1', 'US1', 'member'));
  });
});

// --- Share in chat and group settings ----------------------------------------------------------

describe('Share in chat', () => {
  const ROOMS = [
    summary({ id: 'g', name: 'Dispatch desk', myRole: 'member' }),
    summary({ id: 'n', name: 'Notices', kind: 'announcement', announceOnly: true, myRole: 'member' }),
    summary({ id: 'x', name: 'Old group', archivedAt: NOW }),
    summary({ id: 'd', kind: 'direct', name: null, direct: BINA }),
  ];

  it('offers only rooms the person can speak in and sends the record as a chip with a note', async () => {
    const transport = makeTransport({}, ROOMS);
    const onShared = vi.fn();
    render(
      wrap(
        <ChatShareScreen
          transport={transport}
          chip={{ kind: 'order', id: 'OD0000000009' }}
          viewer={viewer(['chat.use', 'chat.shareRecords'])}
          onBack={() => undefined}
          onShared={onShared}
        />,
      ),
    );

    await screen.findByText('Dispatch desk');
    expect(screen.queryByText('Notices')).toBeNull();
    expect(screen.queryByText('Old group')).toBeNull();
    expect(screen.getAllByText('Bina').length).toBeGreaterThan(0);

    const send = screen.getByRole('button', { name: t('chat.share.send') }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: /Dispatch desk/ }));
    fireEvent.change(screen.getByLabelText(t('chat.share.note')), { target: { value: 'Please check' } });
    fireEvent.click(send);

    await waitFor(() =>
      expect(transport.post).toHaveBeenCalledWith('g', { body: 'Please check', refs: [{ kind: 'order', id: 'OD0000000009' }] }),
    );
    expect(onShared).toHaveBeenCalledWith('g');
  });
});

describe('group settings', () => {
  it('creates a group with the people chosen and the announcement switch', async () => {
    const transport = makeTransport();
    const onSaved = vi.fn();
    render(
      wrap(
        <ChatGroupSettings
          transport={transport}
          roomId="new"
          viewer={viewer(['chat.use', 'chat.createGroups'], 'management')}
          onBack={() => undefined}
          onSaved={onSaved}
          onLeft={() => undefined}
        />,
      ),
    );

    const create = screen.getByRole('button', { name: t('chat.group.create') }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(new RegExp(t('chat.group.name'))), { target: { value: 'Night shift' } });

    const picker = await screen.findByPlaceholderText(t('chat.group.addMember'));
    fireEvent.focus(picker);
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Bina' }));
    fireEvent.click(screen.getByRole('switch', { name: t('chat.group.announce') }));
    fireEvent.click(create);

    await waitFor(() =>
      expect(transport.createRoom).toHaveBeenCalledWith({
        name: 'Night shift',
        description: null,
        announceOnly: true,
        memberIds: ['US2'],
      }),
    );
    expect(onSaved).toHaveBeenCalledWith('new-room');
  });

  it('shows member controls to a room admin, not to a member who may only leave', async () => {
    const asAdmin = makeTransport({ room: vi.fn(async () => detail({ myRole: 'admin' })) });
    render(
      wrap(
        <ChatGroupSettings transport={asAdmin} roomId="room-1" viewer={viewer(['chat.use'])} onBack={() => undefined} onSaved={() => undefined} onLeft={() => undefined} />,
      ),
    );
    expect(await screen.findByRole('button', { name: t('common.save') })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: t('chat.group.makeAdmin') }).length).toBeGreaterThan(0);
    cleanup();

    const asMember = makeTransport({ room: vi.fn(async () => detail({ myRole: 'member' })) });
    render(
      wrap(
        <ChatGroupSettings transport={asMember} roomId="room-1" viewer={viewer(['chat.use'])} onBack={() => undefined} onSaved={() => undefined} onLeft={() => undefined} />,
      ),
    );
    await screen.findByText(t('chat.group.members'));
    expect(screen.queryByRole('button', { name: t('common.save') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('chat.group.makeAdmin') })).toBeNull();
    expect(screen.getByRole('button', { name: t('chat.group.leave') })).toBeTruthy();
  });
});
