import { Check, Settings } from "lucide-react";
import { useRef, useState } from "react";
import { PANEL } from "./frame";
import { applyMotionOff, readMotionOff, rememberMotionOff } from "./motion";
import { sharedPreferences } from "./preferences";
import { useDismiss } from "./use-dismiss";

/** Shared with app.selfbench.dev, so the choice carries across (see preferences.ts). */
const storage = () => sharedPreferences();

/** The gear beside the theme toggle. Its one item turns the site's animations off and on. */
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState(() => readMotionOff(storage()));
  const menu = useRef<HTMLDivElement>(null);

  useDismiss(open, menu, () => setOpen(false));

  const toggle = () => {
    const next = !off;
    applyMotionOff(document.documentElement, next);
    rememberMotionOff(storage(), next);
    setOff(next);
  };

  return (
    <div ref={menu} className="relative">
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:bg-foreground/[0.06]"
      >
        <Settings
          className="size-4 transition-transform duration-500 group-hover:rotate-90"
          aria-hidden="true"
        />
      </button>
      {open && (
        <div role="menu" className={`absolute top-full right-0 z-50 mt-2.5 w-56 ${PANEL}`}>
          {/* A speech-bubble tail pointing up at the gear: centred 16px in, under the 32px button. */}
          <span
            aria-hidden="true"
            className="absolute -top-[6.5px] right-[11px] size-2.5 rotate-45 border-t-[1.5px] border-l-[1.5px] border-(--panel-border) bg-card"
          />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={off}
            onClick={toggle}
            className="relative flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted"
          >
            Disable Animations
            <span
              className={`inline-flex size-4 items-center justify-center border border-foreground/40 ${off ? "bg-foreground text-background" : ""}`}
            >
              {off && <Check className="size-3" aria-hidden="true" />}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
