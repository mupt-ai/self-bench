export const sheetBody =
  "flex min-w-0 flex-col gap-5 overflow-auto px-8 pt-5 pb-18 site:px-4 site:md:px-8";
export const notice =
  "px-4 py-3 text-(--muted-fg) site:px-4 site:py-5 site:font-mono site:text-sm site:leading-6 site:md:px-8";
export const loading =
  "px-8 py-6 text-(--muted-fg) after:content-['_…'] site:px-4 site:py-5 site:font-mono site:text-sm site:leading-6 site:text-dim site:after:content-none site:md:px-8";
export const prose =
  "max-w-[96ch] px-4 py-3.5 font-mono text-[13px] leading-[1.6] whitespace-pre-wrap wrap-anywhere text-(--fg-2) site:text-base site:text-ink [&:is(pre)]:max-w-none";
export const viewerButton =
  "h-8 cursor-pointer whitespace-nowrap border border-(--border) bg-(--background) px-3 text-xs text-(--muted-fg) transition-[color,background] duration-150 hover:bg-(--accent) hover:text-(--foreground) disabled:cursor-not-allowed disabled:opacity-50 site:border-line-strong site:bg-transparent site:font-mono site:text-sm site:font-medium site:text-ink site:hover:border-mint site:hover:text-mint-bright";
export const viewerLink =
  "cursor-pointer border-b border-(--border) text-left text-xs leading-[1.3] text-(--fg-2) hover:border-(--brand) hover:text-(--brand) site:border-0 site:font-mono site:text-sm site:text-ink site:hover:text-mint-bright site:hover:underline site:hover:decoration-mint site:hover:underline-offset-3";
export const viewerField =
  "h-9 min-w-[140px] border border-(--border) bg-(--background) px-2.5 text-[13px] text-(--foreground) placeholder:text-(--muted-fg) focus:border-(--brand) focus:shadow-[0_0_0_1px_var(--brand)] focus:outline-none";
export const sheetTable =
  "w-full border-collapse [&_th]:w-[150px] [&_th]:whitespace-nowrap [&_th]:pt-2.5 [&_th]:text-[11px] [&_th]:font-normal [&_th]:tracking-[0.16em] [&_th]:text-(--muted-fg) [&_th]:uppercase [&_td]:text-(--fg-2) [&_td]:text-[13px] [&_th,&_td]:border-t [&_th,&_td]:border-(--border) [&_th,&_td]:px-4 [&_th,&_td]:py-2 [&_th,&_td]:text-left [&_th,&_td]:align-top [&_tr:first-child>th,&_tr:first-child>td]:border-t-0 [&_thead+tbody>tr:first-child>td]:border-t site:[&_th]:pt-[11px] site:[&_th]:font-mono site:[&_th]:text-sm site:[&_th]:font-medium site:[&_th]:tracking-[0.14em] site:[&_th]:text-dim site:[&_th]:leading-[normal] site:[&_td]:font-sans site:[&_td]:text-sm site:[&_td]:text-ink";
export const tableColumn = "!w-auto bg-(--viewer-panel) !pt-2 site:bg-surface-2 site:!pt-[9px]";
export const tableCode = "!font-mono leading-[1.6] whitespace-pre-wrap wrap-anywhere";
export const tableMono =
  "!font-mono !text-[13px] !tracking-normal !text-(--fg-2) !normal-case site:!text-sm site:!text-muted";
export const panel =
  "grid min-h-0 min-w-0 grid-rows-[44px_minmax(0,1fr)] border-r border-(--border) bg-(--background)";
export const rail =
  "flex min-h-0 min-w-0 flex-col items-center gap-3 border-r border-(--border) bg-(--background) py-2.5";
export const railToggle =
  "grid size-6 shrink-0 cursor-pointer place-items-center border border-transparent text-[11px] text-(--muted-fg) hover:border-(--border) hover:bg-(--accent) hover:text-(--foreground)";
export const railLabel =
  "whitespace-nowrap text-[11px] tracking-[0.16em] text-(--muted-fg) uppercase [writing-mode:vertical-rl]";
export const panelHead =
  "flex items-center justify-between gap-2 border-b border-(--border) pr-3 pl-5";
export const panelTitle =
  "truncate text-[11px] tracking-[0.16em] text-(--muted-fg) uppercase [&_b]:ml-2 [&_b]:font-medium [&_b]:tracking-normal [&_b]:text-(--foreground)";
export const tabList =
  "mt-6 mx-8 flex gap-6 border-b border-(--border) site:m-0 site:h-11 site:shrink-0 site:items-stretch site:bg-surface site:px-8";
export const tab =
  "-mb-px cursor-pointer border-b-2 border-transparent px-0.5 pb-2.5 text-[13px] text-(--muted-fg) transition-[color] duration-150 hover:text-(--foreground) aria-selected:border-(--brand) aria-selected:text-(--foreground) aria-pressed:border-(--brand) aria-pressed:text-(--foreground) disabled:cursor-default disabled:text-(--faint) site:inline-flex site:items-center site:pb-0 site:focus-visible:outline-offset-[-4px]! site:font-mono site:text-sm site:font-medium site:leading-[normal] site:aria-selected:border-mint site:aria-selected:text-mint";
