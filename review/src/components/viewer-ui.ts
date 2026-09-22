import { cn } from "../web/primitives/cn";
import { buttonStyles } from "../web/ui";

export const sheetBody =
  "flex min-w-0 flex-col gap-5 overflow-auto p-4 pb-12 sm:p-6 site:px-4! site:pt-3!";
export const notice = "px-4 py-3 text-sm leading-6 text-muted-foreground";
export const prose =
  "max-w-[96ch] px-4 py-3 text-sm leading-6 whitespace-pre-wrap wrap-anywhere text-foreground [&:is(pre)]:max-w-none";
export const viewerButton = buttonStyles.secondary;
export const viewerIconButton = cn(viewerButton, "size-9 p-0");
export const viewerLink =
  "cursor-pointer text-left text-sm font-medium text-foreground underline decoration-foreground/25 underline-offset-4 hover:decoration-foreground";
export const sheetTable =
  "w-full border-collapse text-sm [&_th]:w-40 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground [&_td]:text-foreground [&_th,&_td]:border-t [&_th,&_td]:border-border [&_th,&_td]:px-4 [&_th,&_td]:py-3 [&_th,&_td]:text-left [&_th,&_td]:align-top [&_tr:first-child>th,&_tr:first-child>td]:border-t-0 [&_thead+tbody>tr:first-child>td]:border-t";
export const tableColumn = "!w-auto bg-muted";
export const tableCode = "font-mono leading-6 whitespace-pre-wrap wrap-anywhere";
export const tableMono = "font-mono !text-sm !font-normal !text-muted-foreground";
export const tabList =
  "flex h-11 shrink-0 items-stretch gap-6 overflow-x-auto border-b border-border bg-background px-4 sm:px-6 site:px-4!";
export const tab =
  "-mb-px inline-flex shrink-0 cursor-pointer items-center border-b-2 border-transparent px-0.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground aria-selected:border-foreground aria-selected:text-foreground aria-pressed:border-foreground aria-pressed:text-foreground disabled:cursor-default disabled:text-muted-foreground focus-visible:outline-offset-[-4px]!";
