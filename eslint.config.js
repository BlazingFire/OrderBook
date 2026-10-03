import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import orderbookI18n from './tools/eslint-rules/index.js';

/*
 * Runtime floors (docs/WINDOWS7.md).
 *
 * The Windows 7 Office build runs on Electron 22: Node 16.17 for the Office
 * server, the shared package and the shell, and Chromium 108 for the web UI.
 * The Master UI is held to Chromium 108 too, because a Win7 PC opens it in
 * Chrome 109. Each list below names what arrived after its floor, with the
 * replacement in the message.
 *
 * ES2023+ builtins (findLast, toSorted, ...) are not listed here: every
 * tsconfig's `lib` stops at ES2022, so they are already type errors, and
 * master/tests/legacy-floor.test.ts locks that.
 *
 * A feature-detected use (`typeof x.y === 'function'`) is fine. Mark it with
 * `// eslint-disable-next-line <rule> -- <why>`; never drop an entry.
 */
const NODE16 = {
  properties: [
    ['AbortSignal', 'any', 'Node 18.17. Wire the signals to one AbortController by hand.'],
    [
      'AbortSignal',
      'timeout',
      "not relied on below Node 18. Use an AbortController with an unref'd setTimeout (office/src has timeoutSignal()).",
    ],
    ['Readable', 'fromWeb', 'Node 17. Use Readable.from(body as AsyncIterable<Uint8Array>).'],
    ['Readable', 'toWeb', 'Node 17.'],
    [null, 'closeAllConnections', 'Node 18.2. Track the sockets and destroy them.'],
    [null, 'closeIdleConnections', 'Node 18.2. Track the sockets and destroy them.'],
    [
      null,
      'statfs',
      'Node 18.15. Feature-detect it, and fall back (see office/src/config/paths.ts).',
    ],
    [null, 'statfsSync', 'Node 18.15. Feature-detect it.'],
    [null, 'openAsBlob', 'Node 19.8.'],
    ['fs', 'glob', 'Node 22.'],
    ['fs', 'globSync', 'Node 22.'],
    ['os', 'availableParallelism', 'Node 18.14. Use os.cpus().length.'],
    ['util', 'styleText', 'Node 20.12.'],
    ['process', 'loadEnvFile', 'Node 21.7. Use office/src/lib/env-file.ts.'],
    ['process', 'getBuiltinModule', 'Node 22.3. Import the module.'],
    ['crypto', 'subtle', 'Node 17.4. Use the node:crypto functions.'],
    ['crypto', 'getRandomValues', 'Node 17.4. Use randomBytes from node:crypto.'],
  ],
  globals: [
    ['structuredClone', 'Node 17.'],
    ['ReadableStream', 'a global from Node 18. Import it from node:stream/web.'],
    ['WritableStream', 'a global from Node 18. Import it from node:stream/web.'],
    ['TransformStream', 'a global from Node 18. Import it from node:stream/web.'],
    ['BroadcastChannel', 'a global from Node 18.'],
    ['WebSocket', 'a global from Node 22.'],
    ['File', 'a global from Node 20.'],
    ['DOMException', 'a global from Node 17.'],
    ['CustomEvent', 'a global from Node 19.'],
    ['crypto', 'a global from Node 17/19. Import from node:crypto.'],
  ],
  imports: [
    [
      'fs',
      ['statfs', 'statfsSync', 'openAsBlob', 'glob', 'globSync', 'cp', 'cpSync'],
      'Node 18+, or experimental on Node 16 (cp, cpSync). A missing named export fails at link time on Node 16 and kills the whole module; import the namespace and feature-detect.',
    ],
    [
      'fs/promises',
      ['statfs', 'glob', 'cp'],
      'Node 18+, or experimental on Node 16 (cp). A missing named export fails at link time on Node 16; feature-detect on the namespace.',
    ],
    ['util', ['styleText'], 'Node 20.12.'],
    ['os', ['availableParallelism'], 'Node 18.14. Use os.cpus().length.'],
    ['readline/promises', null, 'Node 17.'],
    ['sqlite', null, 'Node 22.5.'],
  ],
  syntax: [
    [
      "MemberExpression[object.type='MetaProperty'][property.name=/^(dirname|filename)$/]",
      'import.meta.dirname/filename are Node 20.11. Use path.dirname(fileURLToPath(import.meta.url)).',
    ],
    [
      "CallExpression:matches([callee.name=/^readdir(Sync)?$/], [callee.property.name=/^readdir(Sync)?$/]) > ObjectExpression > Property[key.name='recursive']",
      'readdir({ recursive }) is Node 18.17. Walk the tree yourself.',
    ],
  ],
};

/* The Electron 22 shell: compiled to CommonJS for the Win7 build, with no web globals. */
const SHELL = {
  properties: [
    ['net', 'fetch', 'Electron 28. Use getJson() from electron/lib/health.ts (node:http).'],
    ['protocol', 'handle', 'Electron 25. Use protocol.registerFileProtocol.'],
    [null, 'navigationHistory', 'Electron 32. Use webContents.canGoBack() and friends.'],
  ],
  globals: [
    ['fetch', 'Node 18 without a flag. Use getJson() from electron/lib/health.ts (node:http).'],
    ['FormData', 'a global from Node 18.'],
    ['Blob', 'a global from Node 18. Import it from node:buffer.'],
    ['Response', 'a global from Node 18.'],
    ['Request', 'a global from Node 18.'],
    ['Headers', 'a global from Node 18.'],
  ],
  imports: [
    ['electron', ['webUtils'], 'Electron 29.'],
    [
      'electron',
      ['WebContentsView', 'BaseWindow'],
      'Electron 30. Use BrowserWindow / BrowserView.',
    ],
  ],
  syntax: [
    [
      "MetaProperty[meta.name='import']",
      'import.meta does not exist once the shell is compiled to CommonJS for the Win7 build. Use app.getAppPath().',
    ],
  ],
};

const CHROMIUM108 = {
  properties: [
    ['AbortSignal', 'any', 'Chromium 116. Use anySignal() from @orderbook/ui.'],
    ['URL', 'canParse', 'Chromium 120. Use try { new URL(x) } catch.'],
    ['URL', 'parse', 'Chromium 126. Use try { new URL(x) } catch.'],
    ['Object', 'groupBy', 'Chromium 117. Group with a loop into a Map.'],
    ['Map', 'groupBy', 'Chromium 117. Group with a loop into a Map.'],
    ['Promise', 'withResolvers', 'Chromium 119. Capture resolve/reject from new Promise().'],
    ['Array', 'fromAsync', 'Chromium 121. Collect with for await.'],
    ['document', 'startViewTransition', 'Chromium 111.'],
    ['scheduler', 'yield', 'Chromium 129. Use setTimeout(0).'],
    [
      'crypto',
      'randomUUID',
      'needs a secure context, and the Master is opened over plain LAN http. Build the id from crypto.getRandomValues.',
    ],
    [null, 'showPopover', 'the Popover API is Chromium 114. Use the ui Popover component.'],
    [null, 'hidePopover', 'the Popover API is Chromium 114.'],
    [null, 'togglePopover', 'the Popover API is Chromium 114.'],
    [null, 'isWellFormed', 'Chromium 111.'],
    [null, 'toWellFormed', 'Chromium 111.'],
    [
      null,
      'showPicker',
      "a select's showPicker is Chromium 121. Call it inside try/catch and fall back.",
    ],
  ],
  globals: [
    ['CloseWatcher', 'Chromium 120.'],
    ['Iterator', 'iterator helpers are Chromium 122.'],
  ],
  imports: [],
  syntax: [
    [
      "JSXAttribute[name.name='popover']",
      'the popover attribute is Chromium 114. Use the ui Popover component.',
    ],
  ],
};

/**
 * The four rule entries for a file set held to `floors`.
 *
 * Flat-config blocks replace a rule's options rather than merging them, so a
 * file set gets exactly one composed block. `node:` and bare specifiers are
 * both banned, since either loads the module.
 */
function floor(name, ...floors) {
  const lists = (key) => floors.flatMap((f) => f[key]);
  const say = (message) => `Above the ${name} runtime floor (docs/WINDOWS7.md): ${message}`;
  return {
    'no-restricted-properties': [
      'error',
      ...lists('properties').map(([object, property, message]) =>
        object ? { object, property, message: say(message) } : { property, message: say(message) },
      ),
    ],
    'no-restricted-globals': [
      'error',
      ...lists('globals').map(([n, message]) => ({ name: n, message: say(message) })),
    ],
    'no-restricted-imports': [
      'error',
      {
        paths: lists('imports').flatMap(([module, importNames, message]) =>
          (module === 'electron' ? [module] : [module, `node:${module}`]).map((n) =>
            importNames
              ? { name: n, importNames, message: say(message) }
              : { name: n, message: say(message) },
          ),
        ),
      },
    ],
    'no-restricted-syntax': [
      'error',
      ...lists('syntax').map(([selector, message]) => ({ selector, message: say(message) })),
    ],
  };
}

export default tseslint.config(
  // `coverage/` is the HTML report `npm run test:coverage` writes: generated,
  // gitignored, and not ours to lint.
  // `build/` and `.tmp/` are gitignored output: packaging, the CommonJS shell
  // compile (`build/shell-legacy`) and the legacy runtimes `npm run
  // smoke:legacy` downloads.
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/data/**',
      'coverage/**',
      'build/**',
      '.tmp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `varsIgnorePattern` covers destructuring-to-omit — `const { categoryId:
      // _categoryId, ...rest } = columns` is how a key is dropped from an
      // object, and the binding it creates is unused by design.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The tools/ scripts run under plain Node, not the browser/ES globals
    // `js.configs.recommended` assumes — without this, `console` and
    // `process` read as undefined names to the linter.
    files: ['tools/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // `tools/flip-fuses.cjs` is an electron-builder `afterPack` hook, which
    // electron-builder `require`s: it has to be CommonJS.
    files: ['tools/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    /*
     * The rules of hooks, enforced rather than assumed.
     *
     * Added after a `rules-of-hooks` violation shipped and made **both panels
     * unusable**: `App()` in each declared four hooks *below* its
     * signed-out early return, so the render after signing in produced more
     * hooks than the one before it, React threw, and the error boundary
     * replaced the whole panel with "Something went wrong on this screen".
     * Nothing caught it — this plugin was never installed, and the type
     * checker and the 1143-test suite cannot see it. A browser found it in
     * seconds.
     *
     * `rules-of-hooks` is an error, because every violation of it is a real
     * crash. `exhaustive-deps` stays a warning: this codebase deliberately
     * holds rebuilt-every-render callbacks in refs, and that pattern reads as
     * a missing dependency to the rule.
     */
    files: ['{master,office}/web/src/**/*.{ts,tsx}', 'ui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Scoped to the web packages' JSX, where the rule is meaningful. Severity
    // is `'off'`: `lint` is the first step of `npm run verify`, and ~4,000
    // lines of existing JSX are unswept. Promoted to `'error'` screen by
    // screen in the UI phase (`docs/backend-modules/05-EXISTING-CODE-CHANGES.md`
    // §8.1) — this registration proves the plugin wiring now, without
    // failing the batch for work that belongs to a later phase.
    files: ['{master,office}/web/src/**/*.tsx', 'ui/src/**/*.tsx'],
    plugins: { 'orderbook-i18n': orderbookI18n },
    rules: {
      'orderbook-i18n/no-untranslated-jsx-text': 'off',
    },
  },
  {
    /*
     * The swept files, where the rule is `'error'`.
     *
     * The blanket `'off'` above is right for ~4,000 unswept lines and wrong for
     * a file somebody has just finished translating: without this block a
     * sweep lasts exactly until the next agent adds a `<span>Primary</span>`,
     * which is what happened to a since-removed screen — it gained eight
     * English literals, two of them duplicating tokens added twelve lines
     * away, in the same commit that added the tokens.
     *
     * A guardrail brief asked for a test that catches this. The rule that
     * catches it already existed and was switched off; turning it on for the
     * files it now passes on is the smaller change, and unlike a test it names
     * the offending line.
     *
     * Add a file here as you finish translating it. Never remove one that
     * still exists. A file that is deleted takes its entry with it, and a
     * renamed one takes it along: a path that matches nothing is not an error
     * to ESLint, so the block would quietly cover less than it says.
     * `master/tests/tooling-config.test.ts` fails on an entry naming no file.
     */
    files: [
      'ui/src/BasicHome.tsx',
      'ui/src/StatTile.tsx',
      'ui/src/TopProgress.tsx',
      'ui/src/ImageCropModal.tsx',
      'ui/src/ProductImages.tsx',
      'ui/src/LogsScreen.tsx',
      'ui/src/TierPill.tsx',
      'ui/src/NotificationBell.tsx',
      'ui/src/ChatConversation.tsx',
      'ui/src/ChatGroupSettings.tsx',
      'ui/src/ChatroomScreen.tsx',
      'ui/src/ChatShareScreen.tsx',
      'ui/src/PrintroomScreen.tsx',
      'ui/src/PrintStationRunner.tsx',
      'ui/src/SendToPrintroomDialog.tsx',
      'ui/src/RecordNumber.tsx',
      'ui/src/AvatarStack.tsx',
      'ui/src/LeadStaleEdit.tsx',
      'office/web/src/components/ProductImages.tsx',
      'master/web/src/components/BackupAllSection.tsx',
      'master/web/src/components/AutoBackupSection.tsx',
    ],
    plugins: { 'orderbook-i18n': orderbookI18n },
    rules: {
      'orderbook-i18n/no-untranslated-jsx-text': 'error',
    },
  },
  /*
   * The runtime floors, one block per file set (see NODE16 above). The shared
   * package runs in the Office server and in both web UIs, so it gets both
   * floors. Only the shell files the Win7 build compiles are held to SHELL:
   * master.main.ts and the cleaner never run on Electron 22.
   */
  {
    name: 'floor/office-server',
    files: ['office/src/**/*.ts'],
    rules: floor('Node 16.17', NODE16),
  },
  {
    name: 'floor/shared',
    files: ['shared/src/**/*.ts'],
    rules: floor('Node 16.17 / Chromium 108', NODE16, CHROMIUM108),
  },
  {
    name: 'floor/web',
    files: ['ui/src/**/*.{ts,tsx}', '{master,office}/web/src/**/*.{ts,tsx}'],
    rules: floor('Chromium 108', CHROMIUM108),
  },
  {
    name: 'floor/shell',
    files: [
      'electron/shell.ts',
      'electron/office.main.ts',
      'electron/preload.cts',
      'electron/lib/*.ts',
    ],
    rules: floor('Electron 22', NODE16, SHELL),
  },
);
