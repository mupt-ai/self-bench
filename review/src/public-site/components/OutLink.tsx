import { ArrowUpRight } from "lucide-react";

/** A footer link that leaves the site: opens in a new tab, marked with an arrow. */
export function OutLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="hit relative inline-flex items-center gap-0.5 hover:text-foreground"
    >
      {children}
      <ArrowUpRight className="size-3" aria-hidden="true" />
    </a>
  );
}
