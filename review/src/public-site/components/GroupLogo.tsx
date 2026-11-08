import { DEFAULT_GROUP_LOGO } from "../../../../src/public/release-groups";

/** A group's logo, or the default mark, drawn where a repository card draws its owner's avatar. */
export function GroupLogo({
  logo,
  size,
  className = "",
}: {
  logo: string | null | undefined;
  size: number;
  className?: string;
}) {
  return (
    <img
      src={logo ?? DEFAULT_GROUP_LOGO}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={`shrink-0 rounded-sm object-contain ${className}`}
    />
  );
}
