import { DEFAULT_GROUP_LOGO, GROUP_LOGO, isGroupLogo } from "../../../../src/public/release-groups";
import { InfoTooltip } from "../primitives/tooltip";
import { Button } from "../ui";

const REFUSED = "Choose a PNG, JPEG, WebP, or SVG image under 48 KB.";

/**
 * A group's logo in its dialog: the current one (or the default mark), a file picker, and a way
 * back to the default. The chosen image is read as a data URL, which the group stores and its
 * release publishes; `onError` says why a file was refused.
 */
export function GroupLogoField({
  logo,
  disabled,
  onChange,
  onError,
}: {
  /** The chosen image as a data URL; null for the default mark. */
  logo: string | null;
  disabled: boolean;
  onChange(logo: string | null): void;
  onError(message: string): void;
}) {
  const choose = (file: File | undefined) => {
    if (!file) return;
    if (
      !(GROUP_LOGO.types as readonly string[]).includes(file.type) ||
      file.size > GROUP_LOGO.maxBytes
    ) {
      onError(REFUSED);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      if (isGroupLogo(value)) onChange(value);
      else onError(REFUSED);
    };
    reader.readAsDataURL(file);
  };
  return (
    <div className="grid gap-2">
      <span className="flex items-center gap-1.5 text-sm font-semibold">
        Logo
        <InfoTooltip label="Shown on the group's card and page on selfbench.dev. Use a square PNG, JPEG, WebP, or SVG under 48 KB." />
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <img
          src={logo ?? DEFAULT_GROUP_LOGO}
          alt=""
          className="size-12 shrink-0 rounded-sm border border-border object-contain p-1"
        />
        <input
          type="file"
          aria-label="Logo"
          accept={GROUP_LOGO.types.join(",")}
          disabled={disabled}
          className="min-w-0 text-sm"
          onChange={(event) => {
            choose(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {logo && (
          <Button size="small" disabled={disabled} onClick={() => onChange(null)}>
            Use Default Logo
          </Button>
        )}
      </div>
    </div>
  );
}
