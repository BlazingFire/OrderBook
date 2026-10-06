# OrderBook (version TBD): notice board

**Draft.** Not released. The version and date are set by whoever cuts the release; rename this file to the version then.
This file covers only the notice board. The other changes of the same batch are written by their owners.

## Install order

As before:
1. Install the Master Setup over the existing install first. There is no need to uninstall
   it; the data is kept.
2. Then install each Office Setup, or the Win7 Office Setup on Windows 7.
3. From then on, updates are automatic.

## What changed

- **A notice board.** The company can now put up short notices that everybody signed in reads on both the Master and the
  Office.
  - A notice has a title, a plain-text message, a priority (normal or important), an optional pin, an optional
    "show until" date, and who it is for: everybody, or the people holding chosen roles.
  - Open **Notice board** in the sidebar (or press Alt+N). Unread notices are marked, and a badge counts them. Important and
    pinned unread notices also appear on the Dashboard. "Mark as read" needs the Master to be reachable.
  - A notice disappears from the board after its last day. Pinned notices come first, then important ones, then the newest.
  - A notice is only text: line breaks are kept, nothing else is shown as formatting or as a link.
- **Notice board management.** A separate menu, **Notice board management** (Alt+M), for the people who may manage
  notices. They can add, edit, pin, set an end date, choose the audience, and delete. They see every notice, including
  expired ones, how many people have read each, and who. A deleted notice goes to the Recycle Bin and can be restored.
  - Two people editing the same notice: the second save is refused with a message to reload, so nobody's
    changes are lost silently.
- **Who sees what.** Everybody can read the notices meant for them; only the people allowed to manage notices see the
  other notices, the audiences and who has read what. A notice for the Office role is not shown to the Management role, and
  the other way round. Changing someone's role changes what they read from their next sign-in.
- **Access.** In Access, each role has a **Notice board** part: **Read** (every role has it after the update) and **Manage**
  (administrator roles have it after the update; a role below administrator cannot be given it).
- **Office PCs shared by several people.** Each person sees only their own notices. The board still opens when the Master
  is unreachable, from what that person had last time. Adding, editing and "mark as read" wait for the Master.

## Check before release

- The audit found a few gaps in the first version; confirm each is closed in the final build: notice titles must not show in
  the Activity log to people who cannot see the notice; a notice sent with a missing or wrong audience must be refused
  with a clear message instead of an error; the Office must show nothing from the notice board on a PC with nobody signed
  in.
- A real two-PC pass: one Master, one Office with two users of different roles, one administrator.
- The Electron window and the dark theme were not exercised.
