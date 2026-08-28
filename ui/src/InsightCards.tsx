/**
 * The "worth a look" strip on a dashboard.
 *
 * **The figures always render.** They are the result of a SQL query, and the
 * sentence beside them — when there is one — is the only thing a model
 * contributed. That order is the whole design: a feature whose numbers depend
 * on a language model being reachable is a feature that stops working when the
 * shop's internet does, and this one keeps working with the assistant switched
 * off entirely.
 *
 * Renders nothing at all when there is nothing unusual. An empty card headed
 * "worth a look" is a card people learn to skip past, and then miss the day it
 * has something in it.
 */

import { useEffect, useState } from 'react';
import type { Insight } from '@orderbook/shared';

import { Card } from './Card';
import { t } from './i18n';

export function InsightCards({ load }: { load: () => Promise<Insight[]> }) {
  const [insights, setInsights] = useState<Insight[] | null>(null);

  useEffect(() => {
    // A failure is silence, not an error banner: the assistant being off, or
    // its Master being unreachable, is not something a dashboard should shout
    // about — every other figure on the screen is still correct.
    void load()
      .then(setInsights)
      .catch(() => setInsights([]));
  }, [load]);

  if (!insights || insights.length === 0) return null;

  return (
    <Card>
      <div className="ob-eyebrow">{t('insight.title')}</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {insights.map((insight) => (
          <li
            key={`${insight.code}:${insight.subjectId ?? ''}`}
            style={{ marginTop: 'var(--s-8)' }}
          >
            {/* The computed half. This line is present whether or not a model
                ever answered. */}
            <div className="ob-body">{t(`insight.${insight.code}`, insight.figures)}</div>
            {insight.note && <p className="ob-ai-note ob-small">{insight.note}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
