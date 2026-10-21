import { Fragment } from 'react';
import { getApi } from '../hooks/useApi';

// Links in message texts are clickable; Telegram ones open inside the app (main routes them to «Чаты»)
const LINK = /((?:https?:\/\/|tg:\/\/)[^\s<>"«»]+|(?<![\w/.])(?:t|telegram)\.me\/[^\s<>"«»]+)/gi;

export function LinkText({ text }: { text: string }) {
  const parts = text.split(LINK);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={p}
            className="text-link"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const url = /^(https?|tg):/i.test(p) ? p.replace(/[.,!?)]+$/, '') : `https://${p.replace(/[.,!?)]+$/, '')}`;
              void getApi().shell.openExternal(url);
            }}
          >
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
