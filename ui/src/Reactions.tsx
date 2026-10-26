/**
 * Reactions: acknowledgement pills with rolling counts plus a picker for new
 * ones. Client-side state (value/onValueChange); the board persists what it
 * needs through its own transport. Kit icons only — no emoji set ships, so
 * nothing renders as tofu on a shop PC without colour fonts.
 */

import { useState } from 'react';

import { Icon, type IconName } from './icons.js';
import { t } from './i18n.js';
import { Popover } from './Popover.js';

export interface ReactionOption {
  id: string;
  label: string;
  icon: IconName;
}

export interface Reaction {
  id: string;
  count: number;
  reacted: boolean;
}

const FALLBACK_OPTIONS: ReactionOption[] = [
  { id: 'seen', label: 'Seen', icon: 'eye' },
  { id: 'ok', label: 'OK', icon: 'check' },
  { id: 'pin', label: 'Important', icon: 'pin' },
];

function optionLabel(options: ReactionOption[], fallback: ReactionOption[], id: string): { label: string; icon: IconName } {
  const found = options.find((option) => option.id === id) ?? fallback.find((option) => option.id === id);
  return { label: found?.label ?? id, icon: found?.icon ?? 'check' };
}

export function Reactions({
  options = FALLBACK_OPTIONS,
  value,
  defaultValue = [],
  onValueChange,
  label,
}: {
  options?: ReactionOption[];
  value?: Reaction[];
  defaultValue?: Reaction[];
  onValueChange?: (next: Reaction[], change: { id: string; reacted: boolean }) => void;
  label?: string;
}) {
  const [inner, setInner] = useState<Reaction[]>(defaultValue);
  const [picker, setPicker] = useState(false);
  const current = value ?? inner;
  const barLabel = label ?? t('common.reactions');

  const commit = (next: Reaction[], change: { id: string; reacted: boolean }): void => {
    if (value === undefined) setInner(next);
    onValueChange?.(next, change);
  };

  const toggle = (id: string): void => {
    const at = current.findIndex((reaction) => reaction.id === id);
    if (at < 0) {
      commit([...current, { id, count: 1, reacted: true }], { id, reacted: true });
      return;
    }
    const entry = current[at]!;
    if (entry.reacted) {
      const next = current
        .map((reaction) =>
          reaction.id === id
            ? { ...reaction, count: Math.max(0, reaction.count - 1), reacted: false }
            : reaction,
        )
        .filter((reaction) => reaction.count > 0);
      commit(next, { id, reacted: false });
    } else {
      const next = current.map((reaction) =>
        reaction.id === id ? { ...reaction, count: reaction.count + 1, reacted: true } : reaction,
      );
      commit(next, { id, reacted: true });
    }
  };

  return (
    <div role="group" aria-label={barLabel} className="ob-react-bar">
      {current.map((reaction) => {
        const { label: name, icon } = optionLabel(options, FALLBACK_OPTIONS, reaction.id);
        return (
          <button
            key={reaction.id}
            type="button"
            className="ob-react-pill"
            aria-pressed={reaction.reacted}
            aria-label={t('common.reactionCount', { label: name, count: reaction.count })}
            onClick={() => toggle(reaction.id)}
          >
            <Icon name={icon} size={14} />
            <span key={reaction.count} className="ob-react-count" aria-hidden="true">
              {reaction.count}
            </span>
            <span className="ob-sr-only" role="status">
              {t('common.reactionCount', { label: name, count: reaction.count })}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        className="ob-react-pill"
        aria-haspopup="true"
        aria-expanded={picker}
        aria-label={t('common.addReaction')}
        onClick={() => setPicker((value) => !value)}
      >
        <Icon name="plus" size={14} />
      </button>
      <Popover open={picker} onClose={() => setPicker(false)}>
        <div role="toolbar" aria-label={barLabel} className="ob-react-picker">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="ob-react-pick"
              aria-label={option.label}
              title={option.label}
              onClick={() => {
                toggle(option.id);
                setPicker(false);
              }}
            >
              <Icon name={option.icon} size={18} />
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}
