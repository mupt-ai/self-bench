import { Search, X } from "lucide-react";
import { useRef, useState } from "react";
import { usePitchforks } from "../effects/easter-eggs/PitchforkMob";
import { summonsMob } from "../effects/easter-eggs/pitchforks";

/**
 * The repository search. Typing stays centred. The icon and label fade out together as soon as
 * the box is clicked into, and fade back in, in place, once it is left empty. Typing
 * "/pitchforks" sends a small mob marching along the top of the bar.
 */
export function SearchBox({
  query,
  onChange,
}: {
  query: string;
  onChange: (query: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const { lane, summon } = usePitchforks();
  // The /pitchforks easter egg; see summonsMob for when it fires.
  const previous = useRef(query);
  const change = (value: string) => {
    if (summonsMob(previous.current, value)) summon();
    previous.current = value;
    onChange(value);
  };
  return (
    <label className="relative mt-2 flex h-11 w-full max-w-[25rem] items-center border-[1.5px] border-foreground/35 bg-card shadow-[inset_0_1px_2px_rgb(0_0_0/0.06)] transition-colors focus-within:border-foreground/70">
      <input
        type="search"
        value={query}
        onChange={(event) => change(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label="Search Repositories"
        className="h-full w-full bg-transparent px-9 text-center font-mono text-sm outline-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 flex items-center justify-center gap-2 font-mono text-sm text-foreground/60 transition-opacity duration-200 ${
          focused || query ? "opacity-0" : "opacity-100"
        }`}
      >
        <Search className="size-4 text-foreground/70" />
        Search Repositories
      </span>
      <button
        type="button"
        aria-label="Clear Search"
        title="Clear Search"
        // Keep focus in the box, so the caret stays for the next search.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => change("")}
        className={`absolute right-2 inline-flex size-7 items-center justify-center text-muted-foreground transition-[opacity,rotate,scale] duration-200 hover:text-foreground ${
          query
            ? "scale-100 rotate-0 opacity-100"
            : "pointer-events-none scale-50 -rotate-90 opacity-0"
        }`}
      >
        <X className="size-4" />
      </button>
      {lane}
    </label>
  );
}
