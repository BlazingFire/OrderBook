/**
 * Who performed an action — a signed-in Master admin or a paired Office Panel.
 * Every mutating service call carries one, and the activity log records it, so
 * "who did this?" is always answerable.
 */

export interface ActorContext {
  actorType: 'user' | 'office_panel';
  actorId: string | null;
}

/**
 * The user id to stamp on rows that track authorship. Office Panels act on
 * behalf of unauthenticated staff, so their actions carry no user id.
 */
export function actorUserId(actor: ActorContext): string | null {
  return actor.actorType === 'user' ? actor.actorId : null;
}
