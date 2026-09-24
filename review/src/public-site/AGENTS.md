# selfbench.dev Agent Instructions

The public site (selfbench.dev). The root `AGENTS.md` applies here too.

## Phones: Write for the Web, the Mobile Layer Adapts

Pages are written once, for any screen. `mobile/` adapts them to phones and touch, so a web
change needs no phone twin. Do not add phone-only copies of pages or components, and do not
branch on screen width or user agent in scripts. When something new does not fit the layer,
extend `mobile/` (a variant, a utility, a component) and describe it here; do not special-case
the page.

The layer (`mobile/mobile.css`, `mobile/device.ts`, `mobile/AdaptiveTable.tsx`):

- Space: the frame's measurements are CSS variables (`--edge`, `--gutter`, `--bar-inset`,
  `--bar-top`, `--bar-bottom`, `--page-pad`, in `theme.css`), narrowed for phones in
  `mobile.css`. Frame pages with `frame.ts` (`FRAME`, `EDGE_FRAME`, `RULER_WIDTH`) and those
  variables, not fixed pixels.
- `compact:` is a small or short screen, a phone either way up (width under 40rem or height
  under 32rem). Use it for sizes that must differ on a phone.
- `touch:` is a finger (`pointer: coarse`). `hover:` already applies only where the pointer can
  hover, and `card-on:` is a card's hover look, gated the same way.
- `hit` gives a small control a 44px tap area on touch without moving anything. The control
  must be positioned: `hit relative`.
- Tables: `AdaptiveTable`, with each column's role (title, detail, metric). It is a table where
  there is room and cards where there is not. Do not write a `<table>` directly.
- Scripts: `touchInput()` and `canHover()` in `device.ts`, with the same media queries.

What keeps a new feature phone-ready with no extra work:

1. Flex and grid that wrap. Flex children that hold text get `min-w-0`. Long unbroken text
   (repository names, model ids) gets `wrap-anywhere`, or `<wbr />` at a natural break.
2. Grids start at one column: `grid-cols-1 sm:grid-cols-2`. A grid with no column template
   sizes to its content and pushes the page wider than a phone.
3. Controls under 44px get `hit relative`.
4. Nothing only on hover. What a hover shows, a tap must show too: handle pointer events and
   check `pointerType`, not mouse events only. Act on a tap's `pointerup`, not `pointerdown`: a
   touch that turns into a scroll ends in `pointercancel` instead (the chart inspects this way).
5. Text at least 11px on a phone (`compact:text-[11px]` for smaller labels). Fields stay at
   16px on touch (`mobile.css`), or iOS zooms into them.
6. Effects run on phones. Anything that assumes a mouse (holding a hover look) checks
   `canHover()`. On touch, back and forward are left to the browser's own swipe.

## Checking Phones

Run the phone checks when a change could alter what a phone shows or how it is used:

- markup or classes in `pages/`, `components/`, `PublicLayout.tsx`, `frame.ts`, `theme.css`,
  or `mobile/`;
- new content: a field, a state, a route, a page;
- pointer, hover, touch, or scroll handling;
- `effects/`: record the transitions as well (below).

Skip them for changes a phone cannot see: data plumbing (`source.ts`, `api-source.ts`), tests,
comments, colors only, and wording of about the same length. CI runs them on every pull request
that touches the site, so a skipped run is still caught before merge.

`bun run test:phone` starts a dev server of its own over made-up repositories
(`mobile/checks/synthetic.ts`), on a port picked per worktree, and runs the checks on Chrome as
four phones: iPhone SE (320px, the narrowest), iPhone 15 in dark mode, Pixel 7, and iPhone 15
held sideways. It runs the iPhones on WebKit as well once WebKit is installed. About 30 seconds
on Chrome alone, 45 with WebKit.

- WebKit, the engine of every iPhone browser, is a one-time install:
  `bunx playwright install webkit` (about 270MB, in `~/Library/Caches/ms-playwright`). Without
  it the checks run on Chrome only, as in CI. Google Chrome must be installed.
- Narrow a run: `bun run test:phone --project "WebKit*"`, or `-g "solo/tiny"` for one route.
- A failure names the rule, the elements that break it, and the usual fix.
- The checks measure; they do not judge looks. For a visual change, look at the pictures:
  every route a screen at a time, in `.selfbench/phone/results/pages/<phone>/<route>.png`.
  The full report: `bunx playwright show-report .selfbench/phone/report`.
- `VITE_PUBLIC_DATA=synthetic bun run dev:public` shows the same repositories in a browser.

What is checked (`mobile/checks/`):

- `layout.phone.ts`, on every route in `synthetic.ts`: no sideways scrolling, tap targets of
  44px (counting `hit` and labels), text of 11px, fields of 16px on touch, no `:hover` style
  outside `@media (hover: hover)`, and no errors in the page or its console.
- `touch.phone.ts`: pinned bars cover at most a fifth of the screen; a tapped card opens
  without taking on its hover look; back plays no transition of its own; a tap on a chart point
  shows its details and a tap away hides them.

### Transitions

After changing `effects/`, run `bun run record:transitions`. It records the open (home to a
repository) and return transitions on each phone, and saves each as a timeline of frames in
`.selfbench/phone/results/transitions/<phone>/<open|return>.png`. It passes or fails nothing:
look at the timelines, WebKit's especially. The page should build up and come apart steadily,
with no frame where it blanks or pops in at once. WebKit is sampled with screenshots, so it can
miss a very short flash. Real iPhones composite canvases, WebGL, and masks on the GPU, which
WebKit here does not, so for effects also look on a real iPhone:
`bun run dev:public --host`, opened from the phone on the same Wi-Fi.

## Keeping the Checks Current

- New kinds of content go into `synthetic.ts` (a repository, a setting, a route), so the checks
  see them. It is built with the unit tests' builders (`test-fixture.ts`), so contract changes
  surface there as type errors.
- A deliberate exception is marked on the element, with a comment saying why:
  `data-phone-ok="tap"` (or `overflow`, `text`, `field`, `hover`). Keep these rare.
- When a design changes on purpose and a check's selector or expectation no longer fits, update
  the check and keep its intent.
- When the mobile layer or the checks change, update this file.
