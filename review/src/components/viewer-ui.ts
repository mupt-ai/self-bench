export const sheetBody = "flex min-w-0 flex-col gap-5 overflow-auto px-4 pt-3 pb-12 sm:pb-6";
export const notice = "px-4 py-3 text-sm leading-6 text-muted-foreground";
export const prose =
  "max-w-[96ch] px-4 py-3 text-sm leading-6 whitespace-pre-wrap wrap-anywhere text-foreground [&:is(pre)]:max-w-none";
/** Its own classes, not the app's button: selfbench.dev shows it too, and keeps its look there
 * (its theme makes `rounded-md` square) while the app restyles its buttons. */
export const viewerIconButton =
  "inline-flex size-9 shrink-0 items-center justify-center whitespace-nowrap rounded-md border border-foreground/20 bg-card p-0 text-foreground transition-colors hover:border-foreground/35 hover:bg-accent disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0";
export const viewerLink =
  "cursor-pointer text-left text-sm font-medium text-foreground underline decoration-foreground/25 underline-offset-4 hover:decoration-foreground";
export const sheetTable =
  "w-full border-collapse text-sm [&_th]:w-40 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground [&_td]:text-foreground [&_th,&_td]:border-t [&_th,&_td]:border-border [&_th,&_td]:px-4 [&_th,&_td]:py-3 [&_th,&_td]:text-left [&_th,&_td]:align-top [&_tr:first-child>th,&_tr:first-child>td]:border-t-0 [&_thead+tbody>tr:first-child>td]:border-t";
export const tableColumn = "!w-auto bg-muted";
export const tableCode = "font-mono leading-6 whitespace-pre-wrap wrap-anywhere";
export const tableMono = "font-mono !text-sm !font-normal !text-muted-foreground";
export const tabList =
  "flex h-11 shrink-0 items-stretch gap-6 overflow-x-auto border-b border-border bg-background px-4";
export const tab =
  "-mb-px inline-flex shrink-0 cursor-pointer items-center border-b-2 border-transparent px-0.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground aria-selected:border-foreground aria-selected:text-foreground aria-pressed:border-foreground aria-pressed:text-foreground disabled:cursor-default disabled:text-muted-foreground focus-visible:outline-offset-[-4px]!";
